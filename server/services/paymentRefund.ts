import type { PaymentRefund, Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { withWebhooks } from './webhooks/outbox.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
import { previewPoolShrinkTx, applyPoolShrinkTx } from './paymentRefundShrink.js';
import {
  createPaymentRefund,
  listPaymentRefunds,
  retrieveCheckoutSession,
  isDefiniteRefundRejection,
  type PaymentRefundReceipt,
} from './stripe.js';

type Tx = Prisma.TransactionClient;
async function lock(tx: Tx) {
  await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
}
export async function getPaymentRefundTx(tx: Tx, id: string) {
  const record = await tx.paymentRefund.findUnique({ where: { id } });
  if (!record) throw httpError(404, 'Payment refund not found');
  return record;
}
export async function listPaymentRefundsTx(
  tx: Tx,
  filters: { donation_id?: string; status?: string; offset?: number; limit?: number } = {},
) {
  const statuses = filters.status?.split(',');
  if (
    statuses?.some(
      (status) =>
        !['REQUESTED', 'PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'RESOLVED'].includes(
          status,
        ),
    )
  )
    throw httpError(400, 'Invalid Payment refund status');
  const offset = filters.offset ?? 0,
    limit = filters.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw httpError(400, 'Invalid pagination');
  const where: Prisma.PaymentRefundWhereInput = {
    ...(filters.donation_id ? { donation_id: filters.donation_id } : {}),
    ...(statuses
      ? { status: { in: statuses } }
      : {
          OR: [
            { status: { in: ['REQUESTED', 'PENDING', 'REQUIRES_ACTION', 'FAILED'] } },
            {
              status: 'RESOLVED',
              accepted_at: { not: null },
              shipping_cents: { gt: 0 },
              shipping_resolution: null,
              resolution: { not: 'REJECTED' },
            },
          ],
        }),
  };
  const records = await tx.paymentRefund.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
  });
  return { records, total: await tx.paymentRefund.count({ where }), offset, limit };
}

/** Read-only server eligibility. Confirmed physical type and funding provenance beat catalog edits. */
export async function previewPaymentRefundTx(tx: Tx, claimId: string) {
  const claim = await tx.rewardClaim.findUnique({
    where: { id: claimId },
    include: {
      reward: true,
      credit_redemptions: { select: { id: true } },
      donation: {
        include: {
          event: true,
          pledge: { include: { items: true } },
          reward_claims: {
            where: {
              reversed_at: null,
              status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] },
              credit_redemptions: { none: {} },
            },
            include: { reward: { select: { type: true } } },
          },
        },
      },
    },
  });
  if (!claim) throw httpError(404, 'Claim not found');
  const donation = claim.donation;
  const reason =
    claim.credit_redemptions.length || !donation
      ? 'Only a directly funded physical claim is eligible'
      : donation.pledge_amount_cents === null
        ? 'A pledge amount is required; legacy refunds are handled outside the app'
        : donation.status !== 'COMPLETED'
          ? 'Only COMPLETED donations are eligible'
          : !donation.event || donation.event.ended_at
            ? 'The source Event must exist and must not have ended'
            : !donation.external_id.startsWith('cs_')
              ? 'A Stripe Checkout payment is required'
              : claim.reversed_at || claim.status !== 'PENDING'
                ? 'Only a live PENDING claim is eligible'
                : (donation.pledge?.items.find(
                      (item) => item.kind === 'REWARD' && item.target_id === claim.reward_id,
                    )?.confirmed_reward_type ?? claim.reward.type) !== 'PHYSICAL'
                  ? 'Only a confirmed physical reward is eligible'
                  : donation.shipping_cents === null
                    ? 'Shipping must be recorded before a Payment refund'
                    : Math.min(claim.amount_cents, donation.amount_cents) <= 0
                      ? 'No refundable item money remains'
                      : (await tx.paymentRefund.count({
                            where: { donation_id: donation.id, status: 'REQUESTED' },
                          }))
                        ? 'A Payment refund is requested for this donation'
                        : null;
  if (reason || !donation)
    return {
      eligible: false as const,
      reason,
      claim_id: claim.id,
      donation_id: donation?.id ?? null,
    };
  const item = Math.min(claim.amount_cents, donation.amount_cents);
  const physical = donation.reward_claims.filter(
    (row) =>
      (donation.pledge?.items.find(
        (item) => item.kind === 'REWARD' && item.target_id === row.reward_id,
      )?.confirmed_reward_type ?? row.reward.type) === 'PHYSICAL',
  );
  const shipping =
    physical.length === 1
      ? Math.max(0, donation.shipping_cents! - donation.shipping_refunded_cents)
      : 0;
  return {
    eligible: true as const,
    reason: null,
    claim_id: claim.id,
    donation_id: donation.id,
    item_cents: item,
    shipping_cents: shipping,
    money_before_cents: donation.amount_cents,
    money_after_cents: donation.amount_cents - item,
    pledge_before_cents: donation.pledge_amount_cents!,
    pledge_after_cents: donation.pledge_amount_cents! - item,
    wallet_applied_cents: donation.wallet_applied_cents,
    pool_shrink: await previewPoolShrinkTx(tx, donation.id, claim.id, item),
  };
}

