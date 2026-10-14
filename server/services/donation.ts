import crypto from 'crypto';
import type { Donation, Donor, Prisma } from '@prisma/client';
import { sendMagicLink } from './email.js';
import { PLEDGE_TTL_MS, TOKEN_TTL_MS } from '../config.js';
import { withWebhooks } from './webhooks/outbox.js';
import { resolveDonationRoute } from './routing.js';
import { withSpan } from '../lib/tracing.js';
import { claimRewardTx, votePollTx, contributeGoalTx, proposeCustomEntryTx } from './spend.js';

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
  | (PaymentFacts & { source: 'stripe'; shippingCents?: number })
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
 * Prefactor rules deliberately retained: shipping counts in money but not Wallet
 * credit; wallet-only pledges still count as money and do not increase
 * total_donated; paid-source pledge lookup still falls back to email.
 */
export async function intakeDonation(input: DonationIntake) {
  return withSpan('donation.process', () => intakeDonationInner(input));
}

async function intakeDonationInner(input: DonationIntake) {
  const wallet = input.source === 'wallet';
  const email = wallet ? input.donor.email : input.email.trim().toLowerCase();
  const amountCents = wallet ? input.pledge.total_cents : input.amountCents;
  const shippingCents = input.source === 'stripe' ? (input.shippingCents ?? 0) : 0;
  const externalId = wallet ? `wallet-${crypto.randomUUID()}` : input.externalId;
  let result: {
    donor: Donor;
    donation: Donation;
    pledge: Awaited<ReturnType<typeof fulfillPledge>> | null;
  };

  try {
    result = await withWebhooks(async (tx, _emit, publisher) => {
      // Existing donors retain their token and role. Paid sources extend its TTL.
      // Wallet-only fulfillment spends existing credit, without crediting again.
      const donor = wallet
        ? await tx.donor.findUniqueOrThrow({ where: { id: input.donor.id } })
        : await tx.donor.upsert({
            where: { email },
            update: {
              total_donated: { increment: amountCents },
              balance_remaining: { increment: amountCents - shippingCents },
              token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
            },
            create: {
              email,
              total_donated: amountCents,
              balance_remaining: amountCents - shippingCents,
              magic_token: crypto.randomBytes(32).toString('hex'),
              token_expires_at: new Date(Date.now() + TOKEN_TTL_MS),
            },
          });

      // The pledge's Channel takes precedence over an admin-supplied route.
      let pledge: Pledge | null = wallet ? input.pledge : null;
      if (!wallet) {
        try {
          pledge = await resolvePledge({ pledgeToken: input.pledgeToken, email, amountCents }, tx);
        } catch (pledgeErr) {
          console.error('Pledge resolution error (non-fatal):', pledgeErr);
        }
      }
      const route = await resolveDonationRoute(tx, {
        channelId: pledge?.channel_id ?? (input.source === 'admin' ? input.channelId : null),
        eventId: input.source === 'admin' ? input.eventId : null,
      });
      const donation = await tx.donation.create({
        data: {
          external_id: externalId,
          donor_id: donor.id,
          amount_cents: amountCents,
          donor_name: wallet ? input.pledge.display_name : input.donorName,
          comment: wallet
            ? input.pledge.comment
            : input.source === 'admin'
              ? (input.comment ?? null)
              : null,
          channel_id: route.channelId,
          event_id: route.eventId,
          ...(input.source === 'admin' && input.occurredAt ? { created_at: input.occurredAt } : {}),
        },
      });

      let pledgeResult: Awaited<ReturnType<typeof fulfillPledge>> | null = null;
      if (pledge) {
        const fulfillAndLink = async () => {
          pledgeResult = await fulfillPledge(tx, pledge, donor.id, donation.id);
          await tx.donation.update({
            where: { id: donation.id },
            data: {
              pledge: { connect: { id: pledge.id } },
              ...(pledge.comment ? { comment: pledge.comment } : {}),
              ...(pledge.display_name ? { donor_name: pledge.display_name } : {}),
            },
          });
          if (wallet) {
            await tx.pendingPledge.update({
              where: { id: pledge.id },
              data: { wallet_discount_cents: amountCents },
            });
          }
        };
        // Preserve the paid paths' non-fatal pledge failures. The wallet-only
        // path has no newly paid money and keeps its existing rollback behavior.
        if (wallet) await fulfillAndLink();
        else {
          try {
            await fulfillAndLink();
          } catch (pledgeErr) {
            console.error('Pledge fulfillment error (non-fatal):', pledgeErr);
          }
        }
      }

      await publisher.publish(donation.id, null);
      return { donor, donation, pledge: pledgeResult };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { duplicate: true } as const;
    throw err;
  }

  sendMagicLink(email, result.donor.magic_token!).catch((err) =>
    console.error('Email error:', err),
  );
  return { ...result, token: result.donor.magic_token };
}

/** Fulfill only within intake's transaction; skipped items leave Wallet credit. */
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
  if (pledgeToken) {
    const pledge = await tx.pendingPledge.findUnique({
      where: { pledge_token: pledgeToken },
      include: { items: true },
    });
    if (
      pledge &&
      pledge.status === 'OPEN' &&
      pledge.total_cents <= amountCents + (pledge.wallet_discount_cents ?? 0) &&
      new Date() < pledge.expires_at
    )
      return pledge;
  }

  const cutoff = new Date(Date.now() - PLEDGE_TTL_MS);
  return tx.pendingPledge.findFirst({
    where: {
      donor_email: email,
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
