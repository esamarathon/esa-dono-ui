// B2 · Quiet list: B's split view (incentive list + sticky "Your credit" panel) with the
// controls hidden until the donor taps an incentive. Totals appear only in the panel.
// B4, B5 and B6 reuse this shell with one always-visible control per row.
import { useState, type ReactNode } from 'react';
import { ACCENT, LABELS, fmt, type Category, type CreditModel, type Selection } from './model';
import { NoCredit } from './shared';
import { CategoryRows, QuietConfirm, QuietHeader, ThinBar, WalletFooter } from './quiet';

const ORDER: Category[] = ['polls', 'goals', 'rewards'];

export function QuietSplit({
  m,
  rows,
  hint,
  blocked = 0,
  onRemove,
  onReview,
}: {
  m: CreditModel;
  rows: (category: Category) => ReactNode;
  hint: string;
  // Rows with an amount that is not valid yet; review waits until they are fixed.
  blocked?: number;
  onRemove?: (selection: Selection) => void;
  onReview?: () => void;
}) {
  const { totals, remaining } = m;
  const shown = ORDER.filter((c) => m.shown.includes(c));

  if (!shown.length)
    return (
      <>
        <QuietHeader />
        <NoCredit />
        <div className="mt-4">
          <WalletFooter />
        </div>
      </>
    );

  return (
    <>
      <QuietHeader />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
        <fieldset
          disabled={m.reviewing}
          className={`min-w-0 ${m.reviewing ? 'opacity-40' : ''}`}
          aria-label="Incentives"
        >
          {shown.map((c) => (
            <section key={c} className="mb-8" aria-label={`${LABELS[c]} incentives`}>
              <h2 className={`font-display text-2xl mb-2 ${ACCENT[c].text}`}>{LABELS[c]}</h2>
              {rows(c)}
            </section>
          ))}
        </fieldset>

        {/* On small screens the panel comes first, so the balances are seen before the list. */}
        <aside
          id="credit-panel"
          aria-label="Your credit"
          className="order-first lg:order-none btrl-panel-dark p-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-auto"
        >
          <h2 className="font-display text-2xl mb-3">your credit</h2>
          <div className="space-y-3">
            {shown.map((c) => (
              <div key={c}>
                <p className="flex justify-between gap-2 font-data text-sm mb-1">
                  <span className={`font-bold ${ACCENT[c].text}`}>{LABELS[c]}</span>
                  <span className={remaining[c] < 0 ? 'text-red' : ''}>
                    {fmt(remaining[c])} left
                  </span>
                </p>
                <ThinBar
                  value={Math.max(0, remaining[c])}
                  max={totals[c]}
                  accent={ACCENT[c].bg}
                  fill={ACCENT[c].bg}
                />
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 border-t border-off-white/10">
            {m.reviewing ? (
              <QuietConfirm m={m} categories={shown} />
            ) : (
              <>
                {m.selections.length ? (
                  <ul className="space-y-1 mb-4 font-data text-sm">
                    {shown.flatMap((c) =>
                      m.selections
                        .filter((s) => s.category === c)
                        .map((s) => (
                          <li key={`${c}:${s.id}`} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${ACCENT[c].bg}`}
                            />
                            <span className="min-w-0 flex-1 break-words">
                              {s.label}
                              {s.quantity ? ` × ${s.quantity}` : ''}
                            </span>
                            <span>{fmt(s.cents)}</span>
                            <button
                              className="text-off-white/40 hover:text-red px-1"
                              aria-label={`Remove ${s.label}`}
                              onClick={() => {
                                onRemove?.(s);
                                m.remove(s.id, s.category);
                              }}
                            >
                              ×
                            </button>
                          </li>
                        )),
                    )}
                  </ul>
                ) : (
                  <p className="font-body text-sm text-off-white/50 mb-4">{hint}</p>
                )}
                {blocked > 0 && (
                  <p className="font-body text-xs text-off-white/50 mb-2">
                    Finish or fix the amount being edited to review.
                  </p>
                )}
                <button
                  className="btrl-button w-full"
                  disabled={!m.selections.length || m.overBudget || blocked > 0}
                  onClick={() => {
                    onReview?.();
                    m.review();
                  }}
                >
                  review
                </button>
              </>
            )}
          </div>
          <div className="mt-5">
            <WalletFooter />
          </div>
        </aside>
      </div>
    </>
  );
}

export default function VariantB2({ m }: { m: CreditModel }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <QuietSplit
      m={m}
      hint="Tap an incentive to add credit."
      rows={(c) => (
        <CategoryRows m={m} category={c} open={m.reviewing ? null : open} setOpen={setOpen} />
      )}
      onRemove={() => setOpen(null)}
      onReview={() => setOpen(null)}
    />
  );
}
