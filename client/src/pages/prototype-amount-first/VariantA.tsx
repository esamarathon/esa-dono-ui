// PROTOTYPE — throwaway (#157). Variant A: amount gate, then the existing tab
// stepper with a sticky pool bar (all three meters + pay button always
// visible, answering "Pin cart total" #75), then a review step.
import { useState } from 'react';
import { CATEGORIES, CATEGORY_LABEL, MIN_PLEDGE_CENTS, canCheckout, fmt, pools, type Category } from './model';
import { AmountInput, OverageBanner, PICKERS, PoolMeter, Review, type Proto } from './shared';

export default function VariantA({ p }: { p: Proto }) {
  const [step, setStep] = useState<'amount' | 'browse' | 'review'>('amount');
  const [tab, setTab] = useState<Category>('rewards');
  const Picker = PICKERS[tab];
  const ok = canCheckout(p.pledge, p.sels);

  if (step === 'amount') {
    return (
      <div className="btrl-panel p-6">
        <p className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-1">1 · how much?</p>
        <p className="font-body text-sm text-off-white/60 mb-4">
          Your donation counts in full toward rewards, <em>and</em> polls, <em>and</em> fund goals.
        </p>
        <AmountInput p={p} big autoFocus />
        <div className="flex flex-wrap gap-3 mt-6">
          <button className="btrl-button" disabled={p.pledge < MIN_PLEDGE_CENTS} onClick={() => setStep('browse')}>
            choose incentives →
          </button>
          <button className="btrl-button btrl-button-outline" disabled={p.pledge < MIN_PLEDGE_CENTS} onClick={() => setStep('review')}>
            just donate {p.pledge >= MIN_PLEDGE_CENTS ? fmt(p.pledge) : ''} + message
          </button>
        </div>
      </div>
    );
  }

  if (step === 'review') {
    return (
      <div className="btrl-panel p-6">
        <p className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-3">3 · review</p>
        <Review p={p} onEdit={() => setStep(p.sels.length ? 'browse' : 'amount')} />
      </div>
    );
  }

  return (
    <div>
      {/* sticky pool bar */}
      <div className="sticky top-0 z-30 btrl-panel-dark p-3 mb-4 shadow-lg" style={{ background: 'var(--dark-gray)' }}>
        <div className="flex items-center gap-3">
          <button className="font-data text-lg font-bold text-d-yellow" onClick={() => setStep('amount')} title="change amount">
            {fmt(p.pledge)} ✎
          </button>
          <div className="flex gap-3 flex-1">
            {pools(p.pledge, p.sels).map((s) => (
              <PoolMeter key={s.category} s={s} compact />
            ))}
          </div>
          <button className="btrl-button" disabled={!ok} style={{ opacity: ok ? 1 : 0.4 }} onClick={() => setStep('review')}>
            review →
          </button>
        </div>
        <OverageBanner p={p} />
      </div>

      <div className="flex justify-center gap-2 mb-6">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setTab(c)}
            className={`font-data font-bold text-sm tracking-wider uppercase px-4 py-2 rounded-sm ${tab === c ? 'text-black' : 'text-off-white/55'}`}
            style={{ background: tab === c ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)' }}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      <Picker p={p} />
    </div>
  );
}