async function rejectTx(
  tx: Tx,
  record: PaymentRefund,
  reason: string,
  publisher: DonationPublisher,
  stripeId?: string,
) {
  if (record.accepted_at || record.status !== 'REQUESTED') return record;
  const before = await publisher.snapshot(record.donation_id);
  await tx.rewardClaim.update({ where: { id: record.claim_id }, data: { status: 'PENDING' } });
  const updated = await tx.paymentRefund.update({
    where: { id: record.id },
    data: {
      status: 'RESOLVED',
      resolution: 'REJECTED',
      resolved_at: new Date(),
      resolved_by: record.created_by,
      failure_reason: reason,
      ...(stripeId ? { stripe_refund_id: stripeId } : {}),
    },
  });
  await publisher.publish(record.donation_id, before);
  return updated;
}

/** The receipt, claim, money, financial shrink and outbox commit together, exactly once. */
export async function reconcilePaymentRefundTx(
  tx: Tx,
  receipt: PaymentRefundReceipt,
  publisher: DonationPublisher,
) {
  await lock(tx);
  const id = receipt.metadata?.payment_refund_id;
  if (!id) return null;
  const record = await tx.paymentRefund.findUnique({ where: { id } });
  if (!record) return null; // unrelated/manual/auction refunds do not belong to this state machine
  const donation = await tx.donation.findUniqueOrThrow({ where: { id: record.donation_id } });
  const paymentIntent =
    typeof receipt.payment_intent === 'string'
      ? receipt.payment_intent
      : receipt.payment_intent?.id;
  if (
    receipt.metadata?.donation_id !== record.donation_id ||
    receipt.metadata?.claim_id !== record.claim_id ||
    !receipt.id ||
    receipt.amount !== record.item_cents + record.shipping_cents ||
    !donation.payment_intent ||
    paymentIntent !== donation.payment_intent ||
    (record.stripe_refund_id && receipt.id !== record.stripe_refund_id)
  )
    throw httpError(409, 'Stripe refund identity or amount does not match the Payment refund');
  if (record.status === 'RESOLVED') return record;
  const failed = receipt.status === 'failed' || receipt.status === 'canceled';
  const accepted = ['pending', 'requires_action', 'succeeded'].includes(receipt.status ?? '');
  if (!accepted && !failed) throw httpError(409, 'Unknown Stripe refund status');
  if (!record.accepted_at) {
    if (record.status !== 'REQUESTED') return record;
    if (failed)
      return rejectTx(tx, record, receipt.failure_reason ?? receipt.status!, publisher, receipt.id);
    if (donation.status !== 'COMPLETED')
      throw httpError(409, 'Requested Payment refund source changed');
    const claim = await tx.rewardClaim.findUniqueOrThrow({ where: { id: record.claim_id } });
    if (claim.status !== 'CANCELLING' || claim.reversed_at)
      throw httpError(409, 'Requested Payment refund claim changed');
    const before = await publisher.snapshot(record.donation_id);
    const plan = await previewPoolShrinkTx(
      tx,
      record.donation_id,
      record.claim_id,
      record.item_cents,
    );
    await tx.rewardClaim.update({
      where: { id: record.claim_id },
      data: { status: 'REVERSED', reversed_at: new Date(), reversed_by: record.created_by },
    });
    await tx.reward.update({
      where: { id: claim.reward_id },
      data: { quantity_claimed: { decrement: 1 } },
    });
    await applyPoolShrinkTx(tx, plan, record.created_by);
    await tx.donation.update({
      where: { id: donation.id },
      data: {
        amount_cents: { decrement: record.item_cents },
        pledge_amount_cents: { decrement: record.item_cents },
        shipping_refunded_cents: { increment: record.shipping_cents },
      },
    });
    await tx.donor.update({
      where: { id: donation.donor_id },
      data: { total_donated: { decrement: record.item_cents } },
    });
    const updated = await tx.paymentRefund.update({
      where: { id },
      data: {
        status: receipt.status!.toUpperCase(),
        stripe_refund_id: receipt.id,
        accepted_at: new Date(),
        pool_shrink_data: JSON.stringify(plan),
        failure_reason: null,
      },
    });
    await publisher.publish(record.donation_id, before);
    return updated;
  }
  // Terminal local decisions never regress on a stale HTTP response or webhook.
  if (
    record.status === 'FAILED' ||
    (!failed && record.status === 'SUCCEEDED') ||
    (!failed && receipt.status === 'pending' && record.status === 'REQUIRES_ACTION')
  )
    return record;
  return tx.paymentRefund.update({
    where: { id },
    data: {
      status: failed ? 'FAILED' : receipt.status!.toUpperCase(),
      failure_reason: failed ? (receipt.failure_reason ?? receipt.status) : null,
    },
  });
}

