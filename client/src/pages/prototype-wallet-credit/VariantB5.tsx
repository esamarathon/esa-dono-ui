// B5 · Stepper: B2's calm split view with "[–] $0.00 [+]" on every row. Each press moves $1
// (or the last cents that are left); tap the amount to type an exact one.
import { type CreditModel } from './model';
import { DirectSplit, MaxLink, StepButton, TypedAmount, type ControlProps } from './direct';

function Stepper(props: ControlProps) {
  const { m, t, setDraft } = props;
  const cents = m.selectionOf(t.id, t.category)?.cents ?? 0;
  const left = m.remaining[t.category];
  const max = m.maxFor(t);
  const canMax = max > 0 && cents !== max;
  return (
    <div className="flex items-center gap-1.5 font-data text-sm">
      <StepButton
        label={`Less credit for ${t.label}`}
        disabled={!cents}
        onClick={() => (cents > 100 ? m.setCents(t, cents - 100) : m.remove(t.id, t.category))}
      >
        −
      </StepButton>
      <TypedAmount {...props} cents={cents} />
      <StepButton
        label={`More credit for ${t.label}`}
        disabled={left < 1}
        onClick={() => m.setCents(t, cents + Math.min(100, left))}
      >
        +
      </StepButton>
      {/* Shown on hover or focus, and always once the row has an amount. */}
      <MaxLink
        t={t}
        reveal={
          !canMax
            ? 'invisible'
            : cents
              ? 'ml-1'
              : 'ml-1 invisible group-hover/row:visible group-focus-within/row:visible'
        }
        onClick={() => {
          m.setCents(t, max);
          setDraft(null);
        }}
      />
    </div>
  );
}

export default function VariantB5({ m }: { m: CreditModel }) {
  return <DirectSplit m={m} Control={Stepper} hint="Press + on an incentive, or tap its amount." />;
}
