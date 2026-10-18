import type { Prisma } from '@prisma/client';
import type {
  CreditAmounts,
  CreditApplyRequest,
  CreditApplyResult,
  CreditEvent,
  CreditEventSummary,
  PoolCategory,
} from '@dono/shared';
import { httpError } from '../lib/httpError.js';
import { claimRewardTx, contributeGoalTx, votePollTx, type CreditSpend } from './spend.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
type Tx = Prisma.TransactionClient;
const categories: PoolCategory[] = ['reward', 'poll', 'goal'];
const zero = (): CreditAmounts => ({ reward: 0, poll: 0, goal: 0 });
const grantSelect = {
  id: true,
  category: true,
  amount_cents: true,
  remaining_cents: true,
  created_at: true,
  donation_id: true,
  donation: {
    select: {
      created_at: true,
      status: true,
      pledge_amount_cents: true,
      payment_refunds: { where: { status: 'REQUESTED' }, select: { id: true } },
    },
  },
} satisfies Prisma.PoolCreditSelect;
async function grantsTx(tx: Tx, donorId: string, eventId: string) {
  const rows = await tx.poolCredit.findMany({
    where: { donation: { donor_id: donorId, event_id: eventId } },
    select: grantSelect,
  });
  return rows.sort(
    (a, b) =>
      a.donation.created_at.getTime() - b.donation.created_at.getTime() ||
      a.donation_id.localeCompare(b.donation_id) ||
      a.created_at.getTime() - b.created_at.getTime() ||
      a.id.localeCompare(b.id),
  );
}
function available(row: Awaited<ReturnType<typeof grantsTx>>[number]) {
  return (
    row.donation.pledge_amount_cents !== null &&
    ['COMPLETED', 'REFUNDED'].includes(row.donation.status) &&
    !row.donation.payment_refunds.length
  );
}
async function summaryTx(tx: Tx, donorId: string, eventId: string): Promise<CreditEventSummary> {
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, slug: true, ended_at: true },
  });
  if (!event) throw httpError(404, 'Event not found');
  const rows = await grantsTx(tx, donorId, eventId);
  const outstanding = zero(),
    spendable = zero();
  for (const row of rows) {
    if (!categories.includes(row.category as PoolCategory)) continue;
    outstanding[row.category as PoolCategory] += row.remaining_cents;
    if (!event.ended_at && available(row))
      spendable[row.category as PoolCategory] += row.remaining_cents;
  }
  return {
    event: { ...event, ended_at: event.ended_at?.toISOString() ?? null },
    outstanding_cents: outstanding,
    available_cents: spendable,
    reasons: { reward: null, poll: null, goal: null },
  };
}
export async function readPoolCreditSummaryTx(tx: Tx, donorId: string) {
  const ids = await tx.donation.findMany({
    where: { donor_id: donorId, event_id: { not: null }, pool_credits: { some: {} } },
    select: { event_id: true },
    distinct: ['event_id'],
  });
  const events = [];
  for (const row of ids) events.push(await readPoolCreditEventTx(tx, donorId, row.event_id!));
  const donor = await tx.donor.findUniqueOrThrow({
    where: { id: donorId },
    select: { balance_remaining: true },
  });
  return {
    wallet_credit_cents: donor.balance_remaining,
    events: events.map(({ catalog: _catalog, history: _history, ...summary }) => summary),
  };
}
export async function readPoolCreditEventTx(
  tx: Tx,
  donorId: string,
  eventId: string,
): Promise<CreditEvent> {
  const summary = await summaryTx(tx, donorId, eventId);
  const scope = { event_id: eventId };
  const channel = { select: { id: true, name: true, slug: true } };
  const [rewards, polls, goals, history] = await Promise.all([
    tx.reward.findMany({
      where: { ...scope, is_active: true, type: { not: 'PHYSICAL' }, cost_cents: { gt: 0 } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        channel,
        cost_cents: true,
        type: true,
        quantity_total: true,
        quantity_claimed: true,
      },
    }),
    tx.poll.findMany({
      where: {
        is_active: true,
        AND: [scope, { OR: [{ ends_at: null }, { ends_at: { gt: new Date() } }] }],
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        channel,
        total_votes_cents: true,
        options: {
          where: { status: 'ACTIVE' },
          select: { id: true, label: true, votes_cents: true },
          orderBy: { id: 'asc' },
        },
      },
    }),
    tx.fundGoal.findMany({
      where: { ...scope, is_active: true, is_complete: false },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, channel, target_cents: true, current_cents: true },
    }),
    tx.poolCredit.findMany({
      where: { donation: { donor_id: donorId, event_id: eventId } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        donation_id: true,
        category: true,
        amount_cents: true,
        remaining_cents: true,
        created_at: true,
        cleared_at: true,
        source_claim: { select: { id: true, reward: { select: { title: true } } } },
        source_vote: { select: { id: true, poll: { select: { title: true } } } },
        source_contribution: { select: { id: true, goal: { select: { title: true } } } },
        redemptions: {
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            amount_cents: true,
            reduced_cents: true,
            created_at: true,
            claim: { select: { id: true, reversed_at: true } },
            vote: { select: { id: true, reversed_at: true } },
            contribution: { select: { id: true, reversed_at: true } },
          },
        },
      },
    }),
  ]);
  const catalog: CreditEvent['catalog'] = {
    rewards: rewards
      .filter((r) => r.quantity_total === null || r.quantity_total > r.quantity_claimed)
      .map(({ quantity_total, quantity_claimed, ...r }) => ({
        ...r,
        remaining: quantity_total === null ? null : quantity_total - quantity_claimed,
      })),
    polls: polls.filter((p) => p.options.length),
    goals,
  };
  for (const category of categories) {
    if (!summary.outstanding_cents[category]) continue;
    summary.reasons[category] = summary.event.ended_at
      ? category === 'reward'
        ? 'Event ended: reward Pool credit expired.'
        : 'Event ended: this Pool credit is now Unused pool money.'
      : summary.available_cents[category] < summary.outstanding_cents[category]
        ? 'Some source credit is unavailable because of its source status or a requested Payment refund.'
        : category === 'reward' &&
            !catalog.rewards.some((r) => r.cost_cents <= summary.available_cents.reward)
          ? 'No affordable open non-physical reward; the remainder stays credit.'
          : (category === 'poll' && !catalog.polls.length) ||
              (category === 'goal' && !catalog.goals.length)
            ? 'No open incentive accepts this category; your credit remains available.'
            : null;
  }
  return {
    ...summary,
    catalog,
    history: history.map(
      ({ source_claim, source_vote, source_contribution, redemptions, ...row }) => ({
        ...row,
        category: row.category as PoolCategory,
        created_at: row.created_at.toISOString(),
        cleared_at: row.cleared_at?.toISOString() ?? null,
        origin: source_claim
          ? { kind: 'claim', id: source_claim.id, title: source_claim.reward.title }
          : source_vote
            ? { kind: 'vote', id: source_vote.id, title: source_vote.poll.title }
            : {
                kind: 'contribution',
                id: source_contribution!.id,
                title: source_contribution!.goal.title,
              },
        redemptions: redemptions.map(({ claim, vote, contribution, ...r }) => ({
          ...r,
          effective_cents: r.amount_cents - r.reduced_cents,
          created_at: r.created_at.toISOString(),
          allocation_id: (claim ?? vote ?? contribution)!.id,
          reversed: !!(claim ?? vote ?? contribution)!.reversed_at,
        })),
      }),
    ),
  };
}