export async function reconcilePaymentRefund(receipt: PaymentRefundReceipt) {
  return withWebhooks((tx, _emit, publisher) => reconcilePaymentRefundTx(tx, receipt, publisher));
}

async function reconcileOwnReceipt(id: string, receipt: PaymentRefundReceipt) {
  if (receipt.metadata?.payment_refund_id !== id)
    throw httpError(409, 'Stripe response does not match the requested Payment refund');
  const record = await reconcilePaymentRefund(receipt);
  if (!record) throw httpError(404, 'Payment refund not found');
  return record;
}

async function executePaymentRefund(id: string, retry: boolean) {
  const record = await prisma.$transaction((tx) => getPaymentRefundTx(tx, id));
  if (record.status !== 'REQUESTED' && !['PENDING', 'REQUIRES_ACTION'].includes(record.status))
    return record;
  let donation = await prisma.donation.findUniqueOrThrow({ where: { id: record.donation_id } });
  // All Stripe I/O is OUTSIDE transactions. Resolve/store before create so an early webhook can verify it.
  if (!donation.payment_intent) {
    const session = await retrieveCheckoutSession(donation.external_id);
    const pi =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (session.id !== donation.external_id || !pi)
      throw httpError(409, 'Checkout Session has no matching PaymentIntent');
    donation = await prisma.donation.update({
      where: { id: donation.id },
      data: { payment_intent: pi },
    });
  }
  if (retry) {
    const matches = (await listPaymentRefunds(donation.payment_intent!)).filter(
      (receipt) => receipt.metadata?.payment_refund_id === id,
    );
    if (matches.length > 1)
      throw httpError(409, 'Multiple Stripe refunds match this record; operator review required');
    if (matches.length) return reconcileOwnReceipt(id, matches[0]!);
    if (record.status !== 'REQUESTED')
      throw httpError(409, 'Accepted Stripe refund was not found; operator review required');
  }
  // A webhook or concurrent retry may have finished while the external list was running.
  const current = await prisma.$transaction((tx) => getPaymentRefundTx(tx, id));
  if (current.status !== 'REQUESTED') return current;
  let receipt: PaymentRefundReceipt;
  try {
    receipt = await createPaymentRefund({
      refundId: record.id,
      donationId: record.donation_id,
      claimId: record.claim_id,
      paymentIntent: donation.payment_intent!,
      itemCents: record.item_cents,
      shippingCents: record.shipping_cents,
    });
  } catch (error) {
    return withWebhooks(async (tx, _emit, publisher) => {
      await lock(tx);
      const latest = await getPaymentRefundTx(tx, id);
      if (latest.status !== 'REQUESTED') return latest;
      if (isDefiniteRefundRejection(error))
        return rejectTx(
          tx,
          latest,
          error instanceof Error ? error.message : 'Stripe rejected creation',
          publisher,
        );
      // Unknown outcome: do not unlock or touch any money. An explicit Retry reconciles first.
      return tx.paymentRefund.update({
        where: { id },
        data: { failure_reason: 'Stripe outcome unknown; retry reconciliation required' },
      });
    });
  }
  return reconcileOwnReceipt(id, receipt);
}

export async function requestPaymentRefund(claimId: string, actor: string) {
  if (!actor) throw httpError(400, 'Payment refund actor required');
  const record = await withWebhooks(async (tx, _emit, publisher) => {
    await lock(tx);
    const preview = await previewPaymentRefundTx(tx, claimId);
    if (!preview.eligible) throw httpError(409, preview.reason ?? 'Claim is not eligible');
    const before = await publisher.snapshot(preview.donation_id);
    const record = await tx.paymentRefund.create({
      data: {
        donation_id: preview.donation_id,
        claim_id: claimId,
        item_cents: preview.item_cents,
        shipping_cents: preview.shipping_cents,
        created_by: actor,
      },
    });
    await tx.rewardClaim.update({ where: { id: claimId }, data: { status: 'CANCELLING' } });
    await publisher.publish(preview.donation_id, before);
    return record;
  });
  return executePaymentRefund(record.id, false);
}
export function retryPaymentRefund(id: string) {
  return executePaymentRefund(id, true);
}

