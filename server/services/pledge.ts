import crypto from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import {
  MIN_SPEND_CENTS,
  planPledge,
  type PledgePlan,
  type PledgeItemKind,
  type PledgeSelection,
} from '@dono/shared';
import prisma from '../lib/prisma.js';
import { withSpan } from '../lib/tracing.js';
import { httpError } from '../lib/httpError.js';
import { isStripeConfigured, createCheckoutSession, pledgeCheckoutRequest } from './stripe.js';
import type Stripe from 'stripe';
import { intakeDonation } from './donation.js';
import { PLEDGE_TTL_MS } from '../config.js';

export interface PledgeItemInput {
  kind: PledgeItemKind;
  target_id: string;
  amount_cents?: number;
  poll_id?: string | null;
  data?: unknown;
  quantity?: number;
  /** Array position is the default; clients may keep order after removing a row. */
  insertion_order?: number;
}

export interface CreatePledgeInput {
  email?: string | null;
  comment?: string | null;
  display_name?: string | null;
  items: PledgeItemInput[];
  pledge_amount_cents: number;
  draft_id: string;
  plan: PledgePlan;
  channel_id: string;
  /** Trusted session identity, resolved BEFORE planning. Never looked up by email. */
  walletDonorId?: string | null;
  /** Rejected even when an amount is supplied, to fail closed for old clients. */
  top_up_cents?: unknown;
}

type StoredPledge = Prisma.PendingPledgeGetPayload<{ include: { items: true } }>;

function pledgePaymentState(pledge: StoredPledge) {
  if (
    pledge.status === 'FULFILLED' ||
    pledge.status === 'LEGACY_PAID' ||
    pledge.status === 'PAYMENT_REVIEW'
  )
    return pledge.status;
  if (pledge.non_payment_confirmed_at && pledge.wallet_hold_status !== 'HELD') return 'NON_PAYMENT';
  if (pledge.checkout_session_status === 'complete') return 'PROCESSING';
  if (pledge.checkout_session_status === 'open') return 'OPEN';
  if (
    pledge.checkout_requested_at ||
    pledge.checkout_session_id ||
    pledge.checkout_session_status === 'unknown' ||
    (pledge.wallet_hold_status === 'HELD' && pledge.status !== 'OPEN')
  )
    return 'UNKNOWN';
  return 'READY';
}

/** Public read shape: old amounts exist ONLY on the LEGACY variant. No session secrets. */
export function pledgeResponse(pledge: StoredPledge) {
  const paymentState = pledgePaymentState(pledge);
  const canContinue =
    pledge.format === 'POOLED' &&
    pledge.status === 'OPEN' &&
    paymentState === 'OPEN' &&
    pledge.expires_at > new Date();
  const common = {
    comment: pledge.comment,
    display_name: pledge.display_name,
    channel_id: pledge.channel_id,
    payment_state: paymentState,
    can_edit: pledge.format === 'POOLED' && paymentState === 'NON_PAYMENT',
    can_continue: canContinue,
    read_only: !(pledge.format === 'POOLED' && paymentState === 'NON_PAYMENT'),
    admin_review_required: paymentState === 'PAYMENT_REVIEW',
    donate_url: canContinue ? pledge.checkout_url : null,
    has_checkout: !!pledge.checkout_session_id,
    pledge_token: pledge.pledge_token,
    status: pledge.status,
    expires_at: pledge.expires_at,
    items: pledge.items.map((item) => ({
      kind: item.kind,
      target_id: item.target_id,
      poll_id: item.poll_id,
      amount_cents: item.amount_cents,
      quantity: item.quantity,
      data: item.data,
      source: item.source,
      unit_price_cents: item.unit_price_cents,
      confirmed_reward_type: item.confirmed_reward_type,
    })),
  };
  if (pledge.format === 'LEGACY') {
    return {
      ...common,
      format: 'LEGACY' as const,
      total_cents: pledge.total_cents,
      top_up_cents: pledge.top_up_cents,
    };
  }
  return {
    ...common,
    format: 'POOLED' as const,
    draft_id: pledge.draft_id!,
    pledge_amount_cents: pledge.pledge_amount_cents!,
    plan: JSON.parse(pledge.confirmed_plan!) as PledgePlan,
    new_money_cents: pledge.new_money_cents!,
    wallet_applied_cents: pledge.held_wallet_cents,
    requires_shipping: pledge.requires_shipping,
  };
}

async function cleanText(tx: Prisma.TransactionClient, value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw httpError(400, `${label} must be text`);
  const text = value.trim();
  if (text.length > max) throw httpError(400, `${label} exceeds maximum of ${max} characters`);
  const words = new Set(text.toLowerCase().match(/\b\w+\b/g) ?? []);
  for (const blocked of await tx.blockedWord.findMany()) {
    if (words.has(blocked.word.toLowerCase())) {
      throw httpError(400, `Entry contains blocked word: "${blocked.word}"`);
    }
  }
  return text || null;
}

