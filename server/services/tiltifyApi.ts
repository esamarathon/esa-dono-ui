import type { Channel, Event, FundGoal, Prisma, Reward } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import prisma from '../lib/prisma.js';
import { channelTotalCents, eventTotalCents } from '../lib/donationTotals.js';
import { incentiveOwnerId } from '@dono/shared';
import { money, tiltifyCurrency } from './webhooks/tiltifyPayload.js';

/**
 * The Tiltify-compatible REST API (PRD-0002 §R, ADR-0010): the read routes that
 * kollekt and esa-layouts-v2 used to call on ESATiltifyBridge. Responses are BARE
 * Tiltify-v5 objects and arrays (the bridge unwrapped Tiltify's `{ data }`).
 *
 * A Tiltify "campaign" is our Channel; the "team campaign" is our Event. A shared
 * incentive (`channel_id = null`) belongs to its Event (ADR-0012). Like a Tiltify
 * team-level incentive, the Event (team campaign) lists it. Every Channel of that
 * Event lists it too, for consumers that read only Channel lists; layouts reads
 * both and keeps each id once (esa-layouts-v2#9).
 *
 * Optional ESA `/lookup/` routes alone return `{ campaign_id, incentive }` for any
 * incentive of the context Event, including history. `campaign_id` is the owner:
 * the Channel, or the Event for a shared incentive. Ordinary lists and poll detail
 * retain their narrower scope.
 *
 * An unknown or out-of-scope id throws `httpError(404)`.
 */

/** A Tiltify campaign id resolved to our identity: a Channel, or an Event (team campaign). */
type TiltifyCampaign = { kind: 'channel'; row: Channel } | { kind: 'event'; row: Event };

/** Prisma `where` for the incentives a campaign lists. */
type IncentiveScope =
  | { event_id: string; OR: Array<{ channel_id: string | null }> }
  | { event_id: string; channel_id: null };

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

/** A Channel lists its own and its Event's shared incentives; an Event lists its shared ones. */
async function incentiveScope(id: string): Promise<IncentiveScope> {
  const campaign = await resolveCampaign(id);
  if (campaign.kind === 'event') return { event_id: campaign.row.id, channel_id: null };
  return {
    event_id: campaign.row.event_id,
    OR: [{ channel_id: campaign.row.id }, { channel_id: null }],
  };
}

/** Optional ESA by-id lookups allow any incentive of the context Event. */
async function lookupScope(id: string) {
  const campaign = await resolveCampaign(id);
  return { event_id: campaign.kind === 'channel' ? campaign.row.event_id : campaign.row.id };
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

function tiltifyReward(r: Reward) {
  return {
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
  };
}

/** `campaign/{id}/rewards`. `amount` is the cost; `quantity_remaining` is null when unlimited. */
export async function listRewards(id: string) {
  const where = await incentiveScope(id);
  const rewards = await prisma.reward.findMany({ where, orderBy: { created_at: 'asc' } });
  return rewards.map(tiltifyReward);
}

/** ESA-only envelope; the ordinary Tiltify list keeps its own/shared scope and bare DTOs. */
export async function lookupReward(id: string, rewardId: string) {
  const reward = await prisma.reward.findFirst({
    where: { id: rewardId, ...(await lookupScope(id)) },
  });
  if (!reward) throw httpError(404, 'Reward not found');
  return { campaign_id: incentiveOwnerId(reward), incentive: tiltifyReward(reward) };
}

function tiltifyTarget(g: FundGoal) {
  return {
    id: g.id,
    name: g.title,
    active: g.is_active,
    amount: money(g.target_cents),
    amount_raised: money(g.current_cents),
    inserted_at: iso(g.created_at),
    updated_at: iso(g.updated_at),
  };
}

/** `campaign/{id}/targets`: our FundGoals. `amount` is the target, `amount_raised` the progress. */
export async function listTargets(id: string) {
  const where = await incentiveScope(id);
  const goals = await prisma.fundGoal.findMany({ where, orderBy: { created_at: 'asc' } });
  return goals.map(tiltifyTarget);
}

/** ESA-only target lookup in the context Event, including inactive history. */
export async function lookupTarget(id: string, targetId: string) {
  const goal = await prisma.fundGoal.findFirst({
    where: { id: targetId, ...(await lookupScope(id)) },
  });
  if (!goal) throw httpError(404, 'Target not found');
  return { campaign_id: incentiveOwnerId(goal), incentive: tiltifyTarget(goal) };
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
  const poll = await prisma.poll.findFirst({
    where: { AND: [{ id: pollId }, where] },
    include: pollInclude,
  });
  if (!poll) throw httpError(404, 'Poll not found');
  return tiltifyPoll(poll, new Date());
}

/** ESA-only poll lookup; approved options and active/amount fields use the ordinary builder. */
export async function lookupPoll(id: string, pollId: string) {
  const poll = await prisma.poll.findFirst({
    where: { id: pollId, ...(await lookupScope(id)) },
    include: pollInclude,
  });
  if (!poll) throw httpError(404, 'Poll not found');
  return { campaign_id: incentiveOwnerId(poll), incentive: tiltifyPoll(poll, new Date()) };
}

/** `campaign/{id}/milestones` and `/matches`: we have neither, so `[]` for a known id. */
export async function listMilestonesOrMatches(id: string): Promise<never[]> {
  await resolveCampaign(id);
  return [];
}