export type PaymentRefundItemResolution =
  'RETURNED_OUTSIDE_APP' | 'WALLET_CREDIT' | 'SETTLED_BY_DISPUTE';
export type PaymentRefundShippingResolution = 'RETURNED_OUTSIDE_APP' | 'KEPT_BY_AGREEMENT';

export async function resolvePaymentRefundItem(id: string, resolution: unknown, actor: string) {
  if (
    !['RETURNED_OUTSIDE_APP', 'WALLET_CREDIT', 'SETTLED_BY_DISPUTE'].includes(String(resolution)) ||
    !actor
  )
    throw httpError(400, 'Invalid item resolution or actor');
  return withWebhooks(async (tx, _emit, publisher) => {
    await lock(tx);
    const record = await getPaymentRefundTx(tx, id);
    if (record.resolution) {
      if (record.resolution === resolution) return record;
      throw httpError(409, 'The item outcome is already resolved');
    }
    if (record.status !== 'FAILED' || !record.accepted_at)
      throw httpError(409, 'Only an accepted, later-failed Payment refund can be resolved');
    const donation = await tx.donation.findUniqueOrThrow({ where: { id: record.donation_id } });
    if (await tx.paymentRefund.count({ where: { donation_id: donation.id, status: 'REQUESTED' } }))
      throw httpError(409, 'A Payment refund is requested for this donation');
    if (resolution === 'SETTLED_BY_DISPUTE' && donation.status !== 'CHARGEBACK')
      throw httpError(409, 'Only a CHARGEBACK can settle this item by dispute');
    if (resolution === 'WALLET_CREDIT' && !['COMPLETED', 'REFUNDED'].includes(donation.status))
      throw httpError(409, 'Wallet credit requires a COMPLETED or REFUNDED donation');
    const before = await publisher.snapshot(donation.id);
    if (resolution === 'WALLET_CREDIT') {
      const donor = await tx.donor.update({
        where: { id: donation.donor_id },
        data: {
          total_donated: { increment: record.item_cents },
          balance_remaining: { increment: record.item_cents },
        },
      });
      await tx.donation.update({
        where: { id: donation.id },
        data: {
          amount_cents: { increment: record.item_cents },
          pledge_amount_cents: { increment: record.item_cents },
          wallet_credit_granted_cents: { increment: record.item_cents },
          failed_payment_wallet_credit_cents: { increment: record.item_cents },
        },
      });
      await tx.balanceAdjustment.create({
        data: {
          donor_id: donation.donor_id,
          donation_id: donation.id,
          payment_refund_id: record.id,
          reference_id: record.id,
          type: 'FAILED_PAYMENT_REFUND',
          amount_cents: record.item_cents,
          balance_after_cents: donor.balance_remaining,
          created_by: actor,
          reason: 'Failed Payment refund given as Wallet credit',
        },
      });
    }
    const result = await tx.paymentRefund.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution: String(resolution),
        resolved_at: new Date(),
        resolved_by: actor,
      },
    });
    await publisher.publish(donation.id, before);
    return result;
  });
}

export async function resolvePaymentRefundShipping(id: string, resolution: unknown, actor: string) {
  if (!['RETURNED_OUTSIDE_APP', 'KEPT_BY_AGREEMENT'].includes(String(resolution)) || !actor)
    throw httpError(400, 'Invalid shipping resolution or actor');
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const record = await getPaymentRefundTx(tx, id);
    if (record.shipping_resolution) {
      if (record.shipping_resolution === resolution) return record;
      throw httpError(409, 'The shipping outcome is already resolved');
    }
    if (
      !record.accepted_at ||
      !record.shipping_cents ||
      (record.status !== 'FAILED' &&
        !(record.status === 'RESOLVED' && record.resolution !== 'REJECTED'))
    )
      throw httpError(
        409,
        'Only shipping on an accepted, later-failed Payment refund can be resolved',
      );
    return tx.paymentRefund.update({
      where: { id },
      data: {
        shipping_resolution: String(resolution),
        shipping_resolved_at: new Date(),
        shipping_resolved_by: actor,
      },
    });
  });
}
