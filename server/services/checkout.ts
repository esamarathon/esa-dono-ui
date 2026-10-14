import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { intakeDonation } from './donation.js';
import { createCheckoutForPledge, pledgeResponse, type WalletDonor } from './pledge.js';
import {
  expireCheckoutSession,
  retrieveCheckoutSession,
  findPledgeCheckoutSessions,
  type CheckoutSession,
} from './stripe.js';

export async function getPledge(token: string) {
  const pledge = await prisma.pendingPledge.findUnique({
    where: { pledge_token: token },
    include: { items: true },
  });
  if (!pledge) throw httpError(404, 'Pledge not found');
  return pledge;
}

/** Reconciliation can recover identity, but never create a new payment opportunity. */
async function recoverSessionId(token: string, donor?: WalletDonor | null) {
  const pledge = await getPledge(token);
  if (pledge.checkout_session_id || !pledge.checkout_requested_at)
    return pledge.checkout_session_id;
  if (Date.now() - pledge.checkout_requested_at.getTime() < 24 * 60 * 60 * 1000) {
    // The exact frozen request/key returns the original Session after a lost response.
    const boundDonor = pledge.wallet_donor_id
      ? await prisma.donor.findUniqueOrThrow({ where: { id: pledge.wallet_donor_id } })
      : donor;
    return (await createCheckoutForPledge(token, boundDonor)).checkout_session_id;
  }
  const sessions = await findPledgeCheckoutSessions(token, pledge.checkout_requested_at);
  if (
    sessions.length !== 1 ||
    sessions[0]!.expires_at !== Math.floor(pledge.expires_at.getTime() / 1000)
  )
    throw httpError(409, 'Checkout creation is unresolved. Stripe review is required.');
  const session = sessions[0]!;
  await prisma.pendingPledge.updateMany({
    where: { id: pledge.id, checkout_session_id: null },
    data: {
      checkout_session_id: session.id,
      checkout_url: session.url,
    },
  });
  return (await getPledge(token)).checkout_session_id;
}

async function recordUnknown(token: string) {
  await prisma.pendingPledge.updateMany({
    where: {
      pledge_token: token,
      fulfilled_by_donation_id: null,
      non_payment_confirmed_at: null,
    },
    data: { checkout_session_status: 'unknown', reconciled_at: new Date() },
  });
}

