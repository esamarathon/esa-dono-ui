// C · Guided, one category at a time: a short stepper. Each step places one category's credit
// with a big countdown and quick-split shortcuts; the last step is the review with one apply.
import { useState } from 'react';
import ProgressBar from '../../components/ProgressBar';
import {
  ACCENT,
  CREDIT_REWARDS,
  EVENT,
  GOALS,
  LABELS,
  POLLS,
  SINGULAR,
  channelLabel,
  fmt,
  type Category,
  type CreditModel,
  type Target,
} from './model';
import {
  AmountControl,
  CreditChanged,
  ErrorAlert,
  NoCredit,
  NoPaymentNote,
  RewardControl,
  SelectedList,
  StaleDemoButton,
  WalletLine,
} from './shared';

const ORDER: Category[] = ['polls', 'goals', 'rewards'];

export default function VariantC({ m, preview }: { m: CreditModel; preview: boolean }) {
  const [index, setIndex] = useState(0);
  const { totals, used, remaining } = m;
  const steps = ORDER.filter((c) => m.shown.includes(c));
  const at = Math.min(index, steps.length - 1);
  const current = steps[at];
  const goTo = (i: number) => {
    m.backToEdit();
    setIndex(i);
    window.scrollTo({ top: 0 });
  };
  const next = () => {
    if (at < steps.length - 1) goTo(at + 1);
    else {
      m.review();
      window.scrollTo({ top: 0 });
    }
  };
  const unusedText = (c: Category) =>
    used[c] === 0
      ? `skipped · ${fmt(totals[c])} stays unused`
      : remaining[c] > 0
        ? `${fmt(used[c])} placed · ${fmt(remaining[c])} stays unused`
        : `${fmt(used[c])} placed`;

  const header = (
    <>
      <h1 className="font-display text-4xl uppercase mb-1">use your credits</h1>
      <p className="font-body text-sm text-off-white/60 mb-3">
        {EVENT} · combined across your donations. One category at a time; each category’s credit
        only works on that category.
      </p>
      <div className="mb-6">
        <WalletLine m={m} />
      </div>
    </>
  );

  if (!current) {
    return (
      <>
        {header}
        <section className="btrl-panel p-5 md:p-6">
          <NoCredit />
        </section>
      </>
    );
  }

  const categoryTargets = (c: Category): Target[] =>
    c === 'polls'
      ? POLLS.flatMap((p) => m.pollView(p).options.map((o) => o.target))
      : c === 'goals'
        ? GOALS.map((g) => m.goalView(g).target)
        : [];
  const picked = (c: Category) => categoryTargets(c).filter((t) => m.selectionOf(t.id, t.category));
  const splitEvenly = (c: Category) => {
    const list = picked(c);
    const base = Math.floor(totals[c] / list.length);
    const extra = totals[c] - base * list.length;
    m.setCategorySelections(
      c,
      list.map((t, i) => ({ ...t, cents: base + (i < extra ? 1 : 0) })),
    );
  };
  const allHere = (t: Target) => (
    <button
      className="btrl-button btrl-button-outline text-sm mt-2"
      disabled={m.selectionOf(t.id, t.category)?.cents === totals[t.category]}
      onClick={() => m.setCategorySelections(t.category, [{ ...t, cents: totals[t.category] }])}
    >
      put all {fmt(totals[t.category])} here
    </button>
  );

  return (
    <>
      {header}
      <ol className="grid gap-2 sm:flex sm:flex-wrap mb-6" aria-label="Steps">
        {steps.map((c, i) => {
          const active = !m.reviewing && c === current;
          return (
            <li key={c} className="sm:flex-1 min-w-0">
              <button
                className={`w-full text-left btrl-panel p-3 border-t-4 ${ACCENT[c].border} ${active ? '' : 'opacity-60'}`}
                aria-current={active ? 'step' : undefined}
                onClick={() => goTo(i)}
              >
                <span className="block font-data font-bold text-sm">
                  {i + 1} · Place your {fmt(totals[c])} {SINGULAR[c]} credit
                </span>
                <span className="block font-data text-xs text-off-white/55">
                  {used[c] === 0 && !m.reviewing && i >= at
                    ? `${fmt(totals[c])} to place`
                    : unusedText(c)}
                </span>
              </button>
            </li>
          );
        })}
        <li className="sm:flex-1 min-w-0">
          <div
            className={`btrl-panel p-3 border-t-4 border-off-white ${m.reviewing ? '' : 'opacity-60'}`}
            aria-current={m.reviewing ? 'step' : undefined}
          >
            <span className="block font-data font-bold text-sm">{steps.length + 1} · Confirm</span>
            <span className="block font-data text-xs text-off-white/55">one apply for all</span>
          </div>
        </li>
      </ol>

      {m.reviewing ? (
        <section className="btrl-panel p-5 md:p-6">
          <h2 className="font-display text-3xl mb-4">confirm your credit use</h2>
          {steps.map((c) => (
            <div key={c} className={`mb-5 border-l-4 pl-4 ${ACCENT[c].border}`}>
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className={`font-data font-bold ${ACCENT[c].text}`}>{LABELS[c]} credit</h3>
                <p className={`font-data text-sm ${remaining[c] < 0 ? 'text-red' : ''}`}>
                  {unusedText(c)}
                </p>
              </div>
              {used[c] > 0 ? (
                <SelectedList m={m} category={c} />
              ) : (
                <p className="font-body text-sm text-off-white/60 mt-1">
                  Nothing placed. Your {fmt(totals[c])} {SINGULAR[c]} credit stays for later.
                </p>
              )}
            </div>
          ))}
          <NoPaymentNote className="py-4 mb-4 border-t" />
          <CreditChanged m={m} />
          <ErrorAlert m={m} />
          <div className="flex flex-wrap gap-3">
            <button
              className="btrl-button btrl-button-outline"
              onClick={() => goTo(steps.length - 1)}
            >
              ← back
            </button>
            <button className="btrl-button" disabled={!m.canApply} onClick={m.apply}>
              apply credits
            </button>
          </div>
          {!m.selections.length && (
            <p className="font-body text-sm text-off-white/60 mt-3">
              Nothing to apply. Go back and place some credit.
            </p>
          )}
          <StaleDemoButton m={m} preview={preview} />
        </section>
      ) : (
        <section aria-label={`Place your ${SINGULAR[current]} credit`}>
          <div className={`btrl-panel p-5 md:p-6 mb-5 border-l-8 ${ACCENT[current].border}`}>
            <p className="font-data font-bold uppercase tracking-wide">
              {LABELS[current]} credit left
            </p>
            <p
              className={`font-display text-7xl leading-none my-2 ${remaining[current] < 0 ? 'text-red' : ACCENT[current].text}`}
            >
              {fmt(remaining[current])}
            </p>
            <p className="font-data text-sm text-off-white/60 mb-3">
              of {fmt(totals[current])} · only for {LABELS[current].toLowerCase()}
            </p>
            <ProgressBar value={used[current]} max={totals[current]} animateOnChange={false} />
            {current !== 'rewards' && (
              <div className="flex flex-wrap gap-3 mt-4">
                <button
                  className="btrl-button btrl-button-outline text-sm"
                  disabled={picked(current).length < 2}
                  onClick={() => splitEvenly(current)}
                >
                  {picked(current).length < 2
                    ? 'split evenly · pick 2 or more first'
                    : `split ${fmt(totals[current])} evenly across ${picked(current).length} selected`}
                </button>
                <button
                  className="btrl-button btrl-button-outline text-sm"
                  disabled={!used[current]}
                  onClick={() => m.setCategorySelections(current, [])}
                >
                  clear this step
                </button>
              </div>
            )}
          </div>
          <ErrorAlert m={m} />

          {current === 'polls' && (
            <div className="space-y-4">
              {POLLS.map((poll) => {
                const view = m.pollView(poll);
                return (
                  <article key={poll.id} className="btrl-panel p-5">
                    <h3 className="font-data font-bold text-lg">{poll.title}</h3>
                    <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                      {channelLabel(poll.channelId)}
                    </p>
                    <div className="space-y-5">
                      {view.options.map((option) => (
                        <div key={option.id}>
                          <div className="flex justify-between font-data text-sm mb-2">
                            <span className="font-bold">{option.label}</span>
                            <span className="text-off-white/55">{fmt(option.current)}</span>
                          </div>
                          <ProgressBar
                            value={option.current}
                            max={view.total}
                            previewPct={option.previewPct}
                            animateOnChange={false}
                          />
                          <AmountControl m={m} t={option.target} />
                          {allHere(option.target)}
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {current === 'goals' && (
            <div className="space-y-4">
              {GOALS.map((goal) => {
                const view = m.goalView(goal);
                return (
                  <article key={goal.id} className="btrl-panel p-5">
                    <h3 className="font-data font-bold text-lg">{goal.title}</h3>
                    <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                      {channelLabel(goal.channelId)}
                    </p>
                    <ProgressBar
                      value={view.current}
                      max={goal.target}
                      previewPct={view.previewPct}
                      animateOnChange={false}
                    />
                    <div className="flex justify-between font-data text-sm text-off-white/55 mt-2">
                      <span>{fmt(view.current)} raised</span>
                      <span>goal {fmt(goal.target)}</span>
                    </div>
                    <AmountControl m={m} t={view.target} />
                    {allHere(view.target)}
                  </article>
                );
              })}
            </div>
          )}
          {current === 'rewards' && (
            <div className="grid md:grid-cols-2 gap-4">
              {CREDIT_REWARDS.map((reward) => (
                <article key={reward.id} className="btrl-panel p-5">
                  <h3 className="font-data font-bold text-lg">
                    {reward.title} · {fmt(reward.price)}
                  </h3>
                  <p className="font-mono text-xs text-off-white/55 mt-1">
                    {reward.type} · {channelLabel(reward.channelId)} · {m.stock[reward.id] ?? 0}{' '}
                    left
                  </p>
                  <RewardControl m={m} reward={reward} />
                </article>
              ))}
            </div>
          )}

          <div className="btrl-panel-dark p-4 mt-6">
            <p className="font-body text-sm text-off-white/70 mb-3">
              {remaining[current] > 0
                ? `Anything you do not place stays as ${SINGULAR[current]} credit for later: ${fmt(remaining[current])} will stay unused.`
                : `All your ${SINGULAR[current]} credit is placed.`}
            </p>
            <div className="flex flex-wrap gap-3">
              {at > 0 && (
                <button className="btrl-button btrl-button-outline" onClick={() => goTo(at - 1)}>
                  ← back
                </button>
              )}
              <button className="btrl-button" disabled={remaining[current] < 0} onClick={next}>
                {used[current] === 0
                  ? `skip · leave ${fmt(totals[current])} unused →`
                  : at < steps.length - 1
                    ? 'next →'
                    : 'next: confirm →'}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
