import crypto from 'crypto';
import type { Donation, Donor, Prisma } from '@prisma/client';
import { sendMagicLink } from './email.js';
import { PLEDGE_TTL_MS, TOKEN_TTL_MS } from '../config.js';
import { withWebhooks } from './webhooks/outbox.js';
import { resolveDonationRoute } from './routing.js';
import { withSpan } from '../lib/tracing.js';
import {
  claimRewardTx,
  votePollTx,
  contributeGoalTx,
  proposeCustomEntryTx,
  customEntryTextErrorTx,
} from './spend.js';
import { planPledge, type PledgePlan, type PledgeItemKind } from '@dono/shared';
import { httpError } from '../lib/httpError.js';
import { defaultGoal } from './defaultGoal.js';

type Pledge = Prisma.PendingPledgeGetPayload<{ include: { items: true } }>;

interface PaymentFacts {
  externalId: string;
  email: string;
  donorName: string;
  amountCents: number;
  pledgeToken?: string | null;
}

/** Raw source facts only: the intake owns accounting, linkage and fulfillment. */
export type DonationIntake =
  | (PaymentFacts & { source: 'stripe'; shippingCents?: number; paymentIntent?: string | null })
  | (PaymentFacts & {
      source: 'admin';
      comment?: string | null;
      channelId?: string | null;
      /** Route to this Event's primary Channel when no Channel is given. */
      eventId?: string | null;
      /** Backdate an externally received donation (#62). */
      occurredAt?: Date | null;
    })
  | {
      source: 'wallet';
      pledge: Pledge;
      donor: Pick<Donor, 'id' | 'email' | 'magic_token'>;
    };

/**
 * Record completed Stripe, admin/external/simulator and wallet-only donations.
 * The donation, donor accounting, pledge allocations and queued messages commit
 * together. Authentication mail is fire-and-forget, but only after commit.
 * Duplicate external ids roll back and return { duplicate: true }, without mail.
 *
 * Pooled donations record new money only, shipping separately and zero initial
 * Wallet credit. Legacy/admin donations without a pledge retain Wallet funding.
 * Fulfillment remains internal to intake; external payment calls stay outside.
 */
export async function intakeDonation(input: DonationIntake) {
  return withSpan('donation.process', () => intakeDonationInner(input));
}

