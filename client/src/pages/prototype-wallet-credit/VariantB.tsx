// B · Split view with credit panel: one scrolling list of all open incentives on the left, a
// sticky "Your credit" panel on the right that counts down, lists picks and holds the review
// and the apply action. No tabs and no separate review page.
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

export default function VariantB({ m, preview }: { m: CreditModel; preview: boolean }) {
  const { totals, used, remaining } = m;
  const shown = ORDER.filter((c) => m.shown.includes(c));
  const toPanel = () =>
    document.getElementById('credit-panel')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2">
        <h1 className="font-display text-4xl uppercase">your credits</h1>
        <p className="font-data text-sm text-off-white/60">
          {EVENT} · combined across your donations
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-6 font-data text-sm">
        {shown.map((c) => (
          <span key={c} className={`font-bold ${ACCENT[c].text}`}>
            {LABELS[c]} credit {fmt(totals[c])}
          </span>
        ))}
        <WalletLine m={m} />
      </div>

      {!shown.length ? (
        <section className="btrl-panel p-5 md:p-6">
          <NoCredit />
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
          <div className="min-w-0">
            {/* Mobile only: the panel sits below the list, so keep balances in view. */}
            <div className="lg:hidden sticky top-0 z-30 btrl-panel-dark shadow-lg p-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-data text-sm">
              {shown.map((c) => (
                <span key={c} className={remaining[c] < 0 ? 'text-red' : ACCENT[c].text}>
                  {LABELS[c]} {fmt(remaining[c])} left
                </span>
              ))}
              <button className="ml-auto text-d-yellow underline" onClick={toPanel}>
                {m.selections.length} picked · review ↓
              </button>
            </div>
            {m.reviewing && (
              <p className="btrl-panel-dark p-3 mb-4 font-body text-sm text-off-white/70">
                Confirming in the credit panel. Choose “edit” there to change your picks.
              </p>
            )}
            {!m.reviewing && <ErrorAlert m={m} className="mb-4 lg:hidden" />}
            <fieldset disabled={m.reviewing} className={m.reviewing ? 'opacity-50' : ''}>
              {shown.map((c) => (
                <section key={c} className="mb-8" aria-label={`${LABELS[c]} incentives`}>
                  <div
                    className={`flex flex-wrap items-baseline justify-between gap-2 border-b-2 pb-2 mb-4 ${ACCENT[c].border}`}
                  >
                    <h2 className={`font-display text-3xl ${ACCENT[c].text}`}>{LABELS[c]}</h2>
                    <p className="font-data text-sm text-off-white/60">
                      uses {SINGULAR[c]} credit only · {fmt(remaining[c])} left
                    </p>
                  </div>
                  {c === 'polls' && (
                    <div className="space-y-3">
                      {POLLS.map((poll) => {
                        const view = m.pollView(poll);
                        return (
                          <article key={poll.id} className="btrl-panel p-4">
                            <p className="font-data font-bold">
                              {poll.title}{' '}
                              <span className="font-mono text-xs font-normal text-off-white/55">
                                · {channelLabel(poll.channelId)}
                              </span>
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2 mt-3">
                              {view.options.map((option) => (
                                <div key={option.id} className="min-w-0">
                                  <div className="flex justify-between font-data text-sm mb-1">
                                    <span>{option.label}</span>
                                    <span className="text-off-white/55">{fmt(option.current)}</span>
                                  </div>
                                  <ProgressBar
                                    value={option.current}
                                    max={view.total}
                                    previewPct={option.previewPct}
                                    animateOnChange={false}
                                  />
                                  <div className="mt-2">
                                    <AmountControl m={m} t={option.target} compact />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {c === 'goals' && (
                    <div className="space-y-3">
                      {GOALS.map((goal) => {
                        const view = m.goalView(goal);
                        return (
                          <article key={goal.id} className="btrl-panel p-4">
                            <div className="flex flex-wrap justify-between gap-2 font-data mb-2">
                              <p className="font-bold">
                                {goal.title}{' '}
                                <span className="font-mono text-xs font-normal text-off-white/55">
                                  · {channelLabel(goal.channelId)}
                                </span>
                              </p>
                              <p className="text-sm text-off-white/55">
                                {fmt(view.current)} / {fmt(goal.target)}
                              </p>
                            </div>
                            <ProgressBar
                              value={view.current}
                              max={goal.target}
                              previewPct={view.previewPct}
                              animateOnChange={false}
                            />
                            <div className="mt-2">
                              <AmountControl m={m} t={view.target} compact />
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {c === 'rewards' && (
                    <div className="space-y-3">
                      <p className="font-body text-sm text-off-white/60">
                        Non-physical rewards only. Whole units at the current price, while stock
                        lasts.
                      </p>
                      {CREDIT_REWARDS.map((reward) => (
                        <article
                          key={reward.id}
                          className={`btrl-panel p-4 ${(m.stock[reward.id] ?? 0) === 0 ? 'opacity-50' : ''}`}
                        >
                          <p className="font-data font-bold">
                            {reward.title} · {fmt(reward.price)}{' '}
                            <span className="font-mono text-xs font-normal text-off-white/55">
                              · {channelLabel(reward.channelId)} · {m.stock[reward.id] ?? 0} left
                            </span>
                          </p>
                          <RewardControl m={m} reward={reward} />
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </fieldset>
          </div>

          <aside
            id="credit-panel"
            aria-label="Your credit"
            className={`btrl-panel-dark shadow-lg p-5 lg:sticky lg:top-4 lg:overflow-auto ${preview ? 'lg:max-h-[calc(100vh-7rem)]' : 'lg:max-h-[calc(100vh-2rem)]'}`}
          >
            <h2 className="font-display text-3xl mb-4">your credit</h2>
            <div className="space-y-4">
              {shown.map((c) => (
                <div key={c} className={`border-l-4 pl-3 ${ACCENT[c].border}`}>
                  <div className="flex justify-between gap-2 font-data">
                    <span className="font-bold">{LABELS[c]}</span>
                    <span className={remaining[c] < 0 ? 'text-red' : ACCENT[c].text}>
                      <strong className="font-display text-3xl">{fmt(remaining[c])}</strong> left
                    </span>
                  </div>
                  <ProgressBar
                    value={Math.max(0, remaining[c])}
                    max={totals[c]}
                    animateOnChange={false}
                  />
                  <p className="font-data text-xs text-off-white/55 mt-1">
                    {fmt(used[c])} of {fmt(totals[c])} picked
                  </p>
                </div>
              ))}
            </div>

            {m.reviewing ? (
              <div className="mt-6 border-t pt-4">
                <h3 className="font-display text-2xl mb-2">confirm</h3>
                {shown
                  .filter((c) => used[c] > 0)
                  .map((c) => (
                    <div key={c} className="mb-3">
                      <p className={`font-data font-bold text-sm ${ACCENT[c].text}`}>
                        {LABELS[c]} credit · {fmt(used[c])} used · {fmt(remaining[c])} stays
                      </p>
                      <SelectedList m={m} category={c} />
                    </div>
                  ))}
                <NoPaymentNote className="py-3 mb-3 border-t" />
                <CreditChanged m={m} />
                <ErrorAlert m={m} className="mb-3" />
                <div className="flex flex-wrap gap-3">
                  <button className="btrl-button btrl-button-outline" onClick={m.backToEdit}>
                    edit
                  </button>
                  <button className="btrl-button" disabled={!m.canApply} onClick={m.apply}>
                    apply credits
                  </button>
                </div>
                <StaleDemoButton m={m} preview={preview} />
              </div>
            ) : (
              <div className="mt-6 border-t pt-4">
                <h3 className="font-data font-bold uppercase text-sm tracking-wide mb-2">
                  your picks
                </h3>
                {m.selections.length ? (
                  <ul className="space-y-2 mb-4">
                    {shown.flatMap((c) =>
                      m.selections
                        .filter((s) => s.category === c)
                        .map((s) => (
                          <li
                            key={`${c}:${s.id}`}
                            className={`flex items-center gap-2 border-l-2 pl-2 font-data text-sm ${ACCENT[c].border}`}
                          >
                            <span className="min-w-0 flex-1 break-words">
                              {s.label}
                              {s.quantity ? ` × ${s.quantity}` : ''}
                              <span className="block text-xs text-off-white/55">{s.detail}</span>
                            </span>
                            <span>{fmt(s.cents)}</span>
                            <button
                              className="text-off-white/55 hover:text-red px-1"
                              aria-label={`Remove ${s.label}`}
                              onClick={() => m.remove(s.id, s.category)}
                            >
                              ×
                            </button>
                          </li>
                        )),
                    )}
                  </ul>
                ) : (
                  <p className="font-body text-sm text-off-white/55 mb-4">
                    Nothing picked yet. Enter an amount next to any incentive.
                  </p>
                )}
                <ErrorAlert m={m} className="mb-3" />
                <button
                  className="btrl-button w-full"
                  disabled={!m.selections.length || m.overBudget}
                  onClick={m.review}
                >
                  review in panel
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
