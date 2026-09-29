import { InfoIcon } from './icons';

interface InfoTipProps {
  text: string;
}

/**
 * Inline "info" affordance that reveals an explanatory tooltip on hover or
 * keyboard focus. Purely presentational — the text is also exposed via
 * aria-label for screen readers. Positioned above the icon and centered;
 * the tooltip is `pointer-events-none` so it never traps the cursor.
 */
export default function InfoTip({ text }: InfoTipProps) {
  return (
    <span
      className="group relative inline-flex align-middle cursor-help"
      tabIndex={0}
      aria-label={text}
    >
      <InfoIcon className="h-3.5 w-3.5 text-off-white/40 transition-colors group-hover:text-off-white/80" />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-56 -translate-x-1/2 rounded-sm border p-2.5 text-left font-body text-xs leading-snug opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus:opacity-100"
        style={{
          background: 'var(--dark-gray)',
          borderColor: 'rgba(239,238,236,.12)',
          color: 'var(--off-white)',
        }}
      >
        {text}
      </span>
    </span>
  );
}