/**
 * Validate live review inputs and atomically store the immutable plan + initial
 * Wallet hold. Existing drafts resolve first: their own held funding is never
 * compared with a fresh balance. Unknown payment attempts remain immutable.
 */
export async function createPledge(input: CreatePledgeInput) {
  return withSpan('pledge.create', async () => {
    if (input.pledge_amount_cents === undefined || input.top_up_cents !== undefined) {
      throw httpError(400, 'The donate page was updated. Reload to continue.');
    }
    if (
      typeof input.draft_id !== 'string' ||
      !input.draft_id.trim() ||
      input.draft_id.length > 128
    ) {
      throw httpError(400, 'draft_id is required (maximum 128 characters)');
    }
    const pledge = await prisma.$transaction(async (tx) => {
      // Take SQLite's write lock before any read, so competing draft/Wallet
      // attempts serialize instead of both trying to upgrade a read lock.
      await tx.$executeRaw`UPDATE PendingPledge SET id = id WHERE draft_id = ${input.draft_id}`;
      const existing = await tx.pendingPledge.findFirst({
        where: {
          draft_id: input.draft_id,
          OR: [
            { status: { in: ['OPEN', 'FULFILLED', 'PAYMENT_REVIEW', 'LEGACY_PAID'] } },
            { non_payment_confirmed_at: null },
            { wallet_hold_status: 'HELD' },
          ],
        },
        orderBy: { created_at: 'desc' },
        include: { items: true },
      });
      if (existing) {
        if (existing.wallet_donor_id && existing.wallet_donor_id !== input.walletDonorId) {
          throw httpError(403, 'This pledge belongs to another donor session');
        }
        return existing;
      }
      if (!Array.isArray(input.items)) throw httpError(400, 'items must be an array');
      if (
        !Number.isInteger(input.pledge_amount_cents) ||
        input.pledge_amount_cents < MIN_SPEND_CENTS ||
        input.pledge_amount_cents > 2147483647
      ) {
        throw httpError(400, 'pledge_amount_cents must be integer cents of at least 100');
      }
      if (!input.channel_id || typeof input.channel_id !== 'string')
        throw httpError(400, 'channel_id is required');
      const channel = await tx.channel.findUnique({ where: { id: input.channel_id } });
      if (!channel || !channel.is_active) throw httpError(404, 'Channel not found or inactive');
      const donor = input.walletDonorId
        ? await tx.donor.findUnique({ where: { id: input.walletDonorId } })
        : null;
      if (input.walletDonorId && (!donor || donor.is_frozen))
        throw httpError(403, 'Donor unavailable');
      const comment = await cleanText(tx, input.comment, 'Comment', 500);
      const displayName = await cleanText(tx, input.display_name, 'Display name', 60);
      const selections: PledgeSelection[] = [];
      const correctedItems: PledgeItemInput[] = [];
      const quantities = new Map<string, number>();
      const channelMatches = (id: string | null) => id === null || id === channel.id;
      for (const [index, item] of input.items.entries()) {
        if (!item || !['REWARD', 'POLL_VOTE', 'GOAL', 'POLL_CUSTOM'].includes(item.kind)) {
          throw httpError(400, 'Invalid item kind');
        }
        if (typeof item.target_id !== 'string') throw httpError(400, 'target_id is required');
        let selection: PledgeSelection = {
          kind: item.kind,
          target_id: item.target_id,
          poll_id: item.poll_id,
          amount_cents: item.amount_cents ?? 0,
          insertion_order: item.insertion_order ?? index,
        };
        let corrected = item;
        if (item.kind === 'REWARD') {
          const requested = item.quantity ?? 1;
          if (!Number.isInteger(requested) || requested < 1)
            throw httpError(400, 'REWARD quantity must be a positive integer');
          const reward = await tx.reward.findUnique({ where: { id: item.target_id } });
          if (!reward || !reward.is_active || !channelMatches(reward.channel_id)) continue;
          const already = quantities.get(reward.id) ?? 0;
          const quantity =
            reward.quantity_total === null
              ? requested
              : Math.min(
                  requested,
                  Math.max(0, reward.quantity_total - reward.quantity_claimed - already),
                );
          if (quantity === 0) continue;
          quantities.set(reward.id, already + quantity);
          selection = {
            ...selection,
            quantity,
            unit_price_cents: reward.cost_cents,
            reward_type: reward.type,
            amount_cents: reward.cost_cents * quantity,
          };
          corrected = { ...item, quantity, amount_cents: selection.amount_cents };
        } else if (item.kind === 'GOAL') {
          const goal = await tx.fundGoal.findUnique({ where: { id: item.target_id } });
          if (!goal || !goal.is_active || goal.is_complete || !channelMatches(goal.channel_id))
            continue;
        } else {
          if (!item.poll_id) throw httpError(400, `${item.kind} requires poll_id`);
          const poll = await tx.poll.findUnique({ where: { id: item.poll_id } });
          if (
            !poll ||
            !poll.is_active ||
            !channelMatches(poll.channel_id) ||
            (poll.ends_at && poll.ends_at <= new Date())
          )
            continue;
          if (item.kind === 'POLL_VOTE') {
            const option = await tx.pollOption.findUnique({ where: { id: item.target_id } });
            if (!option || option.poll_id !== poll.id || option.status === 'REJECTED') continue;
          } else {
            if (!poll.allow_custom_entries) continue;
            const data =
              typeof item.data === 'object' && item.data ? (item.data as { label?: unknown }) : {};
            const label = await cleanText(
              tx,
              data.label,
              'Entry',
              poll.max_entry_chars ?? 2147483647,
            );
            if (!label) throw httpError(400, 'POLL_CUSTOM requires a label');
            corrected = { ...item, data: { label } };
          }
        }
        selections.push({ ...selection, data: corrected.data ?? null });
        correctedItems.push({ ...corrected, insertion_order: selection.insertion_order });
      }
      let plan: PledgePlan;
      try {
        plan = planPledge({
          pledge_amount_cents: input.pledge_amount_cents,
          selections,
          available_wallet_cents: donor?.balance_remaining ?? null,
        });
      } catch (error) {
        throw httpError(400, (error as Error).message);
      }
      if (Object.values(plan.overage_cents).some((cents) => cents > 0)) {
        throw Object.assign(httpError(400, 'Selections exceed the pledge amount in a Pool'), {
          plan,
          items: correctedItems,
        });
      }
      if (!input.plan) throw httpError(400, 'The client-shown plan is required');
      if (!isDeepStrictEqual(input.plan, plan)) {
        throw Object.assign(
          httpError(409, 'The pledge plan changed. Confirm the corrected review.'),
          { plan, items: correctedItems },
        );
      }
      if (plan.wallet_applied_cents > 0) {
        await tx.donor.update({
          where: { id: donor!.id },
          data: {
            balance_remaining: { decrement: plan.wallet_applied_cents },
            balance_held_cents: { increment: plan.wallet_applied_cents },
          },
        });
      }
      const rows = plan.selections.map((selection) => ({
        kind: selection.kind,
        target_id: selection.target_id,
        poll_id: selection.poll_id,
        amount_cents: selection.amount_cents,
        quantity: selection.quantity,
        unit_price_cents: selection.unit_price_cents,
        confirmed_reward_type: selection.reward_type,
        source: 'donor',
        data: selection.data === null ? null : JSON.stringify(selection.data),
      }));
      return tx.pendingPledge.create({
        data: {
          pledge_token: crypto.randomBytes(24).toString('hex'),
          format: 'POOLED',
          draft_id: input.draft_id,
          pledge_amount_cents: plan.pledge_amount_cents,
          confirmed_plan: JSON.stringify(plan),
          new_money_cents: plan.new_money_cents,
          held_wallet_cents: plan.wallet_applied_cents,
          wallet_donor_id: donor?.id ?? null,
          wallet_hold_status: plan.wallet_applied_cents > 0 ? 'HELD' : 'NONE',
          donor_email: donor?.email ?? input.email ?? null,
          comment,
          display_name: displayName,
          requires_shipping: plan.requires_shipping,
          channel_id: channel.id,
          expires_at: new Date(Math.floor((Date.now() + PLEDGE_TTL_MS) / 1000) * 1000),
          items: {
            create: [
              ...rows,
              ...plan.top_up_rows.map((topUp) => ({
                ...rows[topUp.selection_index]!,
                source: 'auto',
                amount_cents: topUp.amount_cents,
              })),
            ],
          },
        },
        include: { items: true },
      });
    });
    return pledgeResponse(pledge);
  });
}

