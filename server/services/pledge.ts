import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { MIN_SPEND_CENTS } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { claimRewardTx, votePollTx, contributeGoalTx, proposeCustomEntryTx } from './spend.js';
import { checkBlockedWords } from './blockedWords.js';
import { isStripeConfigured } from './stripe.js';
import { sendMagicLink } from './email.js';
import { PLEDGE_TTL_MS, TOKEN_TTL_MS } from '../config.js';

const STRIPE_MIN_CHARGE_CENTS = 50;

interface PledgeItemInput {
  kind: string;
  target_id: string;
  amount_cents?: number;
  poll_id?: string | null;
  data?: unknown;
}

interface CreatePledgeInput {
  email?: string | null;
  comment?: string | null;
  items: PledgeItemInput[];
  top_up_cents?: number;
  channel_id?: string | null;
}

const COMMENT_MAX_LENGTH = 500;

/**
 * Create a pending pledge from cart items.
 * Validates each item against live state, computes total, persists.
 * Returns { pledge_token, total_cents, donate_url }.
 *
 * Every pledge is routed to exactly one channel: `channel_id` is required and
 * must reference an active Channel. Each cart item's underlying incentive
 * must either be shared (its own `channel_id` is null) or belong to the same
 * channel as the pledge — incentives cannot be mixed across channels in a
 * single transaction. This is what lets the amount be routed to the correct
 * channel overlay.
 */
