import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { sendMagicLink } from './email.js';
import { resolvePledge, fulfillPledge } from './pledge.js';
import { TOKEN_TTL_MS } from '../config.js';

interface ProcessDonationOptions {
  tiltifyId: string;
  email: string;
  donorName: string;
  amountCents: number;
  comment?: string | null;
  pledgeToken?: string | null;
}

/**
 * Shared donation processing — used by both the Tiltify webhook
 * and the admin simulation endpoint.
 *
 * Idempotent: if tiltifyId already exists, returns { duplicate: true }
 * without crediting balance or sending email.
 *
 * Stable token: existing donors keep their magic_token (not rotated).
 * Only new donors get a fresh token. TTL is extended on repeat donations.
 *
 * If pledgeToken is provided (or resolvable by email+amount), the pledge
 * items are auto-fulfilled from the credited balance. Remainder stays as
 * spendable balance_remaining.
 *
 * @param {string}  options.tiltifyId
 * @param {string}  options.email
 * @param {string}  options.donorName
 * @param {number}  options.amountCents
 * @param {string}  [options.comment]
 * @param {string}  [options.pledgeToken] - optional pledge token to fulfill
 * @returns {{ donor, token, pledge? }} | {{ duplicate: true }}
 */
export async function processDonation({
  tiltifyId,
  email,
  donorName,
  amountCents,
  comment,
  pledgeToken,
}: ProcessDonationOptions) {
  const normalizedEmail = email.trim().toLowerCase();

  const moderatorEmails = (process.env.MODERATOR_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase());
  const isModerator = moderatorEmails.includes(normalizedEmail);

  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

      const donor = await tx.donor.upsert({
        where: { email: normalizedEmail },
        update: {
          total_donated: { increment: amountCents },
          balance_remaining: { increment: amountCents },
          token_expires_at: tokenExpiresAt,
          ...(isModerator ? { is_moderator: true } : {}),
        },
        create: {
          email: normalizedEmail,
          total_donated: amountCents,
          balance_remaining: amountCents,
          magic_token: token,
          token_expires_at: tokenExpiresAt,
          is_moderator: isModerator,
        },
      });

      const donation = await tx.donation.create({
        data: {
          tiltify_id: tiltifyId,
          donor_id: donor.id,
          amount_cents: amountCents,
          donor_name: donorName,
          comment,
        },
      });

      // Try to resolve and fulfill a pledge
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
            data: { pledge: { connect: { id: pledge.id } } },
          });
        }
      } catch (pledgeErr) {
        console.error('Pledge fulfillment error (non-fatal):', pledgeErr);
      }

      sendMagicLink(normalizedEmail, donor.magic_token!).catch((err) =>
        console.error('Email error:', err),
      );

      return { donor, token: donor.magic_token, pledge: pledgeResult };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }
}

/**
 * Check text against the global blocked-words dictionary.
 * Returns an error message string if a blocked word is found, or null if clean.
 * @deprecated import from './blockedWords.js' directly; re-exported here for
 * backward compatibility with existing callers.
 */
export { checkBlockedWords } from './blockedWords.js';
