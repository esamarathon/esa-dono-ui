// A2 · Quiet tabs: A's structure (balances on top, one tab per category, one review step)
// with one sticky balance bar instead of a summary plus a bar, and tap-to-edit rows.
import { useState } from 'react';
import { ACCENT, LABELS, fmt, type Category, type CreditModel } from './model';
import { NoCredit } from './shared';
import { CategoryRows, QuietConfirm, QuietHeader, WalletFooter } from './quiet';

export default function VariantA2({ m }: { m: CreditModel }) {
  const [tab, setTab] = useState<Category | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { shown, remaining } = m;
  const current = tab && shown.includes(tab) ? tab : shown[0];

  if (!current)
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
      <div
        className="sticky top-0 z-30 -mx-4 px-4 md:mx-0 md:px-0 py-3 mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 font-data text-sm border-b border-off-white/10"
        style={{ background: 'var(--dark-gray)' }}
      >
        {shown.map((c) => (
          <span key={c} className={remaining[c] < 0 ? 'text-red' : ACCENT[c].text}>
            {LABELS[c]} <strong>{fmt(remaining[c])}</strong> left
          </span>
        ))}
        {!m.reviewing && (
          <button
            className="btrl-button text-sm px-4 py-1 ml-auto"
            disabled={!m.selections.length || m.overBudget}
            onClick={() => {
              setOpen(null);
              m.review();
            }}
          >
            review
          </button>
        )}
      </div>

      {m.reviewing ? (
        <section aria-label="Review">
          <h2 className="font-display text-2xl mb-3">review</h2>
          <QuietConfirm m={m} categories={shown} />
        </section>
      ) : (
        <>
          {shown.length > 1 && (
            <div
              role="tablist"
              aria-label="Incentive categories"
              className="flex gap-6 border-b border-off-white/10"
            >
              {shown.map((c) => (
                <button
                  key={c}
                  role="tab"
                  aria-selected={current === c}
                  className={`font-data font-bold uppercase tracking-wide text-sm pb-2 -mb-px border-b-2 ${
                    current === c
                      ? `${ACCENT[c].border} ${ACCENT[c].text}`
                      : 'border-transparent text-off-white/50'
                  }`}
                  onClick={() => {
                    m.clearError();
                    setOpen(null);
                    setTab(c);
                  }}
                >
                  {LABELS[c]}
                </button>
              ))}
            </div>
          )}
          <section className="mt-3" aria-label={`${LABELS[current]} incentives`}>
            <CategoryRows m={m} category={current} open={open} setOpen={setOpen} kind="input" />
          </section>
        </>
      )}
      <div className="mt-8">
        <WalletFooter />
      </div>
    </>
  );
}
