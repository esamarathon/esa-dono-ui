import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { sendMagicLink } from './email.js';
import { resolvePledge, fulfillPledge } from './pledge.js';
import { TOKEN_TTL_MS } from '../config.js';
import { buildDonationCreatedPayload } from './webhooks/delivery.js';
import { withWebhooks } from './webhooks/outbox.js';
import { resolveDonationRoute } from './routing.js';
import { withSpan } from '../lib/tracing.js';

interface ProcessDonationOptions {
  externalId: string;
  email: string;
  donorName: string;
  amountCents: number;
  comment?: string | null;
  pledgeToken?: string | null;
  shippingCents?: number;
  channelId?: string | null;
  /** Route to this Event's primary Channel when no Channel is given (PRD-0002 §E5). */
  eventId?: string | null;
  /** Backdates Donation.created_at (#62) — e.g. when recording a donation
   * actually received on an external platform on an earlier date. Defaults
   * to now when omitted. */
  occurredAt?: Date | null;
}

/**
 * Shared donation processing — used by both the Stripe webhook
 * and the admin simulation endpoint.
 *
 * Idempotent: if externalId already exists, returns { duplicate: true }
 * without crediting balance or sending email.
 *
 * Stable token: existing donors keep their magic_token (not rotated).
 * Only new donors get a fresh token. TTL is extended on repeat donations.
 *
 * If pledgeToken is provided (or resolvable by email+amount), the pledge
 * items are auto-fulfilled from the credited balance. Remainder stays as
 * spendable balance_remaining. When a pledge is fulfilled, the donation's
 * comment is sourced from the pledge (donor captured it in the cart); the
 * caller-supplied comment is used as a fallback otherwise.
 *
 * @param {string}  options.externalId
 * @param {string}  options.email
 * @param {string}  options.donorName
 * @param {number}  options.amountCents
 * @param {string}  [options.comment]
 * @param {string}  [options.pledgeToken] - optional pledge token to fulfill
 * @returns {{ donor, token, pledge? }} | {{ duplicate: true }}
 */
export async function processDonation({
  externalId,
  email,
  donorName,
  amountCents,
  comment,
  pledgeToken,
  shippingCents = 0,
  channelId = null,
  eventId = null,
  occurredAt = null,
}: ProcessDonationOptions) {
  return withSpan('donation.process', async () => {
    return processDonationInner({
      externalId,
      email,
      donorName,
      amountCents,
      comment,
      pledgeToken,
      shippingCents,
      channelId,
      eventId,
      occurredAt,
    });
  });
}

async function processDonationInner({
  externalId,
  email,
  donorName,
  amountCents,
  comment,
  pledgeToken,
  shippingCents = 0,
  channelId = null,
  eventId = null,
  occurredAt = null,
}: ProcessDonationOptions) {
  const normalizedEmail = email.trim().toLowerCase();
  // Shipping is passed through to Stripe, not donated — exclude it from the
  // spendable wallet balance (but keep the full amount in total_donated).
  const creditedCents = amountCents - shippingCents;

  let result: {
    donor: { id: string; magic_token: string | null; email: string; balance_remaining: number };
    donation: {
      id: string;
      external_id: string;
      channel_id: string | null;
      event_id: string | null;
    };
    pledge: Awaited<ReturnType<typeof fulfillPledge>> | null;
  } | null = null;
  try {
    result = await withWebhooks(async (tx: Prisma.TransactionClient, emit, tiltify) => {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

      const donor = await tx.donor.upsert({
        where: { email: normalizedEmail },
        update: {
          total_donated: { increment: amountCents },
          balance_remaining: { increment: creditedCents },
          token_expires_at: tokenExpiresAt,
        },
        create: {
          email: normalizedEmail,
          total_donated: amountCents,
          balance_remaining: creditedCents,
          magic_token: token,
          token_expires_at: tokenExpiresAt,
        },
      });

      // Resolve the pledge first: its Channel routes the donation (PRD-0002 §E5).
      let pledge: Awaited<ReturnType<typeof resolvePledge>> = null;
      try {
        pledge = await resolvePledge({ pledgeToken, email: normalizedEmail, amountCents }, tx);
      } catch (pledgeErr) {
        console.error('Pledge resolution error (non-fatal):', pledgeErr);
      }
      const route = await resolveDonationRoute(tx, {
        channelId: pledge?.channel_id ?? channelId,
        eventId,
      });

      const donation = await tx.donation.create({
        data: {
          external_id: externalId,
          donor_id: donor.id,
          amount_cents: amountCents,
          donor_name: donorName,
          comment: comment ?? null,
          channel_id: route.channelId,
          event_id: route.eventId,
          ...(occurredAt ? { created_at: occurredAt } : {}),
        },
      });

      let pledgeResult: Awaited<ReturnType<typeof fulfillPledge>> | null = null;
      if (pledge) {
        try {
          pledgeResult = await fulfillPledge(tx, pledge, donor.id, donation.id);
          await tx.donation.update({
            where: { id: donation.id },
            data: {
              pledge: { connect: { id: pledge.id } },
              ...(pledge.comment ? { comment: pledge.comment } : {}),
              ...(pledge.display_name ? { donor_name: pledge.display_name } : {}),
            },
          });
        } catch (pledgeErr) {
          console.error('Pledge fulfillment error (non-fatal):', pledgeErr);
        }
      }

      // An unassigned donation is published when an admin assigns it (§E6).
      if (route.channelId || route.eventId) {
        // Re-read: pledge fulfilment may have set the comment and display name.
        const final = await tx.donation.findUniqueOrThrow({ where: { id: donation.id } });
        await emit('donation.created', () => buildDonationCreatedPayload(final));
        await tiltify.donation(final.id);
        await tiltify.totals(final.channel_id);
      }

      sendMagicLink(normalizedEmail, donor.magic_token!).catch((err) =>
        console.error('Email error:', err),
      );

      return { donor, donation, pledge: pledgeResult };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }

  return {
    donor: result!.donor,
    token: result!.donor.magic_token,
    pledge: result!.pledge,
    donation: result!.donation,
  };
}

/**
 * Check text against the global blocked-words dictionary.
 * Returns an error message string if a blocked word is found, or null if clean.
 * @deprecated import from './blockedWords.js' directly; re-exported here for
 * backward compatibility with existing callers.
 */
export { checkBlockedWords } from './blockedWords.js';
