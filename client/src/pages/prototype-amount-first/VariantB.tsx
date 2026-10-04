// PROTOTYPE — throwaway (#157). Variant B: one page, no steps. Amount at the
// top, all three categories stacked (each with its own meter in the header),
// and the live review/allocation as a sticky sidebar that doubles as the cart.
// "Just donate" = type an amount and press pay; nothing else is required.
import { CATEGORIES, CATEGORY_LABEL, pools } from './model';
import { AmountInput, OverageBanner, PICKERS, PoolMeter, Review, type Proto } from './shared';

export default function VariantB({ p }: { p: Proto }) {
  const status = pools(p.pledge, p.sels);
  return (
    <div className="grid md:grid-cols-[1fr_320px] gap-6 items-start">
      <div>
        <section className="btrl-panel p-4 mb-4">
          <p className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-2">your donation</p>
          <AmountInput p={p} />
          <p className="font-body text-xs text-off-white/55 mt-1">
            Every category below gets this full amount to spend.
          </p>
        </section>
        <OverageBanner p={p} />
        {CATEGORIES.map((c) => {
          const Picker = PICKERS[c];
          return (
            <details key={c} open className="mb-4">
              <summary className="cursor-pointer list-none btrl-panel p-3 flex items-center gap-4">
                <span className="font-display text-2xl uppercase w-32">{CATEGORY_LABEL[c]}</span>
                <PoolMeter s={status.find((s) => s.category === c)!} />
              </summary>
              <div className="mt-2 pl-2">
                <Picker p={p} />
              </div>
            </details>
          );
        })}
      </div>
      <aside className="btrl-panel p-4 md:sticky md:top-4">
        <p className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-2">where your money goes</p>
        {p.pledge === 0 ? (
          <p className="font-body text-sm text-off-white/55">Enter an amount to start.</p>
        ) : (
          <Review p={p} dense />
        )}
      </aside>
    </div>
  );
}
