export default function StatusBadge({ active }: { active: boolean | null | undefined }) {
  return (
    <span
      className="font-data text-xs font-bold px-2 py-0.5 rounded-sm"
      style={
        active
          ? { background: 'rgba(92,189,125,.16)', color: 'var(--green)' }
          : { background: 'rgba(252,28,103,.18)', color: 'var(--red)' }
      }
    >
      {active ? 'active' : 'inactive'}
    </span>
  );
}
