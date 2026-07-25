import type { ReactNode } from 'react';

export default function ProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: ReactNode;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      {label && (
        <div className="flex justify-between font-data text-sm text-off-white/55 mb-1">{label}</div>
      )}
      <div className="h-4 rounded-sm overflow-hidden" style={{ background: 'rgba(0,0,0,0.4)' }}>
        <div
          className="h-full rounded-sm transition-all"
          style={{
            width: `${pct}%`,
            background: 'var(--grad)',
          }}
        />
      </div>
    </div>
  );
}
