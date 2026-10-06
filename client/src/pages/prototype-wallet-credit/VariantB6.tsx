// B6 · Slider: B2's calm split view with a slider on every row, from $0 to what this row can
// take (credit left in the category plus its own amount). Tap the amount to type an exact one.
import { fmt, type Category, type CreditModel } from './model';
import { DirectSplit, TypedAmount, type ControlProps } from './direct';

// Literal class names so Tailwind keeps them.
const RANGE_ACCENT: Record<Category, string> = {
  rewards: 'accent-pink-pale',
  polls: 'accent-d-yellow',
  goals: 'accent-green',
};
// Arrow keys move $0.25 and Page Up/Down $1, instead of the native one-cent step.
const KEY_STEP: Record<string, number> = {
  ArrowRight: 25,
  ArrowUp: 25,
  ArrowLeft: -25,
  ArrowDown: -25,
  PageUp: 100,
  PageDown: -100,
};

function Slider(props: ControlProps) {
  const { m, t } = props;
  const cents = m.selectionOf(t.id, t.category)?.cents ?? 0;
  const max = Math.max(0, m.maxFor(t));
  const set = (value: number) => {
    const next = Math.max(0, Math.min(max, Math.round(value)));
    if (next === cents) return;
    if (next < 1) m.remove(t.id, t.category);
    else m.setCents(t, next);
  };
  return (
    <div className="flex items-center gap-3 font-data text-sm">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(cents, max)}
        disabled={max < 1}
        aria-label={`${t.label} credit`}
        aria-valuetext={fmt(cents)}
        className={`flex-1 min-w-0 sm:flex-none sm:w-44 h-5 !bg-transparent cursor-pointer disabled:cursor-default disabled:opacity-40 ${RANGE_ACCENT[t.category]}`}
        onChange={(e) => set(Number(e.target.value))}
        onKeyDown={(e) => {
          const step = KEY_STEP[e.key];
          if (e.key === 'Home' || e.key === 'End' || step !== undefined) {
            e.preventDefault();
            set(e.key === 'Home' ? 0 : e.key === 'End' ? max : cents + (step ?? 0));
          }
        }}
      />
      <TypedAmount {...props} cents={cents} />
    </div>
  );
}

export default function VariantB6({ m }: { m: CreditModel }) {
  return <DirectSplit m={m} Control={Slider} hint="Slide on an incentive, or tap its amount." />;
}
