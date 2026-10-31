import type { PledgePlan, PoolCategory } from '@dono/shared';
import type { DraftSelection } from '../types';

const CATEGORIES: PoolCategory[] = ['reward', 'poll', 'goal'];
const LABELS = { reward: 'rewards', poll: 'polls', goal: 'fund goals' };
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
  previewError = false,
}: {
  plan: PledgePlan;
  selections?: DraftSelection[];
  defaultGoal?: { id: string; title: string } | null;
  previewError?: boolean;
}) {
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
                      + {fmt(auto)} <span aria-label="locked auto-allocation">auto (locked)</span> —
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
          {category === 'goal' && plan.usage_cents.goal === 0 && (
            <p className="font-body text-sm text-off-white/55">
              {fmt(plan.pledge_amount_cents)}{' '}
              <span aria-label="locked auto-allocation">auto (locked)</span> — the Channel's current
              default goal
              {defaultGoal
                ? ` (now: ${defaultGoal.title})`
                : previewError
                  ? ' (live preview unavailable)'
                  : ' (now: no eligible goal; Unused pool money)'}
              . The destination may change when your payment completes.
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
          <dt>Pledge amount</dt>
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
              ? 'Added at payment; outside the pledge and Pools'
              : 'No shipping'}
          </dd>
        </div>
      </dl>
    </>
  );
}