async function recordNonPayment(
  token: string,
  session: CheckoutSession | null,
  cancelled: boolean,
  asyncFailed = false,
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE PendingPledge SET id = id WHERE pledge_token = ${token}`;
    const pledge = await tx.pendingPledge.findUniqueOrThrow({ where: { pledge_token: token } });
    // A success transaction always wins over an older expiration response.
    if (pledge.fulfilled_by_donation_id || pledge.status === 'FULFILLED') return;
    if (
      session
        ? pledge.checkout_session_id !== session.id
        : !!pledge.checkout_requested_at || !!pledge.checkout_session_id
    )
      throw httpError(409, 'Checkout Session identity is unresolved');
    if (pledge.wallet_hold_status === 'HELD') {
      const released = await tx.donor.updateMany({
        where: {
          id: pledge.wallet_donor_id!,
          balance_held_cents: { gte: pledge.held_wallet_cents },
        },
        data: {
          balance_held_cents: { decrement: pledge.held_wallet_cents },
          balance_remaining: { increment: pledge.held_wallet_cents },
        },
      });
      if (released.count !== 1) throw httpError(409, 'Wallet hold is inconsistent');
    }
    await tx.pendingPledge.update({
      where: { id: pledge.id },
      data: {
        status: cancelled ? 'CANCELLED' : 'EXPIRED',
        ...(pledge.wallet_hold_status === 'HELD'
          ? { wallet_hold_status: 'RELEASED', wallet_released_at: new Date() }
          : {}),
        non_payment_confirmed_at: pledge.non_payment_confirmed_at ?? new Date(),
        reconciled_at: new Date(),
        ...(session
          ? {
              checkout_session_status: session.status,
              payment_status: asyncFailed ? 'failed' : session.payment_status,
            }
          : {}),
      },
    });
  });
  return pledgeResponse(await getPledge(token));
}

async function recordPaidSession(
  session: CheckoutSession,
  token?: string | null,
  fallbackEmail?: string | null,
) {
  const email = session.customer_details?.email ?? session.customer_email ?? fallbackEmail;
  if (!email || session.amount_total === null || session.amount_total === undefined)
    throw httpError(409, 'Paid Checkout Session is missing payment facts');
  await intakeDonation({
    source: 'stripe',
    externalId: session.id,
    email,
    donorName: session.customer_details?.name ?? 'Anonymous',
    amountCents: session.amount_total,
    shippingCents: session.total_details?.amount_shipping ?? 0,
    pledgeToken: token,
    paymentIntent:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id,
  });
}

async function reconcileSession(
  token: string,
  session: CheckoutSession,
  cancelled = false,
  asyncFailed = false,
) {
  const pledge = await getPledge(token);
  if (pledge.checkout_session_id !== session.id || session.recovered_from)
    throw httpError(409, 'Checkout Session does not match this pledge');
  if (!['open', 'complete', 'expired'].includes(session.status ?? ''))
    throw httpError(409, 'Checkout Session state is unknown');
  if (session.payment_status === 'paid' && session.status === 'complete') {
    await recordPaidSession(session, token, pledge.donor_email);
    return pledgeResponse(await getPledge(token));
  }
  const failureReceived = asyncFailed || pledge.payment_status === 'failed';
  const intent = session.payment_intent;
  const retryable = typeof intent === 'object' && intent !== null && intent.status !== 'canceled';
  if (session.status === 'expired' && session.payment_status !== 'paid')
    return recordNonPayment(token, session, cancelled);
  // A verified async failure is authoritative, unless current Stripe evidence
  // explicitly shows a processing/retryable Intent. Keep its receipt so a later
  // Check Stripe can resolve the failure without replaying a webhook.
  if (
    failureReceived &&
    session.status === 'complete' &&
    session.payment_status === 'unpaid' &&
    !retryable
  )
    return recordNonPayment(token, session, cancelled, true);
  await prisma.pendingPledge.updateMany({
    where: {
      id: pledge.id,
      fulfilled_by_donation_id: null,
      non_payment_confirmed_at: null,
    },
    data: {
      checkout_session_status: session.status,
      payment_status: failureReceived ? 'failed' : session.payment_status,
      reconciled_at: new Date(),
    },
  });
  return pledgeResponse(await getPledge(token));
}

export type CheckoutNotification =
  | 'checkout.session.completed'
  | 'checkout.session.expired'
  | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed';

/** #188 consumes this receipt and owns the legacy chargeback transaction. */
export interface LegacyAsyncFailure {
  legacy_async_failure: {
    donation_id: string;
    checkout_session_id: string;
    pledge_token: string | null;
  };
}

/** Called ONLY after Stripe signature verification (or by a trusted adapter test). */
export async function reconcileCheckoutNotification(
  type: CheckoutNotification,
  session: CheckoutSession,
) {
  const token = session.metadata?.pledge_token ?? session.client_reference_id;
  const pledge = token
    ? await prisma.pendingPledge.findUnique({ where: { pledge_token: token } })
    : null;
  if (type === 'checkout.session.async_payment_failed') {
    const recorded = await prisma.donation.findUnique({ where: { external_id: session.id } });
    if (recorded && recorded.pledge_amount_cents === null) {
      // Receive the pre-change failure without applying a made-up reversal rule.
      // Persist the verified failure on its bound pledge for staff visibility.
      await prisma.pendingPledge.updateMany({
        where: { checkout_session_id: session.id },
        data: {
          payment_status: 'failed',
          reconciled_at: new Date(),
        },
      });
      return {
        legacy_async_failure: {
          donation_id: recorded.id,
          checkout_session_id: session.id,
          pledge_token: token ?? null,
        },
      } satisfies LegacyAsyncFailure;
    }
  }
  if (pledge) {
    if (
      pledge.format === 'LEGACY' &&
      !pledge.checkout_session_id &&
      !pledge.fulfilled_by_donation_id &&
      (pledge.status === 'CANCELLED' ||
        pledge.status === 'EXPIRED' ||
        pledge.expires_at <= new Date()) &&
      (type === 'checkout.session.completed' ||
        type === 'checkout.session.async_payment_succeeded') &&
      session.status === 'complete' &&
      session.payment_status === 'paid' &&
      !session.recovered_from
    ) {
      // Pre-transition lost creates have no request snapshot to replay. This
      // binds only a cash-only legacy receipt, never original incentives or W.
      await recordPaidSession(session, pledge.pledge_token, pledge.donor_email);
      return pledgeResponse(await getPledge(pledge.pledge_token));
    }
    const id = await recoverSessionId(pledge.pledge_token);
    if (id !== session.id || session.recovered_from)
      throw httpError(409, 'Checkout Session does not match this pledge');
    if (type === 'checkout.session.async_payment_failed') {
      let current: CheckoutSession;
      try {
        current = await retrieveCheckoutSession(id);
      } catch {
        await recordUnknown(pledge.pledge_token);
        throw httpError(409, 'Stripe state is unknown after async failure');
      }
      if (current.id !== id || current.recovered_from)
        throw httpError(409, 'Checkout Session does not match this pledge');
      return reconcileSession(pledge.pledge_token, current, false, true);
    }
    return reconcileSession(pledge.pledge_token, session);
  }
  if (
    (type === 'checkout.session.completed' ||
      type === 'checkout.session.async_payment_succeeded') &&
    session.status === 'complete' &&
    session.payment_status === 'paid'
  ) {
    await recordPaidSession(session, token);
  }
  return null;
}

export async function reconcilePledge(token: string, donor?: WalletDonor | null) {
  const pledge = await getPledge(token);
  if (pledge.fulfilled_by_donation_id) return pledgeResponse(pledge);
  try {
    const id = await recoverSessionId(token, donor);
    if (!id) return pledgeResponse(await getPledge(token));
    return await reconcileSession(token, await retrieveCheckoutSession(id));
  } catch (error) {
    if ((error as { status?: number }).status === 403) throw error;
    await recordUnknown(token);
    const latest = await getPledge(token);
    if (latest.fulfilled_by_donation_id) return pledgeResponse(latest);
    throw httpError(
      409,
      'Stripe state is unknown. Keep this pledge read-only and retry reconciliation.',
    );
  }
}

/** Expire first. A failed expire is not proof: retrieve the exact bound Session. */
export async function cancelPledge(token: string, donor?: WalletDonor | null) {
  const pledge = await getPledge(token);
  if (pledge.format !== 'POOLED') throw httpError(409, 'Legacy pledges are read-only');
  if (pledge.wallet_donor_id && pledge.wallet_donor_id !== donor?.id)
    throw httpError(403, 'This pledge belongs to another donor session');
  if (pledge.fulfilled_by_donation_id || pledge.non_payment_confirmed_at)
    return pledgeResponse(pledge);
  try {
    const id = await recoverSessionId(token, donor);
    if (!id) return await recordNonPayment(token, null, true);
    let session: CheckoutSession;
    try {
      session = await expireCheckoutSession(id);
    } catch {
      session = await retrieveCheckoutSession(id);
    }
    const result = await reconcileSession(token, session, true);
    if (session.status === 'open') throw httpError(409, 'Checkout is still payable');
    return result;
  } catch (error) {
    if ((error as { status?: number }).status === 403) throw error;
    // A concurrent paid webhook must not turn into an apparent cancellation error.
    const latest = await getPledge(token);
    if (latest.fulfilled_by_donation_id) return pledgeResponse(latest);
    await recordUnknown(token);
    throw httpError(
      409,
      'Cancellation is unconfirmed. Keep this pledge read-only and check Stripe again.',
    );
  }
}
