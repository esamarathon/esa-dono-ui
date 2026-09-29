import type { Prisma } from '@prisma/client';
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
 * Every function returns null when the id is unknown (the route answers 404).
 */

type Owner = { kind: 'channel'; id: string; event_id: string } | { kind: 'event'; id: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A Channel or an Event by id. Inactive ones still resolve: kollekt keeps old campaigns. */
async function findOwner(id: string): Promise<Owner | null> {
  const channel = await prisma.channel.findUnique({
    where: { id },
    select: { id: true, event_id: true },
  });
  if (channel) return { kind: 'channel', ...channel };
  const event = await prisma.event.findUnique({ where: { id }, select: { id: true } });
  return event ? { kind: 'event', id: event.id } : null;
}

/** Incentives listed under `owner`: its own + shared for a Channel, none for an Event. */
type ChannelScope = { OR: Array<{ channel_id: string | null }> };

function incentivesOf(owner: Owner): ChannelScope | null {
  if (owner.kind === 'event') return null;
  return { OR: [{ channel_id: owner.id }, { channel_id: null }] };
}

/** `campaigns/{id}`: a Channel (with `team_id` = its Event) or an Event (`team_id: null`). */
export async function getCampaign(id: string) {
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (channel) {
    const raised = money(await channelTotalCents(prisma, channel.id));
    return campaignFact(channel, channel.event_id, raised);
  }
  const event = await prisma.event.findUnique({ where: { id } });
  if (event) {
    const raised = money(await eventTotalCents(prisma, event.id));
    return campaignFact(event, null, raised);
  }
  return null;
}

function campaignFact(
  row: {
    id: string;
    slug: string;
    name: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  },
  teamId: string | null,
  raised: { currency: string; value: string },
) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    team_id: teamId,
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
  const owner = await findOwner(id);
  if (!owner) return null;
  const where = incentivesOf(owner);
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
  const owner = await findOwner(id);
  if (!owner) return null;
  const where = incentivesOf(owner);
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
  options: { where: { status: 'ACTIVE' }, orderBy: { id: 'asc' as const } },
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
  const owner = await findOwner(id);
  if (!owner) return null;
  const where = incentivesOf(owner);
  if (!where) return [];
  const polls = await prisma.poll.findMany({
    where,
    include: pollInclude,
    orderBy: { created_at: 'asc' },
  });
  const now = new Date();
  return polls.map((p) => tiltifyPoll(p, now));
}

/** `campaign/{id}/polls/{poll_id}`: null unless the poll is listed under that campaign. */
export async function getPoll(id: string, pollId: string) {
  const owner = await findOwner(id);
  if (!owner) return null;
  const where = incentivesOf(owner);
  if (!where) return null;
  const poll = await prisma.poll.findFirst({
    where: { AND: [{ id: pollId }, where] },
    include: pollInclude,
  });
  return poll ? tiltifyPoll(poll, new Date()) : null;
}

/** `campaign/{id}/milestones` and `/matches`: we have neither, so `[]` for a known id. */
export async function listNone(id: string) {
  return (await findOwner(id)) ? [] : null;
}
