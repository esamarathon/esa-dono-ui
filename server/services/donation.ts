import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { sendMagicLink } from './email.js';
import { resolvePledge, fulfillPledge } from './pledge.js';
import { TOKEN_TTL_MS } from '../config.js';
import { emitWebhookEvent, buildDonationCreatedPayload } from './eventDelivery.js';
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
}: ProcessDonationOptions) {
  const normalizedEmail = email.trim().toLowerCase();
  // Shipping is passed through to Stripe, not donated — exclude it from the
  // spendable wallet balance (but keep the full amount in total_donated).
  const creditedCents = amountCents - shippingCents;

  let result: {
    donor: { id: string; magic_token: string | null; email: string; balance_remaining: number };
    donation: { id: string; external_id: string };
    pledge: Awaited<ReturnType<typeof fulfillPledge>> | null;
  } | null = null;
  try {
    result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

      const donation = await tx.donation.create({
        data: {
          external_id: externalId,
          donor_id: donor.id,
          amount_cents: amountCents,
          donor_name: donorName,
          comment: comment ?? null,
          channel_id: channelId ?? null,
        },
      });

      let pledgeResult: Awaited<ReturnType<typeof fulfillPledge>> | null = null;
      try {
        const pledge = await resolvePledge({
          pledgeToken,
          email: normalizedEmail,
          amountCents,
        });
        if (pledge) {
          pledgeResult = await fulfillPledge(tx, pledge, donor.id);
          await tx.donation.update({
            where: { id: donation.id },
            data: {
              pledge: { connect: { id: pledge.id } },
              ...(pledge.comment ? { comment: pledge.comment } : {}),
              ...(pledge.channel_id ? { channel_id: pledge.channel_id } : {}),
            },
          });
        }
      } catch (pledgeErr) {
        console.error('Pledge fulfillment error (non-fatal):', pledgeErr);
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

  emitWebhookEvent(
    'donation.created',
    buildDonationCreatedPayload({
      donationId: result!.donation.id,
      externalId,
      amountCents,
      channelId: channelId ?? null,
      donorRef: result!.donor.id,
    }),
  );

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