export async function createPledge({
  email,
  comment,
  items,
  top_up_cents,
  channel_id,
}: CreatePledgeInput) {
  if (!items || !Array.isArray(items)) {
    throw Object.assign(new Error('At least one item required'), { status: 400 });
  }

  const topUp = top_up_cents ?? 0;
  if (!Number.isInteger(topUp) || topUp < 0) {
    throw Object.assign(new Error('top_up_cents must be a non-negative integer'), { status: 400 });
  }

  if (items.length === 0 && topUp === 0) {
    throw Object.assign(new Error('At least one item or an additional donation is required'), {
      status: 400,
    });
  }

  if (!channel_id || typeof channel_id !== 'string') {
    throw Object.assign(new Error('channel_id is required'), { status: 400 });
  }
  const channel = await prisma.channel.findUnique({ where: { id: channel_id } });
  if (!channel || !channel.is_active) {
    throw Object.assign(new Error('Channel not found or inactive'), { status: 404 });
  }

  let commentValue: string | null = null;
  if (comment != null && comment.trim().length > 0) {
    commentValue = comment.trim();
    if (commentValue.length > COMMENT_MAX_LENGTH) {
      throw Object.assign(
        new Error(`Comment exceeds maximum of ${COMMENT_MAX_LENGTH} characters`),
        { status: 400 },
      );
    }
    const blockedError = await checkBlockedWords(commentValue);
    if (blockedError) {
      throw Object.assign(new Error(blockedError), { status: 400 });
    }
  }

  // Validate all items against live data
  let totalCents = 0;
  let requiresShipping = false;

  // An incentive with a null channel_id is "shared" and may be added to any
  // channel's cart. An incentive tied to a specific channel may only be added
  // when it matches the pledge's channel — incentives cannot be mixed across
  // channels in a single transaction.
  const assertChannelMatch = (incentiveChannelId: string | null, label: string) => {
    if (incentiveChannelId && incentiveChannelId !== channel_id) {
      throw Object.assign(
        new Error(`${label} belongs to a different channel and cannot be added to this cart`),
        { status: 400 },
      );
    }
  };

  for (const item of items) {
    const { kind, target_id, amount_cents, poll_id } = item;

    if (!['REWARD', 'POLL_VOTE', 'GOAL', 'POLL_CUSTOM'].includes(kind)) {
      throw Object.assign(new Error(`Invalid item kind: ${kind}`), { status: 400 });
    }

    if (kind === 'REWARD') {
      const reward = await prisma.reward.findUnique({ where: { id: target_id } });
      if (!reward || !reward.is_active) {
        throw Object.assign(new Error(`Reward not found: ${target_id}`), { status: 404 });
      }
      assertChannelMatch(reward.channel_id, `Reward "${reward.title}"`);
      if (reward.quantity_total !== null && reward.quantity_claimed >= reward.quantity_total) {
        throw Object.assign(new Error(`Reward sold out: ${reward.title}`), { status: 400 });
      }
      if (reward.type === 'PHYSICAL') {
        requiresShipping = true;
      }
      totalCents += reward.cost_cents;
    } else if (kind === 'POLL_VOTE') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(new Error(`POLL_VOTE amount_cents (min ${MIN_SPEND_CENTS}) required`), {
          status: 400,
        });
      }
      if (!poll_id) {
        throw Object.assign(new Error('POLL_VOTE requires poll_id'), { status: 400 });
      }
      const poll = await prisma.poll.findUnique({ where: { id: poll_id } });
      if (!poll || !poll.is_active) {
        throw Object.assign(new Error(`Poll not found or inactive: ${poll_id}`), { status: 404 });
      }
      assertChannelMatch(poll.channel_id, `Poll "${poll.title}"`);
      if (poll.ends_at && new Date() > poll.ends_at) {
        throw Object.assign(new Error(`Poll has ended: ${poll.title}`), { status: 400 });
      }
      const option = await prisma.pollOption.findUnique({ where: { id: target_id } });
      if (!option || option.poll_id !== poll_id) {
        throw Object.assign(new Error(`Option not found: ${target_id}`), { status: 404 });
      }
      totalCents += amount_cents!;
    } else if (kind === 'GOAL') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(new Error(`GOAL amount_cents (min ${MIN_SPEND_CENTS}) required`), {
          status: 400,
        });
      }
      const goal = await prisma.fundGoal.findUnique({ where: { id: target_id } });
      if (!goal || !goal.is_active || goal.is_complete) {
        throw Object.assign(new Error(`Goal not found, inactive, or complete: ${target_id}`), {
          status: 404,
        });
      }
      assertChannelMatch(goal.channel_id, `Goal "${goal.title}"`);
      totalCents += amount_cents!;
    } else if (kind === 'POLL_CUSTOM') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(
          new Error(`POLL_CUSTOM amount_cents (min ${MIN_SPEND_CENTS}) required`),
          {
            status: 400,
          },
        );
      }
      if (!poll_id) {
        throw Object.assign(new Error('POLL_CUSTOM requires poll_id'), { status: 400 });
      }
      const label =
        typeof item.data === 'object' && item.data
          ? (item.data as { label?: unknown }).label
          : null;
      const trimmed = typeof label === 'string' ? label.trim() : '';
      if (!trimmed) {
        throw Object.assign(new Error('POLL_CUSTOM requires a label'), { status: 400 });
      }
      const poll = await prisma.poll.findUnique({ where: { id: poll_id } });
      if (!poll || !poll.is_active) {
        throw Object.assign(new Error(`Poll not found or inactive: ${poll_id}`), { status: 404 });
      }
      assertChannelMatch(poll.channel_id, `Poll "${poll.title}"`);
      if (!poll.allow_custom_entries) {
        throw Object.assign(new Error(`Poll does not allow custom entries: ${poll.title}`), {
          status: 400,
        });
      }
      if (poll.ends_at && new Date() > poll.ends_at) {
        throw Object.assign(new Error(`Poll has ended: ${poll.title}`), { status: 400 });
      }
      if (poll.max_entry_chars && trimmed.length > poll.max_entry_chars) {
        throw Object.assign(
          new Error(`Entry exceeds maximum of ${poll.max_entry_chars} characters`),
          { status: 400 },
        );
      }
      const blockedError = await checkBlockedWords(trimmed);
      if (blockedError) {
        throw Object.assign(new Error(blockedError), { status: 400 });
      }
      totalCents += amount_cents!;
    }
  }

  const pledgeToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + PLEDGE_TTL_MS);

  const pledge = await prisma.pendingPledge.create({
    data: {
      pledge_token: pledgeToken,
      donor_email: email || null,
      comment: commentValue,
      total_cents: totalCents + topUp,
      top_up_cents: topUp,
      requires_shipping: requiresShipping,
      status: 'OPEN',
      expires_at: expiresAt,
      channel_id,
      items: {
        create: items.map((item) => ({
          kind: item.kind,
          target_id: item.target_id,
          poll_id: item.poll_id || null,
          amount_cents: item.amount_cents || 0,
          data: item.data ? JSON.stringify(item.data) : null,
        })),
      },
    },
    include: { items: true },
  });

  return {
    pledge_token: pledge.pledge_token,
    total_cents: pledge.total_cents,
    expires_at: pledge.expires_at,
  };
}

