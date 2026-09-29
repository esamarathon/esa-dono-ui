import type { Prisma } from '@prisma/client';
import { channelTotalCents, eventTotalCents } from '../../lib/donationTotals.js';

/**
 * Tiltify-shaped webhook messages (PRD-0002 §T, ADR-0009) for the consumers that
 * were built for Tiltify: kollekt and esa-layouts-v2. They read BARE Tiltify-v5
 * objects from the `tiltify` topic exchange, so there is no envelope.
 *
 * Consumer facts (kollekt@524f276, esa-layouts-v2@1c8ea49):
 * - every id must parse as a GUID (kollekt `Guid.Parse`), which UUIDs do;
 * - `amount.value` is a decimal STRING (layouts `parseFloat`, kollekt `decimal.Parse`);
 * - `donor_name` must be non-empty or layouts ignores the donation;
 * - layouts removes a known donation whose `donor_name` is `"Anonymous"`, and adds
 *   one only when `completed_at` is present;
 * - kollekt reads `reward_claims[]` and the scalar `poll_id`/`poll_option_id`/`target_id`.
 */

type Tx = Prisma.TransactionClient;

export interface TiltifyMessage {
  messageType: 'tiltify.donation' | 'tiltify.fact.updated';
  routingKey: string;
  payload: Record<string, unknown>;
}

/** The currency of every donation (Stripe charges one currency), upper-cased for Tiltify. */
export function tiltifyCurrency(): string {
  return (process.env.STRIPE_CURRENCY || 'usd').toUpperCase();
}

/**
 * The donor's answer to a reward's question: the raw `claim_data` string (§T4), or
 * null when the claim has none. A claim without fields is stored as `"{}"`, which a
 * consumer would show as a literal answer.
 */
function customQuestion(claimData: string | null): string | null {
  if (!claimData) return null;
  try {
    const parsed: unknown = JSON.parse(claimData);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) return null;
  } catch {
    // Not JSON: pass the text through unchanged.
  }
  return claimData;
}

/** A Tiltify amount: `value` is a decimal string with 2 places (§T2). */
export function money(cents: number) {
  return { currency: tiltifyCurrency(), value: (cents / 100).toFixed(2) };
}

/**
 * The Tiltify donation for `donationId`, or null when it has no Channel (an
 * unassigned donation is not published, PRD-0002 §E6).
 *
 * `hidden` (a moderator removed it from the overlay, §T5): `donor_name` becomes
 * `"Anonymous"`, `donor_comment` null and `completed_at` is OMITTED, so an overlay
 * that shows it removes it, and one that never saw it does not add it.
 */
export async function buildTiltifyDonation(
  tx: Tx,
  donationId: string,
): Promise<TiltifyMessage | null> {
  const donation = await tx.donation.findUnique({
    where: { id: donationId },
    include: {
      channel: { select: { id: true, slug: true, event_id: true } },
      // What the donation actually paid for: a pledge item that failed at
      // fulfilment has no row. Reversed rows are left out.
      reward_claims: { where: { reversed_at: null }, orderBy: { created_at: 'asc' } },
      // A write-in (POLL_CUSTOM) vote counts once its option is approved (ACTIVE).
      poll_votes: {
        where: { reversed_at: null, poll_option: { status: 'ACTIVE' } },
        orderBy: { created_at: 'asc' },
      },
      contributions: { where: { reversed_at: null }, orderBy: { created_at: 'asc' } },
    },
  });
  if (!donation?.channel) return null;

  const hidden = donation.hidden_from_overlay;
  const votes = donation.poll_votes.map((v) => ({
    poll_id: v.poll_id,
    poll_option_id: v.poll_option_id,
  }));
  const contributions = donation.contributions.map((c) => ({
    target_id: c.goal_id,
    amount: money(c.amount_cents),
  }));
  const claims = donation.reward_claims.map((c) => ({
    id: c.id,
    reward_id: c.reward_id,
    quantity: 1,
    custom_question: customQuestion(c.claim_data),
  }));
  const createdAt = donation.created_at.toISOString();

  const payload: Record<string, unknown> = {
    id: donation.id,
    amount: { ...money(donation.amount_cents), value_cents: donation.amount_cents },
    donor_name: hidden ? 'Anonymous' : donation.donor_name?.trim() || 'Anonymous',
    donor_comment: hidden ? null : (donation.comment ?? null),
    created_at: createdAt,
    ...(hidden ? {} : { completed_at: createdAt }),
    campaign_id: donation.channel.id,
    team_event_id: donation.channel.event_id,
    // Scalars carry the FIRST item, because kollekt reads them today; the arrays
    // carry the full set (kollekt#35 moves kollekt to the arrays).
    reward_id: claims[0]?.reward_id ?? null,
    reward_claims: claims,
    poll_id: votes[0]?.poll_id ?? null,
    poll_option_id: votes[0]?.poll_option_id ?? null,
    poll_votes: votes,
    target_id: contributions[0]?.target_id ?? null,
    target_contributions: contributions,
  };
  return {
    messageType: 'tiltify.donation',
    routingKey: `${donation.channel.slug}.donation`,
    payload,
  };
}

/**
 * The Tiltify totals ("fact") messages for a Channel and its Event (§T7): one
 * each, because consumers match a total on its `id`. `total_amount_raised`
 * follows the money-total rule (lib/donationTotals.ts).
 */
export async function buildTiltifyTotals(tx: Tx, channelId: string): Promise<TiltifyMessage[]> {
  const channel = await tx.channel.findUnique({
    where: { id: channelId },
    include: { event: true },
  });
  if (!channel) return [];
  const [channelCents, eventCents] = await Promise.all([
    channelTotalCents(tx, channel.id),
    eventTotalCents(tx, channel.event_id),
  ]);
  const fact = (id: string, slug: string, name: string, cents: number): TiltifyMessage => ({
    messageType: 'tiltify.fact.updated',
    routingKey: `${slug}.fact.updated`,
    payload: { id, slug, name, total_amount_raised: money(cents) },
  });
  return [
    fact(channel.id, channel.slug, channel.name, channelCents),
    fact(channel.event.id, channel.event.slug, channel.event.name, eventCents),
  ];
}