async function intakeDonationInner(input: DonationIntake) {
  const wallet = input.source === 'wallet';
  let email = wallet ? input.donor.email : input.email.trim().toLowerCase();
  const shippingCents = input.source === 'stripe' ? (input.shippingCents ?? 0) : 0;
  const amountCents = wallet
    ? input.pledge.format === 'POOLED'
      ? 0
      : input.pledge.total_cents
    : input.amountCents - shippingCents;
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 0 ||
    !Number.isSafeInteger(shippingCents) ||
    shippingCents < 0
  )
    throw httpError(400, 'Invalid payment money or shipping');
  const externalId = wallet
    ? input.pledge.format === 'POOLED'
      ? `wallet-${input.pledge.id}`
      : `wallet-${crypto.randomUUID()}`
    : input.externalId;
  let result: {
    donor: Donor;
    donation: Donation;
    pledge: Awaited<ReturnType<typeof fulfillPledge>> | null;
  };

  try {
    const transactionResult = await withWebhooks(async (tx, _emit, publisher) => {
      // Write lock first: repeated intake and a draft retry see committed funding.
      await tx.$executeRaw`UPDATE Donation SET id = id WHERE external_id = ${externalId}`;
      const pledge: Pledge | null = wallet
        ? await tx.pendingPledge.findUniqueOrThrow({
            where: { id: input.pledge.id },
            include: { items: true },
          })
        : await resolvePledge({ pledgeToken: input.pledgeToken, email, amountCents }, tx);
      let pooled = pledge?.format === 'POOLED';
      if (
        input.source === 'stripe' &&
        pledge &&
        (pooled || pledge.checkout_session_id) &&
        pledge.checkout_session_id !== externalId
      )
        throw httpError(409, 'Checkout Session does not match this pledge');
      if (pledge?.fulfilled_by_donation_id) return null;
      if (pooled && pledge!.new_money_cents !== amountCents)
        throw httpError(409, 'Payment differs from confirmed new money');
      if (
        wallet &&
        (pledge!.status !== 'OPEN' || (pledge!.wallet_donor_id !== input.donor.id && pooled))
      )
        throw httpError(403, 'Wallet pledge is unavailable or belongs to another donor');
      const bound =
        pooled && pledge!.wallet_donor_id
          ? await tx.donor.findUniqueOrThrow({ where: { id: pledge!.wallet_donor_id } })
          : null;
      if (bound) email = bound.email;
      let paymentReview = false;
      if (pooled && pledge!.held_wallet_cents > 0 && pledge!.wallet_hold_status === 'RELEASED') {
        // A paid-after-confirmed-failure notification contradicts the provider's
        // expiration contract. Reacquire ALL original Wallet funding before any
        // new money is credited. Never borrow from the received cash or create debt.
        const reacquired = await tx.donor.updateMany({
          where: {
            id: bound!.id,
            balance_remaining: { gte: pledge!.held_wallet_cents },
            is_frozen: false,
          },
          data: {
            balance_remaining: { decrement: pledge!.held_wallet_cents },
            balance_held_cents: { increment: pledge!.held_wallet_cents },
          },
        });
        if (reacquired.count === 1) {
          await tx.pendingPledge.update({
            where: { id: pledge!.id },
            data: { wallet_hold_status: 'HELD' },
          });
          pledge!.wallet_hold_status = 'HELD';
        } else {
          // Approved #186 amendment: actual cash only, NULL-D legacy accounting,
          // no original incentives. Persist a distinct, admin-visible outcome.
          pooled = false;
          paymentReview = true;
        }
      }
      const legacyLate =
        !!pledge &&
        pledge.format === 'LEGACY' &&
        !wallet &&
        (pledge.status !== 'OPEN' || pledge.expires_at <= new Date());
      if (legacyLate && input.source === 'stripe' && !pledge!.checkout_session_id) {
        await tx.pendingPledge.update({
          where: { id: pledge!.id },
          data: { checkout_session_id: externalId },
        });
      }
      const creditOnly = paymentReview || legacyLate;
      const credit = pooled ? 0 : amountCents;
      // Keep stable identity/token and role. A self-supplied payment email cannot
      // replace the donor who supplied the pledge's held Wallet funding.
      const donor = wallet
        ? await tx.donor.findUniqueOrThrow({ where: { id: input.donor.id } })
        : bound
          ? await tx.donor.update({
              where: { id: bound.id },
              data: {
                total_donated: { increment: amountCents },
                balance_remaining: { increment: credit },
                token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
              },
            })
          : await tx.donor.upsert({
              where: { email },
              update: {
                total_donated: { increment: amountCents },
                balance_remaining: { increment: credit },
                token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
              },
              create: {
                email,
                total_donated: amountCents,
                balance_remaining: credit,
                magic_token: crypto.randomBytes(32).toString('hex'),
                token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
              },
            });
      const route = await resolveDonationRoute(tx, {
        channelId: pledge?.channel_id ?? (input.source === 'admin' ? input.channelId : null),
        eventId: input.source === 'admin' ? input.eventId : null,
      });
      const donation = await tx.donation.create({
        data: {
          external_id: externalId,
          donor_id: donor.id,
          amount_cents: amountCents,
          pledge_amount_cents: pooled ? pledge!.pledge_amount_cents : null,
          wallet_applied_cents: pooled ? pledge!.held_wallet_cents : 0,
          // Helpers can inspect immutable physical prices/types while fulfilling.
          ...(pooled || creditOnly ? { pledge: { connect: { id: pledge!.id } } } : {}),
          shipping_cents: shippingCents,
          shipping_recorded_at: new Date(),
          payment_intent: input.source === 'stripe' ? input.paymentIntent : null,
          donor_name:
            pledge?.display_name ?? (wallet ? input.pledge.display_name : input.donorName),
          comment: pledge?.comment ?? (input.source === 'admin' ? (input.comment ?? null) : null),
          channel_id: route.channelId,
          event_id: route.eventId,
          ...(input.source === 'admin' && input.occurredAt ? { created_at: input.occurredAt } : {}),
        },
      });

      let pledgeResult: Awaited<ReturnType<typeof fulfillPledge>> | null = null;
      if (pledge && creditOnly) {
        await tx.pendingPledge.update({
          where: { id: pledge.id },
          data: {
            status: paymentReview ? 'PAYMENT_REVIEW' : 'EXPIRED',
          },
        });
      } else if (pledge) {
        const fulfillAndLink = async () => {
          pledgeResult = pooled
            ? await fulfillPooledPledge(tx, pledge, donor.id, donation.id)
            : await fulfillPledge(tx, pledge, donor.id, donation.id);
          await tx.donation.update({
            where: { id: donation.id },
            data: {
              pledge: { connect: { id: pledge.id } },
              ...(pledge.comment ? { comment: pledge.comment } : {}),
              ...(pledge.display_name ? { donor_name: pledge.display_name } : {}),
            },
          });
          if (pooled && pledge.held_wallet_cents > 0) {
            if (pledge.wallet_hold_status !== 'HELD')
              throw httpError(409, 'Wallet funding is not held');
            const consumed = await tx.donor.updateMany({
              where: { id: donor.id, balance_held_cents: { gte: pledge.held_wallet_cents } },
              data: { balance_held_cents: { decrement: pledge.held_wallet_cents } },
            });
            if (consumed.count !== 1) throw httpError(409, 'Wallet hold is inconsistent');
            await tx.pendingPledge.update({
              where: { id: pledge.id },
              data: { wallet_hold_status: 'CONSUMED', wallet_consumed_at: new Date() },
            });
          } else if (wallet && !pooled) {
            await tx.pendingPledge.update({
              where: { id: pledge.id },
              data: { wallet_discount_cents: amountCents },
            });
          }
        };
        // Preserve the paid paths' non-fatal pledge failures. The wallet-only
        // path has no newly paid money and keeps its existing rollback behavior.
        if (wallet || pooled) await fulfillAndLink();
        else {
          try {
            await fulfillAndLink();
          } catch (pledgeErr) {
            console.error('Pledge fulfillment error (non-fatal):', pledgeErr);
          }
        }
      }

      if (pledge && input.source === 'stripe') {
        await tx.pendingPledge.update({
          where: { id: pledge.id },
          data: {
            payment_status: 'paid',
            checkout_session_status: 'complete',
            reconciled_at: new Date(),
          },
        });
      }
      await publisher.publish(donation.id, null);
      return { donor, donation, pledge: pledgeResult };
    });
    if (!transactionResult) return { duplicate: true } as const;
    result = transactionResult;
  } catch (err) {
    const error = err as { code?: string; meta?: { target?: unknown } };
    if (error.code === 'P2002' && JSON.stringify(error.meta?.target ?? '').includes('external_id'))
      return { duplicate: true } as const;
    throw err;
  }

  sendMagicLink(email, result.donor.magic_token!).catch((err) =>
    console.error('Email error:', err),
  );
  return { ...result, token: result.donor.magic_token };
}