/**
 * Fulfill a pledge inside an existing donation transaction.
 * Called from processDonation after the donor is upserted and balance credited.
 * Skips items that are no longer valid (sold out, ended, etc.) — those cents
 * remain as spendable balance_remaining.
 */
export async function fulfillPledge(
  tx: Prisma.TransactionClient,
  pledge: Prisma.PendingPledgeGetPayload<{ include: { items: true } }>,
  donorId: string,
) {
  const results: Array<Record<string, unknown>> = [];
  let totalSpent = 0;
  let skipped = 0;

  for (const item of pledge.items) {
    try {
      let result: { cost: number } | undefined;
      if (item.kind === 'REWARD') {
        const data = item.data ? JSON.parse(item.data) : {};
        result = await claimRewardTx(tx, donorId, item.target_id, data);
      } else if (item.kind === 'POLL_VOTE') {
        result = await votePollTx(tx, donorId, item.poll_id!, item.target_id, item.amount_cents);
      } else if (item.kind === 'GOAL') {
        result = await contributeGoalTx(tx, donorId, item.target_id, item.amount_cents);
      } else if (item.kind === 'POLL_CUSTOM') {
        const data = item.data ? JSON.parse(item.data) : {};
        result = await proposeCustomEntryTx(
          tx,
          donorId,
          item.poll_id!,
          data.label,
          item.amount_cents,
        );
      }
      totalSpent += result!.cost;
      results.push({ item_id: item.id, kind: item.kind, status: 'fulfilled', cost: result!.cost });
    } catch (err) {
      skipped++;
      results.push({
        item_id: item.id,
        kind: item.kind,
        status: 'skipped',
        reason: (err as Error).message,
      });
    }
  }

  await tx.pendingPledge.update({
    where: { id: pledge.id },
    data: { status: 'FULFILLED' },
  });

  return { totalSpent, skipped, results };
}

/**
 * Resolve a pledge token to a pending pledge, or fall back to email-based lookup.
 * Returns the pledge or null.
 */
export async function resolvePledge({
  pledgeToken,
  email,
  amountCents,
}: {
  pledgeToken?: string | null;
  email?: string | null;
  amountCents: number;
}) {
  if (pledgeToken) {
    const pledge = await prisma.pendingPledge.findUnique({
      where: { pledge_token: pledgeToken },
      include: { items: true },
    });
    if (
      pledge &&
      pledge.status === 'OPEN' &&
      pledge.total_cents <= amountCents + (pledge.wallet_discount_cents ?? 0) &&
      new Date() < pledge.expires_at
    ) {
      return pledge;
    }
  }

  // Fallback: email-based lookup for newest OPEN pledge within window
  if (email) {
    const cutoff = new Date(Date.now() - PLEDGE_TTL_MS);
    const pledge = await prisma.pendingPledge.findFirst({
      where: {
        donor_email: email.trim().toLowerCase(),
        status: 'OPEN',
        total_cents: { lte: amountCents },
        expires_at: { gt: new Date() },
        created_at: { gte: cutoff },
      },
      orderBy: { created_at: 'desc' },
      include: { items: true },
    });
    if (pledge) return pledge;
  }

  return null;
}

export interface WalletDonor {
  id: string;
  email: string;
  balance_remaining: number;
  magic_token: string | null;
}

/**
 * Create a Stripe Checkout Session for a pledge and return the checkout URL.
 * Requires STRIPE_SECRET_KEY. Falls back to a null URL if Stripe is not configured.
 *
 * When an authenticated donor is provided (resolved from a valid magic token),
 * their wallet balance is applied as a discount to the Stripe charge,
 * recorded as wallet_discount_cents on the pledge. The discount only ever
 * offsets the incentive items — the additional contribution (top_up_cents) is
 * always charged as real money. If the wallet balance covers the entire
 * pledge (possible only when there is no additional contribution), the pledge
 * is fulfilled directly without Stripe —
 * unless the pledge requires shipping (contains a PHYSICAL reward), in which
 * case Stripe Checkout is always used to collect a shipping address and charge
 * shipping.
 *
 * @param pledgeToken The pledge token to create a checkout for
 * @param donor       Authenticated donor (from magic token validation). If
 *                     not provided, wallet discount is skipped.
 * @param email       Unauthenticated email for Stripe customer_email pre-fill.
 *                     Not used for wallet discount.
 */