export interface WalletDonor {
  id: string;
  email: string;
  balance_remaining: number;
  magic_token: string | null;
}

// Coalesce local double clicks. Cross-process retries use the persisted request
// and Stripe's same-token key; neither the lock nor a DB transaction spans Stripe.
const checkoutCreates = new Map<
  string,
  Promise<{ donate_url: string | null; checkout_session_id: string | null }>
>();

/** Use confirmed funding only. No fresh Wallet discount at checkout. */
export async function createCheckoutForPledge(
  pledgeToken: string,
  donor?: WalletDonor | null,
  _email?: string | null,
) {
  const current = await prisma.pendingPledge.findUnique({ where: { pledge_token: pledgeToken } });
  if (!current) throw httpError(404, 'Pledge not found');
  if (current.wallet_donor_id && current.wallet_donor_id !== donor?.id)
    throw httpError(403, 'This pledge belongs to another donor session');
  const running = checkoutCreates.get(pledgeToken);
  if (running) return running;
  const operation = checkoutForPledge(pledgeToken, donor);
  checkoutCreates.set(pledgeToken, operation);
  try {
    return await operation;
  } finally {
    if (checkoutCreates.get(pledgeToken) === operation) checkoutCreates.delete(pledgeToken);
  }
}

async function checkoutForPledge(pledgeToken: string, donor?: WalletDonor | null) {
  const pledge = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE PendingPledge SET id = id WHERE pledge_token = ${pledgeToken}`;
    const stored = await tx.pendingPledge.findUniqueOrThrow({
      where: { pledge_token: pledgeToken },
      include: { items: true },
    });
    if (stored.format !== 'POOLED') throw httpError(409, 'Legacy pledges are read-only');
    if (
      stored.checkout_session_id ||
      (stored.status !== 'OPEN' && !stored.checkout_requested_at) ||
      stored.new_money_cents === 0 ||
      !isStripeConfigured()
    )
      return stored;
    if (stored.checkout_requested_at) {
      if (Date.now() - stored.checkout_requested_at.getTime() >= 24 * 60 * 60 * 1000)
        throw httpError(409, 'Checkout creation is unresolved. Check Stripe before continuing.');
      return stored;
    }
    // Stripe requires at least 30 minutes to create a Session. Never extend the
    // immutable two-hour deadline to make a delayed first checkout possible.
    if (stored.expires_at.getTime() < Date.now() + 30 * 60 * 1000)
      throw httpError(409, 'Checkout deadline is too close. Cancel this pledge before editing.');
    const request = pledgeCheckoutRequest({
      pledgeToken,
      amountCents: stored.new_money_cents!,
      email: stored.donor_email,
      requiresShipping: stored.requires_shipping,
      expiresAt: stored.expires_at,
    });
    return tx.pendingPledge.update({
      where: { id: stored.id },
      data: {
        checkout_requested_at: new Date(),
        checkout_request: JSON.stringify(request),
      },
      include: { items: true },
    });
  });
  if (pledge.checkout_session_id || (pledge.status !== 'OPEN' && !pledge.checkout_requested_at)) {
    return {
      donate_url: pledgeResponse(pledge).donate_url,
      checkout_session_id: pledge.checkout_session_id,
    };
  }
  if (pledge.new_money_cents === 0) {
    if (!donor) throw httpError(403, 'Wallet funding requires a donor session');
    await intakeDonation({ source: 'wallet', pledge, donor });
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
    return { donate_url: `${baseUrl}/pledge/${pledgeToken}`, checkout_session_id: null };
  }
  if (!isStripeConfigured()) {
    if (pledge.requires_shipping)
      throw httpError(
        503,
        'Physical rewards require Stripe checkout to collect a shipping address',
      );
    return { donate_url: null, checkout_session_id: null };
  }
  const session = await createCheckoutSession(
    {
      pledgeToken,
      amountCents: pledge.new_money_cents!,
      email: pledge.donor_email,
      requiresShipping: pledge.requires_shipping,
      expiresAt: pledge.expires_at,
    },
    JSON.parse(pledge.checkout_request!) as Stripe.Checkout.SessionCreateParams,
  );
  await prisma.pendingPledge.updateMany({
    where: { id: pledge.id, checkout_session_id: null },
    data: {
      checkout_session_id: session.id,
      checkout_url: session.url ?? null,
      checkout_session_status: session.status ?? 'unknown',
      payment_status: session.payment_status ?? null,
    },
  });
  // A cached create response can already be paid/processing/expired. Bind its
  // identity first, then use the same reconciliation as a webhook, outside tx.
  if (session.status === 'complete' || session.status === 'expired') {
    const { reconcileCheckoutNotification } = await import('./checkout.js');
    await reconcileCheckoutNotification(
      session.status === 'expired' ? 'checkout.session.expired' : 'checkout.session.completed',
      session,
    );
  }
  const latest = await prisma.pendingPledge.findUniqueOrThrow({
    where: { id: pledge.id },
    include: { items: true },
  });
  if (latest.checkout_session_id !== session.id)
    throw httpError(409, 'Checkout Session identity changed');
  return {
    donate_url: pledgeResponse(latest).donate_url,
    checkout_session_id: latest.checkout_session_id,
  };
}
