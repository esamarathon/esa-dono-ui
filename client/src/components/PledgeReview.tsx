import { previewGoalCap, type PledgePlan, type PoolCategory } from '@dono/shared';
import type { DraftSelection } from '../types';

type GoalChain = Array<{ id: string; title: string; remaining_cents: number }>;

const CATEGORIES: PoolCategory[] = ['reward', 'poll', 'goal'];
const LABELS = { reward: 'Rewards', poll: 'Polls', goal: 'Fund goals' };
function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
function categoryFor(kind: string): PoolCategory {
  return kind === 'REWARD' ? 'reward' : kind === 'GOAL' ? 'goal' : 'poll';
}

/** Pending review uses only the immutable server plan, never live catalog prices. */
export default function PledgeReview({
  plan,
  selections = [],
  defaultGoal,
  defaultGoalChain = [],
  goalRemaining,
  previewError = false,
}: {
  plan: PledgePlan;
  selections?: DraftSelection[];
  defaultGoal?: { id: string; title: string } | null;
  defaultGoalChain?: GoalChain;
  /** Live remaining need per goal, so the review can model the target cap (#201). */
  goalRemaining?: Record<string, number>;
  previewError?: boolean;
}) {
  // Only model the cap when every selected goal's live need is known; a stale
  // or empty catalog must not read as "this goal is full".
  const cap =
    goalRemaining && plan.selections.every((s) => s.kind !== 'GOAL' || s.target_id in goalRemaining)
      ? previewGoalCap(plan, goalRemaining)
      : null;
  const goalTitle = (id: string) =>
    selections.find((item) => item.kind === 'GOAL' && item.target_id === id)?.label ??
    defaultGoalChain.find((row) => row.id === id)?.title ??
    defaultGoal?.title ??
    id;
  return (
    <>
      {CATEGORIES.map((category) => (
        <section
          key={category}
          aria-label={`${LABELS[category]} review`}
          className="btrl-panel p-4 mb-3"
        >
          <h3 className="font-data font-bold uppercase mb-2">{LABELS[category]} Pool</h3>
          {plan.selections.map((s, index) => {
            if (categoryFor(s.kind) !== category) return null;
            const auto =
              plan.top_up_rows.find((r) => r.selection_index === index)?.amount_cents ?? 0;
            const label = selections.find(
              (i) => i.kind === s.kind && i.target_id === s.target_id,
            )?.label;
            return (
              <div key={index} className="mb-2 font-data text-sm">
                <span>
                  {s.quantity > 1 ? `${s.quantity}× ` : ''}
                  {label ??
                    (s.kind === 'POLL_CUSTOM'
                      ? (s.data as { label?: string } | null)?.label
                      : null) ??
                    s.target_id}
                </span>
                <span className="ml-3">
                  {fmt(s.amount_cents)}
                  {auto > 0 && (
                    <>
                      {' '}
                      + {fmt(auto)} <span aria-label="Locked auto-allocation">auto (locked)</span> —
                      topped up in proportion
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {category === 'reward' && (
            <p className="font-body text-sm text-off-white/55">
              Unused reward Pool:{' '}
              {fmt(Math.max(0, plan.pledge_amount_cents - plan.usage_cents.reward))}. Not returned
              as Wallet credit.
            </p>
          )}
          {category === 'poll' && plan.usage_cents.poll === 0 && (
            <p className="font-body text-sm text-off-white/55">
              Unused poll money: {fmt(plan.pledge_amount_cents)}. Polls have no default.
            </p>
          )}
          {category === 'goal' &&
            cap?.rows.map((row) =>
              row.capped ? (
                <p
                  key={row.goal_id}
                  aria-label="Goal target cap"
                  className="font-body text-sm text-off-white/55"
                >
                  {goalTitle(row.goal_id)} is capped at {fmt(row.donor_cents + row.auto_cents)} of{' '}
                  {fmt(row.intended_cents)}: the goal only needs{' '}
                  {fmt(goalRemaining?.[row.goal_id] ?? 0)} more. The rest continues as{' '}
                  <span aria-label="Locked auto-allocation">auto (locked)</span>.
                </p>
              ) : null,
            )}
          {category === 'goal' && (cap?.continuation_cents ?? 0) > 0 && (
            <p className="font-body text-sm text-off-white/55">
              {fmt(cap!.continuation_cents)} continues to your other fund goals in proportion, then
              the Channel's default goal
              {defaultGoalChain.length ? ` (now: ${defaultGoalChain[0]!.title})` : ''}; anything no
              goal can take becomes Unused pool money.
            </p>
          )}
          {category === 'goal' && plan.usage_cents.goal === 0 && (
            <p className="font-body text-sm text-off-white/55">
              {fmt(plan.pledge_amount_cents)}{' '}
              <span aria-label="Locked auto-allocation">auto (locked)</span> — the Channel's current
              default goal
              {defaultGoal && defaultGoalChain.length
                ? ` (now: ${defaultGoalChain
                    .slice(0, 2)
                    .map((row) => `${row.title}, ${fmt(row.remaining_cents)} to its target`)
                    .join('; then ')})`
                : defaultGoal
                  ? ` (now: ${defaultGoal.title})`
                  : previewError
                    ? ' (live preview unavailable)'
                    : ' (now: no eligible goal; Unused pool money)'}
              . Each goal is funded only up to its target. The destination may change when your
              payment completes.
            </p>
          )}
          {category !== 'reward' && plan.usage_cents[category] > 0 && (
            <p className="font-body text-sm text-off-white/55">
              Selections are subject to availability when payment completes.
            </p>
          )}
          {category !== 'reward' && (
            <p className="font-body text-sm text-off-white/55">
              Unused pool money does not become spendable Wallet credit.
            </p>
          )}
        </section>
      ))}
      <dl className="btrl-panel p-4 mb-4 font-data text-sm space-y-2">
        <div className="flex justify-between">
          <dt>Donation amount</dt>
          <dd className="text-d-yellow">{fmt(plan.pledge_amount_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Wallet credit applied</dt>
          <dd>{fmt(plan.wallet_applied_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>New money charged</dt>
          <dd className="text-d-yellow">{fmt(plan.new_money_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Shipping (separate)</dt>
          <dd>
            {plan.requires_shipping
              ? 'Added at payment; outside the donation and Pools'
              : 'No shipping'}
          </dd>
        </div>
      </dl>
    </>
  );
}
