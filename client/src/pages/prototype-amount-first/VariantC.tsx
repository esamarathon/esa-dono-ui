// PROTOTYPE — throwaway (#157). Variant C: guided questions. Screen 1 asks the
// amount and "what should it do?" (the categories become opt-in). Then one
// full screen per chosen category, with one big meter. Then review.
// Unchosen categories still auto-allocate (goals -> default goal list).
import { useState } from 'react';
import { CATEGORIES, CATEGORY_LABEL, MIN_PLEDGE_CENTS, canCheckout, fmt, pools, type Category } from './model';
import { AmountInput, OverageBanner, PICKERS, PoolMeter, Review, type Proto } from './shared';

const ASK: Record<Category, string> = {
  rewards: 'Claim a reward (shout-outs, posters…)',
  polls: 'Vote in a poll (file names, character choices…)',
  goals: 'Push a fund goal (bonus runs…)',
};

export default function VariantC({ p }: { p: Proto }) {
  const [want, setWant] = useState<Category[]>([]);
  const [i, setI] = useState(-1); // -1 = question screen, want.length = review
  const toggle = (c: Category) =>
    setWant((w) => (w.includes(c) ? w.filter((x) => x !== c) : CATEGORIES.filter((x) => x === c || w.includes(x))));

  if (i === -1) {
    return (
      <div className="max-w-xl mx-auto">
        <h2 className="font-display text-4xl uppercase mb-2">How much would you like to give?</h2>
        <AmountInput p={p} big autoFocus />
        <h2 className="font-display text-3xl uppercase mt-8 mb-1">What should it do?</h2>
        <p className="font-body text-sm text-off-white/60 mb-3">
          Pick any. {p.pledge >= MIN_PLEDGE_CENTS ? `The full ${fmt(p.pledge)} counts for each one you pick.` : ''}
        </p>
        <div className="space-y-2">
          {CATEGORIES.map((c) => (
            <label key={c} className="btrl-panel p-3 flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={want.includes(c)} onChange={() => toggle(c)} />
              <span className="font-body">{ASK[c]}</span>
            </label>
          ))}
        </div>
        <button
          className="btrl-button text-lg py-3 px-8 mt-6 w-full"
          disabled={p.pledge < MIN_PLEDGE_CENTS}
          onClick={() => setI(0)}
        >
          {want.length === 0 ? `just donate ${p.pledge >= MIN_PLEDGE_CENTS ? fmt(p.pledge) : ''} →` : 'next →'}
        </button>
      </div>
    );
  }

  if (i >= want.length) {
    return (
      <div className="max-w-xl mx-auto">
        <h2 className="font-display text-4xl uppercase mb-4">Here’s where it goes</h2>
        <Review p={p} onEdit={() => setI(want.length ? want.length - 1 : -1)} />
      </div>
    );
  }

  const cat = want[i]!;
  const Picker = PICKERS[cat];
  const s = pools(p.pledge, p.sels).find((x) => x.category === cat)!;
  const fits = canCheckout(p.pledge, p.sels);
  return (
    <div className="max-w-xl mx-auto">
      <p className="font-mono text-xs tracking-widest uppercase text-off-white/50">
        step {i + 1} of {want.length + 1}
      </p>
      <h2 className="font-display text-4xl uppercase mb-3">{ASK[cat]}</h2>
      <div className="btrl-panel p-4 mb-4">
        <PoolMeter s={s} />
      </div>
      <OverageBanner p={p} />
      <Picker p={p} />
      <div className="flex justify-between mt-6">
        <button className="btrl-button btrl-button-outline" onClick={() => setI(i - 1)}>
          ← back
        </button>
        <button className="btrl-button" disabled={i === want.length - 1 && !fits} onClick={() => setI(i + 1)}>
          {i === want.length - 1 ? 'review →' : `next: ${CATEGORY_LABEL[want[i + 1]!]} →`}
        </button>
      </div>
    </div>
  );
}
