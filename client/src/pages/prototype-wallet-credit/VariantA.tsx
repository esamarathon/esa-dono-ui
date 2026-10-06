// A · Summary + tabs: the approved layout. Summary on top, sticky balances bar, one tab per
// category, then a separate review step.
import { useState } from 'react';
import ProgressBar from '../../components/ProgressBar';
import {
  ACCENT,
  CATEGORIES,
  CREDIT_REWARDS,
  EVENT,
  GOALS,
  LABELS,
  POLLS,
  channelLabel,
  fmt,
  type Category,
  type CreditModel,
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

export default function VariantA({ m, preview }: { m: CreditModel; preview: boolean }) {
  const [tab, setTab] = useState<Category | null>(null);
  const { shown, totals, used, remaining } = m;
  const currentTab = tab && shown.includes(tab) ? tab : shown[0];

  return (
    <>
      <h1 className="font-display text-4xl uppercase mb-2">your credits</h1>
      <p className="font-body text-sm text-off-white/60 mb-4">
        {EVENT} · combined from all your donations to this Event. Each category’s credit can only be
        used on that category.
      </p>
      <section className="btrl-panel p-5 md:p-6 mb-6" aria-label="Credit summary">
        {shown.length ? (
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {shown.map((c) => (
              <div key={c} className={`border-l-4 pl-4 ${ACCENT[c].border}`}>
                <p className="font-data font-bold uppercase tracking-wide">{LABELS[c]} credit</p>
                <p className={`font-display text-5xl mt-1 ${ACCENT[c].text}`}>{fmt(totals[c])}</p>
                <p className="font-data text-sm text-off-white/55">
                  Only for {LABELS[c].toLowerCase()}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <NoCredit />
        )}
        <div className="mt-5 pt-4 border-t">
          <WalletLine m={m} />
        </div>
      </section>

      {shown.length > 0 && (
        <section aria-label="Use your credit">
          <div className="sticky top-0 z-30 btrl-panel-dark shadow-lg p-4 mb-5">
            <div className="flex flex-wrap items-end gap-4">
              <div
                className={`flex-1 grid gap-3 ${shown.length > 1 ? 'grid-cols-2' : ''} ${shown.length > 2 ? 'sm:grid-cols-3' : ''}`}
              >
                {shown.map((c) => (
                  <div key={c} className="font-data text-sm min-w-0">
                    <p className={`font-bold ${ACCENT[c].text}`}>
                      {LABELS[c]} · {fmt(totals[c])}
                    </p>
                    <p className={remaining[c] < 0 ? 'text-red' : 'text-off-white/60'}>
                      {fmt(used[c])} selected · {fmt(remaining[c])} left
                    </p>
                    <ProgressBar value={used[c]} max={totals[c]} animateOnChange={false} />
                  </div>
                ))}
              </div>
              {!m.reviewing ? (
                <button
                  className="btrl-button"
                  disabled={!m.selections.length || m.overBudget}
                  onClick={m.review}
                >
                  review →
                </button>
              ) : (
                <button className="btrl-button btrl-button-outline" onClick={m.backToEdit}>
                  edit selections
                </button>
              )}
            </div>
          </div>
          <ErrorAlert m={m} />
          {m.reviewing ? (
            <section className="btrl-panel p-5 md:p-6">
              <h2 className="font-display text-3xl mb-4">review your credit use</h2>
              {CATEGORIES.filter((c) => used[c] > 0).map((c) => (
                <div key={c} className="mb-5">
                  <div className="flex flex-wrap justify-between gap-2">
                    <h3 className={`font-data font-bold ${ACCENT[c].text}`}>{LABELS[c]} credit</h3>
                    <p className={`font-data text-sm ${remaining[c] < 0 ? 'text-red' : ''}`}>
                      {fmt(used[c])} used · {fmt(remaining[c])} remaining
                    </p>
                  </div>
                  <SelectedList m={m} category={c} />
                </div>
              ))}
              <NoPaymentNote className="py-4 mb-4 border-t" />
              <CreditChanged m={m} />
              <div className="flex flex-wrap gap-3">
                <button className="btrl-button btrl-button-outline" onClick={m.backToEdit}>
                  edit
                </button>
                <button className="btrl-button" disabled={!m.canApply} onClick={m.apply}>
                  apply credits
                </button>
              </div>
              <StaleDemoButton m={m} preview={preview} />
            </section>
          ) : (
            <>
              <p className="font-body text-sm text-off-white/60 mb-4">
                Open incentives across {EVENT}. Choices stay selected when you switch tabs; each
                category can only use its own credit.
              </p>
              {shown.length > 1 && (
                <div className="flex flex-wrap gap-3 mb-6" aria-label="Incentive categories">
                  {shown.map((c) => (
                    <button
                      key={c}
                      className={`btrl-button ${currentTab === c ? '' : 'btrl-button-outline'}`}
                      aria-pressed={currentTab === c}
                      onClick={() => setTab(c)}
                    >
                      {LABELS[c]} · {fmt(remaining[c])}
                    </button>
                  ))}
                </div>
              )}
              {currentTab === 'rewards' && (
                <>
                  <p className="font-body text-sm text-off-white/60 mb-4">
                    Non-physical rewards only. Whole units at the current price, while stock lasts.
                  </p>
                  <div className="grid md:grid-cols-2 gap-4">
                    {CREDIT_REWARDS.map((reward) => {
                      const left = m.stock[reward.id] ?? 0;
                      return (
                        <article
                          key={reward.id}
                          className={`btrl-panel p-5 ${left === 0 ? 'opacity-50' : ''}`}
                        >
                          <div className="flex justify-between gap-3">
                            <h3 className="font-data font-bold text-lg">{reward.title}</h3>
                            <p className="font-display text-2xl text-d-yellow">
                              {fmt(reward.price)}
                            </p>
                          </div>
                          <p className="font-body text-sm text-off-white/60 mt-2">
                            {reward.description}
                          </p>
                          <p className="font-mono text-xs text-off-white/55 mt-3">
                            {reward.type} · {channelLabel(reward.channelId)} · {left} left
                          </p>
                          <RewardControl m={m} reward={reward} />
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
              {currentTab === 'polls' && (
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
                            </div>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {currentTab === 'goals' && (
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
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