/** Pooled fulfillment has no Wallet credit: unused poll/goal money stays reserved. */
async function fulfillPooledPledge(
  tx: Prisma.TransactionClient,
  pledge: Pledge,
  donorId: string,
  donationId: string,
) {
  const results: Array<Record<string, unknown>> = [];
  let totalSpent = 0;
  let skipped = 0;
  const confirmed = JSON.parse(pledge.confirmed_plan!) as PledgePlan;
  const groups: Array<{
    item: Pledge['items'][number];
    donor: number;
    auto: number;
    order: number;
  }> = [];
  const unmatched = pledge.items.filter(
    (item) => item.source === 'donor' && item.kind !== 'REWARD',
  );
  for (const [index, selection] of confirmed.selections.entries()) {
    if (selection.kind === 'REWARD') continue;
    const itemIndex = unmatched.findIndex(
      (item) =>
        item.kind === selection.kind &&
        item.target_id === selection.target_id &&
        item.poll_id === selection.poll_id &&
        item.amount_cents === selection.amount_cents &&
        (item.data ?? 'null') === JSON.stringify(selection.data),
    );
    const item = unmatched.splice(itemIndex, 1)[0];
    if (itemIndex < 0 || !item) throw new Error('Confirmed plan does not match stored selections');
    groups.push({
      item,
      donor: selection.amount_cents,
      auto: confirmed.top_up_rows.find((row) => row.selection_index === index)?.amount_cents ?? 0,
      order: selection.insertion_order,
    });
  }
  for (const item of pledge.items) {
    if (item.kind === 'REWARD') {
      try {
        const { cost } = await claimRewardTx(
          tx,
          donorId,
          item.target_id,
          item.data ? JSON.parse(item.data) : {},
          item.quantity,
          donationId,
          {
            mode: 'pool',
            source: 'donor',
            unit_price_cents: item.unit_price_cents!,
            confirmed_reward_type: item.confirmed_reward_type!,
          },
        );
        totalSpent += cost;
        results.push({ item_id: item.id, kind: item.kind, status: 'fulfilled', cost });
      } catch (error) {
        // Only expected live eligibility failures are skipped. Database failures
        // must roll back ALL accounting and allocations, not commit a partial row.
        if (![400, 404].includes((error as { status?: number }).status ?? 0)) throw error;
        skipped++;
        results.push({
          item_id: item.id,
          kind: item.kind,
          status: 'skipped',
          reason: (error as Error).message,
        });
      }
      continue;
    }
  }
  for (const category of ['poll', 'goal'] as const) {
    const all = groups.filter(({ item }) =>
      category === 'goal' ? item.kind === 'GOAL' : item.kind !== 'GOAL',
    );
    const eligible: typeof all = [];
    for (const group of all) {
      const { item } = group;
      const matches = (id: string | null) => id === null || id === pledge.channel_id;
      let valid = false;
      if (category === 'goal') {
        const goal = await tx.fundGoal.findUnique({ where: { id: item.target_id } });
        valid = !!goal && goal.is_active && !goal.is_complete && matches(goal.channel_id);
      } else {
        const poll = await tx.poll.findUnique({ where: { id: item.poll_id! } });
        valid =
          !!poll &&
          poll.is_active &&
          matches(poll.channel_id) &&
          (!poll.ends_at || poll.ends_at > new Date());
        if (item.kind === 'POLL_VOTE') {
          const option = await tx.pollOption.findUnique({ where: { id: item.target_id } });
          valid =
            valid && !!option && option.poll_id === item.poll_id && option.status !== 'REJECTED';
        } else {
          valid = valid && !!poll?.allow_custom_entries;
          if (valid && poll) {
            const label = JSON.parse(item.data!).label.trim();
            valid = !!label && !(await customEntryTextErrorTx(tx, label, poll.max_entry_chars));
          }
        }
      }
      if (valid) eligible.push(group);
      else {
        skipped++;
        results.push({
          item_id: item.id,
          kind: item.kind,
          status: 'skipped',
          reason: 'Selection is no longer eligible',
        });
      }
    }
    eligible.sort((a, b) => a.order - b.order);
    if (eligible.length && eligible.length !== all.length) {
      // A live change releases its whole allocation. Re-run the SAME flat
      // proportional rule on the remaining donor choices (not per-poll groups).
      const repaired = planPledge({
        pledge_amount_cents: pledge.pledge_amount_cents!,
        available_wallet_cents: null,
        selections: eligible.map(({ item, donor, order }) => ({
          kind: item.kind as PledgeItemKind,
          target_id: item.target_id,
          poll_id: item.poll_id,
          amount_cents: donor,
          insertion_order: order,
        })),
      });
      eligible.forEach((group, index) => {
        group.auto =
          repaired.top_up_rows.find((row) => row.selection_index === index)?.amount_cents ?? 0;
      });
    }
    if (category === 'goal' && eligible.length === 0) {
      const goalId = await defaultGoal(tx, pledge.channel_id!);
      if (goalId) {
        await contributeGoalTx(tx, donorId, goalId, pledge.pledge_amount_cents!, donationId, {
          mode: 'pool',
          source: 'auto',
        });
        totalSpent += pledge.pledge_amount_cents!;
      }
    }
    // Round the flat selections first, then combine identical targets for one
    // live write. A donor+auto goal may overshoot and complete in that write.
    const writes = new Map<string, (typeof groups)[number]>();
    for (const group of eligible) {
      const { item } = group;
      const key = JSON.stringify([
        item.kind,
        item.target_id,
        item.poll_id,
        item.kind === 'POLL_CUSTOM' ? item.data : null,
      ]);
      const previous = writes.get(key);
      if (previous) {
        previous.donor += group.donor;
        previous.auto += group.auto;
      } else writes.set(key, { ...group });
    }
    for (const { item, donor, auto } of writes.values()) {
      const amount = donor + auto;
      const mode = { mode: 'pool' as const, source: 'donor' as const, auto_cents: auto };
      if (item.kind === 'GOAL')
        await contributeGoalTx(tx, donorId, item.target_id, amount, donationId, mode);
      else if (item.kind === 'POLL_VOTE')
        await votePollTx(tx, donorId, item.poll_id!, item.target_id, amount, donationId, mode);
      else if (item.kind === 'POLL_CUSTOM')
        await proposeCustomEntryTx(
          tx,
          donorId,
          item.poll_id!,
          JSON.parse(item.data!).label,
          amount,
          donationId,
          mode,
        );
      totalSpent += amount;
      results.push({ item_id: item.id, kind: item.kind, status: 'fulfilled', cost: amount });
    }
  }
  await tx.pendingPledge.update({ where: { id: pledge.id }, data: { status: 'FULFILLED' } });
  return { totalSpent, skipped, results };
}

