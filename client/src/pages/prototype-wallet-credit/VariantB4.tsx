// B4 · Inline amount: B2's calm split view with a small "$ [   ]" field on every row. Typing a
// valid amount changes the pick at once; clearing it removes the pick. No set button.
import { parseCents, type CreditModel } from './model';
import { DirectSplit, MaxLink, type ControlProps } from './direct';

function InlineAmount({ m, t, draft, setDraft, commitDraft, invalid }: ControlProps) {
  const selected = m.selectionOf(t.id, t.category);
  const text = draft ?? (selected ? (selected.cents / 100).toFixed(2) : '');
  const max = m.maxFor(t);
  const canMax = max > 0 && selected?.cents !== max;
  const change = (value: string) => {
    setDraft(value);
    const cents = parseCents(value);
    if (!value.trim()) {
      if (selected) m.remove(t.id, t.category);
    } else if (cents !== null && cents >= 1) m.setCents(t, cents);
  };
  return (
    <div className="group/amt flex items-center gap-2 font-data text-sm">
      <label className="flex items-center gap-1 text-off-white/55">
        $
        <input
          aria-label={`${t.label} credit in dollars`}
          aria-invalid={invalid}
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          className={`w-20 px-2 py-0.5 border text-right ${invalid ? '!border-red' : ''}`}
          value={text}
          onChange={(e) => change(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => e.key === 'Enter' && commitDraft()}
        />
      </label>
      {/* Shown only while the field is focused or has a value. */}
      <MaxLink
        t={t}
        reveal={!canMax ? 'invisible' : text ? '' : 'invisible group-focus-within/amt:visible'}
        onClick={() => {
          m.setCents(t, max);
          setDraft(null);
        }}
      />
    </div>
  );
}

export default function VariantB4({ m }: { m: CreditModel }) {
  return <DirectSplit m={m} Control={InlineAmount} hint="Type an amount next to any incentive." />;
}
