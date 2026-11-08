import type { Prisma } from '@prisma/client';
import type { PoolCategory } from '@dono/shared';
import { countsTowardTotals } from '../lib/donationTotals.js';
import { computePoolAccounting, type CategoryAmounts } from './poolAccounting.js';

const amounts = (): CategoryAmounts => ({ reward: 0, poll: 0, goal: 0 });
type Labels = { event: string; channel: string };
type Allocation = Labels & { category: PoolCategory; source: string; cents: number };

/**
 * Safe bulk snapshot shared by staff stats and the cached exporter. Use the
 * caller's transaction: no singleton queries or per-donation accounting reads.
 * Incentive scope and source-donation scope are deliberately kept separate.
 */
export async function readAccountingStatsTx(tx: Prisma.TransactionClient, now = new Date()) {
  const [
    donors,
    donations,
    events,
    channels,
    claims,
    votes,
    polls,
    contributions,
    goals,
    credits,
    pendingEntries,
    activeRewards,
    openPledges,
    overduePledges,
    refundGroups,
  ] = await Promise.all([
    tx.donor.aggregate({
      _count: true,
      _sum: { balance_remaining: true, balance_held_cents: true },
    }),
    tx.donation.findMany({
      select: {
        id: true,
        event_id: true,
        channel_id: true,
        status: true,
        amount_cents: true,
        pledge_amount_cents: true,
        failed_payment_wallet_credit_cents: true,
        comment: true,
      },
    }),
    tx.event.findMany({ select: { id: true, slug: true, ended_at: true, is_active: true } }),
    tx.channel.findMany({
      orderBy: { created_at: 'asc' },
      select: { id: true, name: true, slug: true, event_id: true, is_active: true },
    }),
    tx.rewardClaim.findMany({
      where: { reversed_at: null, status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] } },
      select: {
        donation_id: true,
        amount_cents: true,
        reward: { select: { channel_id: true } },
        credit_redemptions: {
          select: {
            amount_cents: true,
            reduced_cents: true,
            credit: { select: { donation_id: true } },
          },
        },
      },
    }),
    tx.pollVote.groupBy({
      by: ['donation_id', 'poll_id', 'source'],
      where: { reversed_at: null },
      _sum: { amount_cents: true },
      _count: true,
    }),
    tx.poll.findMany({ select: { id: true, channel_id: true, is_active: true } }),
    tx.fundContribution.groupBy({
      by: ['donation_id', 'goal_id', 'source'],
      where: { reversed_at: null },
      _sum: { amount_cents: true },
    }),
    tx.fundGoal.findMany({ select: { id: true, channel_id: true, is_active: true } }),
    tx.poolCredit.groupBy({ by: ['donation_id', 'category'], _sum: { remaining_cents: true } }),
    tx.pollCustomEntry.count({ where: { status: 'PENDING' } }),
    tx.reward.count({ where: { is_active: true } }),
    tx.pendingPledge.count({ where: { status: 'OPEN' } }),
    tx.pendingPledge.count({
      where: {
        status: 'OPEN',
        expires_at: { lt: now },
        OR: [{ checkout_session_status: null }, { checkout_session_status: { not: 'complete' } }],
      },
    }),
    tx.paymentRefund.groupBy({ by: ['status'], _count: true, _min: { created_at: true } }),
  ]);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const labels = (eventId: string | null, channelId: string | null): Labels => ({
    event: (eventId && eventById.get(eventId)?.slug) || '',
    channel: (channelId && channelById.get(channelId)?.slug) || '',
  });
  const incentiveLabels = (channelId: string | null) =>
    labels(channelId ? (channelById.get(channelId)?.event_id ?? null) : null, channelId);
  const countByChannel = (rows: { channel_id: string | null; count: number }[]) => {
    const totals = new Map<string, Labels & { count: number }>();
    for (const row of rows) {
      const scope = incentiveLabels(row.channel_id);
      const key = JSON.stringify(scope);
      const entry = totals.get(key) ?? { ...scope, count: 0 };
      entry.count += row.count;
      totals.set(key, entry);
    }
    return [...totals.values()];
  };
  const live = new Map<string, CategoryAmounts>();
  const allocationTotals = new Map<string, Allocation>();
  const allocatedByChannel = new Map<string | null, CategoryAmounts>();
  const add = (
    donationId: string | null,
    channelId: string | null,
    category: PoolCategory,
    source: string,
    cents: number,
  ) => {
    if (donationId) {
      const usage = live.get(donationId) ?? amounts();
      usage[category] += cents;
      live.set(donationId, usage);
    }
    const allocated = allocatedByChannel.get(channelId) ?? amounts();
    allocated[category] += cents;
    allocatedByChannel.set(channelId, allocated);
    const scope = incentiveLabels(channelId);
    const key = JSON.stringify([scope.event, scope.channel, category, source]);
    const entry = allocationTotals.get(key) ?? { ...scope, category, source, cents: 0 };
    entry.cents += cents;
    allocationTotals.set(key, entry);
  };
  for (const claim of claims) {
    // Redemption components own finances; the single claim owns entitlement count.
    if (claim.credit_redemptions.length) {
      for (const component of claim.credit_redemptions)
        add(
          component.credit.donation_id,
          claim.reward.channel_id,
          'reward',
          'donor',
          component.amount_cents - component.reduced_cents,
        );
    } else add(claim.donation_id, claim.reward.channel_id, 'reward', 'donor', claim.amount_cents);
  }
  const pollById = new Map(polls.map((p) => [p.id, p]));
  for (const vote of votes)
    add(
      vote.donation_id,
      pollById.get(vote.poll_id)?.channel_id ?? null,
      'poll',
      vote.source,
      vote._sum.amount_cents ?? 0,
    );
  const goalById = new Map(goals.map((g) => [g.id, g]));
  for (const row of contributions)
    add(
      row.donation_id,
      goalById.get(row.goal_id)?.channel_id ?? null,
      'goal',
      row.source,
      row._sum.amount_cents ?? 0,
    );

  const perChannel = channels.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    event_id: c.event_id,
    raised_cents: 0,
    donations: 0,
    pledged_cents: 0,
    allocated_cents: allocatedByChannel.get(c.id) ?? amounts(),
    unused_pool_cents: { poll: 0, goal: 0 },
    pool_credit_cents: amounts(),
  }));
  const statsByChannel = new Map(perChannel.map((c) => [c.id, c]));
  const outstanding = new Map<string, CategoryAmounts>();
  for (const row of credits) {
    const credit = outstanding.get(row.donation_id) ?? amounts();
    credit[row.category as PoolCategory] += row._sum.remaining_cents ?? 0;
    outstanding.set(row.donation_id, credit);
  }
  const unusedGroup = () => ({ donations: 0, cents: { poll: 0, goal: 0 } });
  const unusedPool = { with_comment: unusedGroup(), all: unusedGroup() };
  const donationScopes = new Map<
    string,
    Labels & {
      donations: number;
      money_cents: number;
      unused_cents: { poll: number; goal: number };
      credit_cents: CategoryAmounts;
    }
  >();
  let raised = 0,
    pledged = 0;
  for (const donation of donations) {
    const counted = countsTowardTotals(donation.status);
    const money = counted ? donation.amount_cents : 0;
    const pledge = counted ? (donation.pledge_amount_cents ?? 0) : 0;
    raised += money;
    pledged += pledge;
    const pools = computePoolAccounting({
      ...donation,
      event_ended: !!(donation.event_id && eventById.get(donation.event_id)?.ended_at),
      live_cents: live.get(donation.id) ?? amounts(),
      outstanding_credit_cents: outstanding.get(donation.id) ?? amounts(),
    });
    const scope = labels(donation.event_id, donation.channel_id);
    const scopeKey = JSON.stringify(scope);
    const scoped = donationScopes.get(scopeKey) ?? {
      ...scope,
      donations: 0,
      money_cents: 0,
      unused_cents: { poll: 0, goal: 0 },
      credit_cents: amounts(),
    };
    scoped.donations++;
    scoped.money_cents += money;
    for (const category of ['poll', 'goal'] as const)
      scoped.unused_cents[category] += pools[category].unused_cents;
    for (const category of ['reward', 'poll', 'goal'] as const)
      scoped.credit_cents[category] += pools[category].pool_credit_cents;
    donationScopes.set(scopeKey, scoped);
    const channel = donation.channel_id ? statsByChannel.get(donation.channel_id) : undefined;
    if (channel) {
      channel.raised_cents += money;
      channel.donations++;
      channel.pledged_cents += pledge;
      for (const category of ['poll', 'goal'] as const)
        channel.unused_pool_cents[category] += pools[category].unused_cents;
      for (const category of ['reward', 'poll', 'goal'] as const)
        channel.pool_credit_cents[category] += pools[category].pool_credit_cents;
    }
    if (
      donation.event_id &&
      !eventById.get(donation.event_id)?.ended_at &&
      (pools.poll.unused_cents > 0 || pools.goal.unused_cents > 0)
    ) {
      for (const group of [
        unusedPool.all,
        ...(donation.comment?.trim() ? [unusedPool.with_comment] : []),
      ]) {
        group.donations++;
        group.cents.poll += pools.poll.unused_cents;
        group.cents.goal += pools.goal.unused_cents;
      }
    }
  }
  const paymentRefunds = {
    requested: 0,
    pending: 0,
    requires_action: 0,
    succeeded: 0,
    failed: 0,
    resolved: 0,
  };
  for (const row of refundGroups)
    paymentRefunds[row.status.toLowerCase() as keyof typeof paymentRefunds] = row._count;
  const oldestRequested = refundGroups.find((row) => row.status === 'REQUESTED')?._min.created_at;
  return {
    donation_channels: [...donationScopes.values()],
    claim_channels: countByChannel(
      claims.map((c) => ({ channel_id: c.reward.channel_id, count: 1 })),
    ),
    vote_channels: countByChannel(
      votes.map((v) => ({
        channel_id: pollById.get(v.poll_id)?.channel_id ?? null,
        count: v._count,
      })),
    ),
    poll_votes: votes.reduce((sum, v) => sum + v._count, 0),
    active_events: events.filter((e) => e.is_active).length,
    active_channels: channels.filter((c) => c.is_active).length,
    unassigned_donations: donations.filter((d) => !d.event_id && !d.channel_id).length,
    payment_refunds: paymentRefunds,
    oldest_requested_age_seconds: oldestRequested
      ? Math.max(0, (now.getTime() - oldestRequested.getTime()) / 1000)
      : 0,
    moderator: {
      pending_entries: pendingEntries,
      active_polls: polls.filter((p) => p.is_active).length,
      total_rewards: activeRewards,
      total_goals: goals.filter((g) => g.is_active).length,
      unused_pool: unusedPool,
    },
    admin: {
      donors: donors._count,
      donations: donations.length,
      claims: claims.length,
      pledges: { open: openPledges, overdue: overduePledges },
      payment_refunds: { requested: paymentRefunds.requested, failed: paymentRefunds.failed },
      total_raised_cents: raised,
      pledged_cents: pledged,
      wallet_credit_cents: {
        available: donors._sum.balance_remaining ?? 0,
        held: donors._sum.balance_held_cents ?? 0,
      },
      channels: perChannel,
      shared: { allocated_cents: allocatedByChannel.get(null) ?? amounts() },
    },
    allocations: [...allocationTotals.values()],
  };
}
