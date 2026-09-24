import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ProgressBarProps {
  value: number;
  max: number;
  label?: ReactNode;
  animateOnChange?: boolean;
  /**
   * Donation-impact preview (#52): the percentage (0-100) the bar would
   * reach if the donor's currently pending cart amount for this poll
   * option/goal were included. Callers compute this themselves since the
   * math differs (a poll option's denominator grows with the pending vote;
   * a goal's target does not). Rendered as a translucent/glow segment
   * layered on top of the existing fill, from the current fill out to this
   * value. Ignored when at or below the current fill percentage.
   */
  previewPct?: number;
}

export default function ProgressBar({
  value,
  max,
  label,
  animateOnChange = true,
  previewPct,
}: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const clampedPreviewPct =
    previewPct !== undefined ? Math.min(100, Math.max(0, previewPct)) : undefined;
  const showPreview = clampedPreviewPct !== undefined && clampedPreviewPct > pct;

  const [animating, setAnimating] = useState(false);
  const [gainText, setGainText] = useState<string | null>(null);
  const prevValueRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevValueRef.current === null) {
      prevValueRef.current = value;
      return;
    }

    if (animateOnChange && value > prevValueRef.current) {
      const diff = value - prevValueRef.current;
      setGainText(`+$${(diff / 100).toFixed(0)}`);
      setAnimating(true);

      const timer = setTimeout(() => {
        setAnimating(false);
      }, 1200);

      prevValueRef.current = value;
      return () => clearTimeout(timer);
    }

    prevValueRef.current = value;
  }, [value, animateOnChange]);

  return (
    <div className="relative">
      {label && (
        <div className="flex justify-between font-data text-sm text-off-white/55 mb-1">{label}</div>
      )}

      {/* Progress Track */}
      <div
        className="relative h-4 rounded-sm overflow-visible"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        data-testid="progress-track"
      >
        {/* Donation-impact preview overlay (#52) — rendered first/underneath
            so the solid fill below covers it up to the current pct, leaving
            only the [pct, previewPct] range visible as a translucent glow. */}
        {showPreview && (
          <div
            className="absolute top-0 left-0 h-full rounded-sm transition-all duration-300 ease-out animate-preview-pulse"
            style={{
              width: `${clampedPreviewPct}%`,
              background: 'var(--grad)',
              opacity: 0.35,
              boxShadow: '0 0 10px rgba(208, 152, 70, 0.55)',
            }}
            data-testid="progress-preview"
          />
        )}

        {/* Fill Gauge */}
        <div
          className="h-full rounded-sm transition-all duration-700 ease-out overflow-hidden"
          style={{
            width: `${pct}%`,
            background: 'var(--grad)',
            boxShadow: animating ? '0 0 12px rgba(208, 152, 70, 0.6)' : undefined,
          }}
          data-testid="progress-fill"
        />

        {/* Coin & Plus Animation popup on fill head */}
        {animating && (
          <div
            className="absolute top-0 flex items-center gap-1 pointer-events-none z-10"
            style={{
              left: `${Math.max(2, Math.min(96, pct))}%`,
              transform: 'translateX(-50%)',
            }}
            data-testid="progress-animation"
          >
            {/* Spinning Coin */}
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow text-dark-gray font-mono font-bold text-xs shadow-md animate-coin-bounce select-none border border-d-yellow"
              title="Coin"
            >
              🪙
            </span>

            {/* Plus Gain Label */}
            <span className="font-data font-bold text-xs text-yellow text-shadow animate-plus-float select-none whitespace-nowrap">
              {gainText || '+'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