export async function createCheckoutForPledge(
  pledgeToken: string,
  donor?: WalletDonor | null,
  email?: string | null,
) {
  const pledge = await prisma.pendingPledge.findUnique({
    where: { pledge_token: pledgeToken },
    select: {
      id: true,
      total_cents: true,
      top_up_cents: true,
      donor_email: true,
      comment: true,
      requires_shipping: true,
    },
  });
  if (!pledge) {
    throw Object.assign(new Error('Pledge not found'), { status: 404 });
  }

  const stripeEmail = (email || pledge.donor_email || '').trim().toLowerCase();

  let walletDiscountCents = 0;
  if (donor && donor.balance_remaining > 0) {
    // The additional contribution (top_up_cents) always comes from real
    // money: the donor's wallet balance only offsets the incentive items,
    // never the additional contribution itself.
    const walletCoverableCents = pledge.total_cents - pledge.top_up_cents;
    walletDiscountCents = Math.min(donor.balance_remaining, walletCoverableCents);

    const projectedCharge = pledge.total_cents - walletDiscountCents;
    if (projectedCharge > 0 && projectedCharge < STRIPE_MIN_CHARGE_CENTS) {
      walletDiscountCents = Math.max(0, pledge.total_cents - STRIPE_MIN_CHARGE_CENTS);
      walletDiscountCents = Math.min(walletDiscountCents, walletCoverableCents);
    }

    // Wallet covers everything — fulfill directly, no Stripe charge. Physical
    // pledges always skip this branch so a shipping address is collected (and
    // shipping charged) via Stripe Checkout. In that case, keep the line item
    // at Stripe's minimum charge so the session is valid (shipping is added on
    // top by Stripe).
    if (walletDiscountCents >= pledge.total_cents) {
      if (pledge.requires_shipping) {
        walletDiscountCents = Math.max(0, pledge.total_cents - STRIPE_MIN_CHARGE_CENTS);
      } else {
        const fullPledge = await prisma.pendingPledge.findUniqueOrThrow({
          where: { pledge_token: pledgeToken },
          include: { items: true },
        });

        await prisma.$transaction(async (tx) => {
          await fulfillPledge(tx, fullPledge, donor.id);
          await tx.pendingPledge.update({
            where: { pledge_token: pledgeToken },
            data: {
              wallet_discount_cents: pledge.total_cents,
              status: 'FULFILLED',
            },
          });
        });

        sendMagicLink(donor.email, donor.magic_token!).catch((err) =>
          console.error('Email error:', err),
        );

        const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
        return {
          donate_url: `${baseUrl}/wallet?token=${donor.magic_token}`,
          checkout_session_id: null,
          wallet_discount_cents: pledge.total_cents,
        };
      }
    }
  }

  // Store the discount on the pledge so resolvePledge can account for it later
  if (walletDiscountCents > 0) {
    await prisma.pendingPledge.update({
      where: { pledge_token: pledgeToken },
      data: { wallet_discount_cents: walletDiscountCents },
    });
  }

  if (!isStripeConfigured()) {
    if (pledge.requires_shipping) {
      throw Object.assign(
        new Error('Physical rewards require Stripe checkout to collect a shipping address'),
        { status: 503 },
      );
    }
    return {
      donate_url: null,
      checkout_session_id: null,
      wallet_discount_cents: walletDiscountCents,
    };
  }

  const checkoutAmount = pledge.total_cents - walletDiscountCents;
  const { createCheckoutSession } = await import('./stripe.js');
  const session = await createCheckoutSession({
    pledgeToken,
    amountCents: checkoutAmount,
    email: stripeEmail,
    requiresShipping: pledge.requires_shipping,
  });

  await prisma.pendingPledge.update({
    where: { pledge_token: pledgeToken },
    data: {
      checkout_session_id: session.id,
      checkout_url: session.url,
    },
  });

  return {
    donate_url: session.url,
    checkout_session_id: session.id,
    wallet_discount_cents: walletDiscountCents,
  };
}
