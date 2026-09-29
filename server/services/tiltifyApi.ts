import type { Channel, Event, Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import prisma from '../lib/prisma.js';
import { channelTotalCents, eventTotalCents } from '../lib/donationTotals.js';
import { money, tiltifyCurrency } from './webhooks/tiltifyPayload.js';

/**
 * The Tiltify-compatible REST API (PRD-0002 §R, ADR-0010): the read routes that
 * kollekt and esa-layouts-v2 used to call on ESATiltifyBridge. Responses are BARE
 * Tiltify-v5 objects and arrays (the bridge unwrapped Tiltify's `{ data }`).
 *
 * A Tiltify "campaign" is our Channel; the "team campaign" is our Event. A shared
 * incentive (`channel_id = null`) is listed under EVERY Channel, and the Event lists
 * no incentives of its own: kollekt only knows Channels (from `campaign_id` on a
 * donation), and layouts concatenates Event + Channel lists, so listing under both
 * would show it twice (#117).
 *
 * An unknown campaign or poll id throws `httpError(404)`.
 */

/** A Tiltify campaign id resolved to our identity: a Channel, or an Event (team campaign). */
type TiltifyCampaign = { kind: 'channel'; row: Channel } | { kind: 'event'; row: Event };

/** Prisma `where` for the incentives listed under a Channel: its own plus the shared ones. */
type IncentiveScope = { OR: Array<{ channel_id: string | null }> };

const iso = (d: Date) => d.toISOString();

/**
 * A Channel or an Event by id; 404 when neither. Inactive ones still resolve:
 * kollekt keeps old campaigns.
 */
async function resolveCampaign(id: string): Promise<TiltifyCampaign> {
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (channel) return { kind: 'channel', row: channel };
  const event = await prisma.event.findUnique({ where: { id } });
  if (event) return { kind: 'event', row: event };
  throw httpError(404, 'Campaign not found');
}

/** The incentive scope of a campaign, or null for an Event (it lists none of its own). */
async function incentiveScope(id: string): Promise<IncentiveScope | null> {
  const campaign = await resolveCampaign(id);
  if (campaign.kind === 'event') return null;
  return { OR: [{ channel_id: campaign.row.id }, { channel_id: null }] };
}

/** `campaigns/{id}`: a Channel (with `team_id` = its Event) or an Event (`team_id: null`). */
export async function getCampaign(id: string) {
  const campaign = await resolveCampaign(id);
  const { row } = campaign;
  const raised = money(
    campaign.kind === 'channel'
      ? await channelTotalCents(prisma, row.id)
      : await eventTotalCents(prisma, row.id),
  );
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    team_id: campaign.kind === 'channel' ? campaign.row.event_id : null,
    currency_code: tiltifyCurrency(),
    amount_raised: raised,
    total_amount_raised: raised,
    status: row.is_active ? 'published' : 'retired',
    inserted_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** `campaign/{id}/rewards`. `amount` is the cost; `quantity_remaining` is null when unlimited. */
export async function listRewards(id: string) {
  const where = await incentiveScope(id);
  if (!where) return [];
  const rewards = await prisma.reward.findMany({ where, orderBy: { created_at: 'asc' } });
  return rewards.map((r) => ({
    id: r.id,
    name: r.title,
    description: r.description,
    active: r.is_active,
    amount: money(r.cost_cents),
    quantity: r.quantity_total,
    quantity_remaining:
      r.quantity_total == null ? null : Math.max(0, r.quantity_total - r.quantity_claimed),
    inserted_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }));
}

/** `campaign/{id}/targets`: our FundGoals. `amount` is the target, `amount_raised` the progress. */
export async function listTargets(id: string) {
  const where = await incentiveScope(id);
  if (!where) return [];
  const goals = await prisma.fundGoal.findMany({ where, orderBy: { created_at: 'asc' } });
  return goals.map((g) => ({
    id: g.id,
    name: g.title,
    active: g.is_active,
    amount: money(g.target_cents),
    amount_raised: money(g.current_cents),
    inserted_at: iso(g.created_at),
    updated_at: iso(g.updated_at),
  }));
}

const pollInclude = {
  // Only approved options: a write-in awaiting approval (or rejected) is not public.
  // Most-voted first, like the public poll list (routes/polls.ts).
  options: { where: { status: 'ACTIVE' }, orderBy: { votes_cents: 'desc' as const } },
} satisfies Prisma.PollInclude;

type PollRow = Prisma.PollGetPayload<{ include: typeof pollInclude }>;

function tiltifyPoll(p: PollRow, now: Date) {
  return {
    id: p.id,
    name: p.title,
    active: p.is_active && (!p.ends_at || p.ends_at > now),
    amount_raised: money(p.total_votes_cents),
    inserted_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
    options: p.options.map((o) => ({
      id: o.id,
      name: o.label,
      amount_raised: money(o.votes_cents),
    })),
  };
}

/** `campaign/{id}/polls`. */
export async function listPolls(id: string) {
  const where = await incentiveScope(id);
  if (!where) return [];
  const polls = await prisma.poll.findMany({
    where,
    include: pollInclude,
    orderBy: { created_at: 'asc' },
  });
  const now = new Date();
  return polls.map((p) => tiltifyPoll(p, now));
}

/** `campaign/{id}/polls/{poll_id}`: 404 unless the poll is listed under that campaign. */
export async function getPoll(id: string, pollId: string) {
  const where = await incentiveScope(id);
  const poll = where
    ? await prisma.poll.findFirst({ where: { AND: [{ id: pollId }, where] }, include: pollInclude })
    : null;
  if (!poll) throw httpError(404, 'Poll not found');
  return tiltifyPoll(poll, new Date());
}

/** `campaign/{id}/milestones` and `/matches`: we have neither, so `[]` for a known id. */
export async function listMilestonesOrMatches(id: string): Promise<never[]> {
  await resolveCampaign(id);
  return [];
}