/** Reviewed batch, original-result retry before live checks, and outbox all share ONE write-locked tx. */
export async function applyPoolCreditTx(
  tx: Tx,
  donorId: string,
  eventId: string,
  request: CreditApplyRequest,
  publisher: DonationPublisher,
): Promise<CreditApplyResult> {
  await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
  if (
    !request ||
    typeof request.idempotency_key !== 'string' ||
    !request.idempotency_key.trim() ||
    request.idempotency_key.length > 200
  )
    throw httpError(400, 'A batch idempotency_key is required');
  const requestData = JSON.stringify({
    event_id: eventId,
    reviewed_credit_cents: request.reviewed_credit_cents,
    selections: request.selections,
  });
  const prior = await tx.poolCreditBatch.findUnique({
    where: {
      donor_id_idempotency_key: { donor_id: donorId, idempotency_key: request.idempotency_key },
    },
  });
  if (prior) {
    if (prior.request_data !== requestData)
      throw httpError(409, 'This batch key belongs to a different reviewed selection');
    return JSON.parse(prior.result_data!) as CreditApplyResult;
  }
  const donor = await tx.donor.findUnique({ where: { id: donorId }, select: { is_frozen: true } });
  if (!donor || donor.is_frozen) throw httpError(403, 'Donor unavailable');
  const state = await readPoolCreditEventTx(tx, donorId, eventId);
  if (state.event.ended_at) throw httpError(409, 'Event ended; credits cannot be applied');
  if (
    !request.reviewed_credit_cents ||
    categories.some((c) => request.reviewed_credit_cents[c] !== state.available_cents[c])
  )
    throw httpError(409, 'Pool credit changed; refresh and review again');
  if (
    !Array.isArray(request.selections) ||
    !request.selections.length ||
    request.selections.length > 100
  )
    throw httpError(400, 'Select at least one incentive (maximum 100)');
  const spent = zero(),
    seen = new Set<string>();
  for (const pick of request.selections) {
    if (!pick || typeof pick.target_id !== 'string' || seen.has(`${pick.kind}:${pick.target_id}`))
      throw httpError(400, 'Invalid or duplicate credit selection');
    seen.add(`${pick.kind}:${pick.target_id}`);
    if (pick.kind === 'REWARD') {
      const reward = state.catalog.rewards.find((r) => r.id === pick.target_id);
      if (
        !reward ||
        reward.type !== pick.reward_type ||
        reward.cost_cents !== pick.unit_price_cents ||
        !Number.isSafeInteger(pick.quantity) ||
        pick.quantity < 1 ||
        pick.quantity > 1000 ||
        (reward.remaining !== null && pick.quantity > reward.remaining)
      )
        throw httpError(409, 'Reward price, type or stock changed; refresh and review');
      spent.reward += pick.quantity * pick.unit_price_cents;
    } else if (pick.kind === 'POLL_VOTE' || pick.kind === 'GOAL') {
      if (!Number.isSafeInteger(pick.amount_cents) || pick.amount_cents <= 0)
        throw httpError(400, 'Credit allocations require positive integer cents');
      if (
        pick.kind === 'POLL_VOTE' &&
        !state.catalog.polls.some(
          (p) => p.id === pick.poll_id && p.options.some((o) => o.id === pick.target_id),
        )
      )
        throw httpError(409, 'Poll option closed or changed; refresh and review');
      if (pick.kind === 'GOAL' && !state.catalog.goals.some((g) => g.id === pick.target_id))
        throw httpError(409, 'Goal closed or changed; refresh and review');
      spent[pick.kind === 'GOAL' ? 'goal' : 'poll'] += pick.amount_cents;
    } else throw httpError(400, 'Invalid credit category');
  }
  if (
    categories.some((c) => !Number.isSafeInteger(spent[c]) || spent[c] > state.available_cents[c])
  )
    throw httpError(409, 'Selections exceed available category credit');
  const grants = (await grantsTx(tx, donorId, eventId)).filter(available);
  const ids = [
    ...new Set(
      grants
        .filter((g) => spent[g.category as PoolCategory] > 0 && g.remaining_cents > 0)
        .map((g) => g.donation_id),
    ),
  ];
  const before = await publisher.snapshot(ids);
  const batch = await tx.poolCreditBatch.create({
    data: {
      donor_id: donorId,
      event_id: eventId,
      idempotency_key: request.idempotency_key,
      request_data: requestData,
    },
  });
  const result: CreditApplyResult = {
    batch_id: batch.id,
    spent_cents: spent,
    claim_ids: [],
    vote_ids: [],
    contribution_ids: [],
    donation_ids: [],
  };
  const draw = (category: PoolCategory, cents: number) => {
    const funding: CreditSpend['funding'] = [];
    for (const grant of grants) {
      if (grant.category !== category || !grant.remaining_cents) continue;
      const amount = Math.min(cents, grant.remaining_cents);
      funding.push({ credit_id: grant.id, amount_cents: amount });
      if (!result.donation_ids.includes(grant.donation_id))
        result.donation_ids.push(grant.donation_id);
      grant.remaining_cents -= amount;
      cents -= amount;
      if (!cents) break;
    }
    return funding;
  };
  const mode = (funding: CreditSpend['funding']): CreditSpend => ({
    mode: 'credit',
    source: 'donor',
    batch_id: batch.id,
    event_id: eventId,
    funding,
  });
  for (const pick of request.selections) {
    if (pick.kind === 'REWARD') {
      for (let unit = 0; unit < pick.quantity; unit++) {
        const funded = mode(draw('reward', pick.unit_price_cents));
        const claim = await claimRewardTx(tx, donorId, pick.target_id, null, 1, null, {
          ...funded,
          unit_price_cents: pick.unit_price_cents,
          confirmed_reward_type: pick.reward_type,
        });
        result.claim_ids.push(...claim.claim_ids);
      }
    } else {
      const funding = draw(pick.kind === 'GOAL' ? 'goal' : 'poll', pick.amount_cents);
      // Poll/goal rows stay source-linked. Multiple grants of one source can fund one row.
      for (const id of [
        ...new Set(funding.map((r) => grants.find((g) => g.id === r.credit_id)!.donation_id)),
      ]) {
        const components = funding.filter(
          (r) => grants.find((g) => g.id === r.credit_id)!.donation_id === id,
        );
        const cents = components.reduce((sum, r) => sum + r.amount_cents, 0);
        if (pick.kind === 'GOAL')
          result.contribution_ids.push(
            ...(await contributeGoalTx(tx, donorId, pick.target_id, cents, id, mode(components)))
              .contribution_ids,
          );
        else
          result.vote_ids.push(
            ...(
              await votePollTx(
                tx,
                donorId,
                pick.poll_id,
                pick.target_id,
                cents,
                id,
                mode(components),
              )
            ).vote_ids,
          );
      }
    }
  }
  await publisher.publish(result.donation_ids, before);
  await tx.poolCreditBatch.update({
    where: { id: batch.id },
    data: { result_data: JSON.stringify(result) },
  });
  return result;
}
