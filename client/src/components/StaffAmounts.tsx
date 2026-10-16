import { fmt } from '../utils/money';
export function AllocationSources({ row }: { row: import('../types').IncentiveAllocation }) {
  const sources = row.allocated_source_cents;
  if (!sources || (!sources.auto && !sources.moderator)) return null;
  return (
    <p className="font-data text-xs text-off-white/55">
      donor {fmt(sources.donor)} · auto {fmt(sources.auto)} · moderator {fmt(sources.moderator)}{' '}
      allocated
    </p>
  );
}
export function GoalDefaults({
  id,
  channels,
}: {
  id: string;
  channels: import('../types').Channel[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {channels
        .filter((c) => c.default_goals?.includes(id))
        .map((c) => (
          <span key={c.id} className="font-mono text-xs text-off-white/55">
            {c.name} default #{c.default_goals!.indexOf(id) + 1}
          </span>
        ))}
    </div>
  );
}
export function NotMoneyNote() {
  return (
    <p className="font-body text-xs text-off-white/55 italic">
      Incentive amounts are not money: one dollar can count once in rewards, once in polls and once
      in goals.
    </p>
  );
}
export function Amount({
  cents,
  label,
  money = false,
}: {
  cents: number;
  label: string;
  money?: boolean;
}) {
  return (
    <span className={`font-data ${money ? 'text-d-yellow' : 'text-off-white'}`}>
      {label}: {fmt(cents)}
    </span>
  );
}