/** Legacy fulfillment keeps its historical one-dollar-once Wallet accounting. */
async function fulfillPledge(
  tx: Prisma.TransactionClient,
  pledge: Pledge,
  donorId: string,
  donationId: string,
) {
  return withSpan('pledge.fulfill', async () => {
    const results: Array<Record<string, unknown>> = [];
    let totalSpent = 0;
    let skipped = 0;

    for (const item of pledge.items) {
      try {
        let result: { cost: number } | undefined;
        if (item.kind === 'REWARD') {
          const data = item.data ? JSON.parse(item.data) : {};
          result = await claimRewardTx(
            tx,
            donorId,
            item.target_id,
            data,
            item.quantity,
            donationId,
          );
        } else if (item.kind === 'POLL_VOTE') {
          result = await votePollTx(
            tx,
            donorId,
            item.poll_id!,
            item.target_id,
            item.amount_cents,
            donationId,
          );
        } else if (item.kind === 'GOAL') {
          result = await contributeGoalTx(
            tx,
            donorId,
            item.target_id,
            item.amount_cents,
            donationId,
          );
        } else if (item.kind === 'POLL_CUSTOM') {
          const data = item.data ? JSON.parse(item.data) : {};
          result = await proposeCustomEntryTx(
            tx,
            donorId,
            item.poll_id!,
            data.label,
            item.amount_cents,
            donationId,
          );
        }
        totalSpent += result!.cost;
        results.push({
          item_id: item.id,
          kind: item.kind,
          status: 'fulfilled',
          cost: result!.cost,
        });
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

    await tx.pendingPledge.update({ where: { id: pledge.id }, data: { status: 'FULFILLED' } });
    return { totalSpent, skipped, results };
  });
}

/** Current token/amount/expiry rules, including the legacy email fallback. */
async function resolvePledge(
  {
    pledgeToken,
    email,
    amountCents,
  }: {
    pledgeToken?: string | null;
    email: string;
    amountCents: number;
  },
  tx: Prisma.TransactionClient,
) {
  if (pledgeToken !== undefined && pledgeToken !== null) {
    const pledge = await tx.pendingPledge.findUnique({
      where: { pledge_token: pledgeToken },
      include: { items: true },
    });
    // An exact token is authoritative even after a local terminal state. Unknown
    // tokens NEVER fall through to another pledge with the same email address.
    if (pledge?.format === 'POOLED') return pledge;
    if (pledge?.status === 'FULFILLED') return null;
    // Keep late cash-only receipts linked for Session checks and deduplication.
    if (pledge?.fulfilled_by_donation_id || pledge?.status === 'LEGACY_PAID') return pledge;
    if (
      pledge?.status === 'OPEN' &&
      pledge.expires_at > new Date() &&
      pledge.total_cents > amountCents + pledge.wallet_discount_cents
    )
      return null;
    return pledge;
  }

  const cutoff = new Date(Date.now() - PLEDGE_TTL_MS);
  return tx.pendingPledge.findFirst({
    where: {
      donor_email: email,
      format: 'LEGACY',
      status: 'OPEN',
      total_cents: { lte: amountCents },
      expires_at: { gt: new Date() },
      created_at: { gte: cutoff },
    },
    orderBy: { created_at: 'desc' },
    include: { items: true },
  });
}

/** @deprecated Import from './blockedWords.js' directly. */
export { checkBlockedWords } from './blockedWords.js';
