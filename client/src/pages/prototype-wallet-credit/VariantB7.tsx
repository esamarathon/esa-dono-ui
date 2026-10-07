// B7 · Refined B: B's split view and row controls, with each detail shown once.
// - One page title; balances live only in the side panel (no summary row above the list).
// - Section headings name the category only; the panel already shows what is left.
// - Panel balance = one line + one meter (no "x of y picked" sub-text, no panel title).
// - Picks are not listed again while browsing; each row already shows its amount. The list
//   appears once, in the confirm step.
// - Channel shown as a short tag; the Event name is in the page title.
import ProgressBar from '../../components/ProgressBar';
import {
  ACCENT,
  CREDIT_REWARDS,
  EVENT,
  GOALS,
  LABELS,
  POLLS,
  channelTag,
  fmt,
  WALLET_CREDIT,
  type Category,
  type CreditModel,
} from './model';
import {
  AmountControl,
  CreditChanged,
  ErrorAlert,
  NoCredit,
  RewardControl,
  SelectedList,
} from './shared';

const ORDER: Category[] = ['polls', 'goals', 'rewards'];

function Tag({ children }: { children: string }) {
  return (
    <span className="ml-2 font-mono text-xs uppercase tracking-wider text-off-white/55">
      {children}
    </span>
  );
}

export default function VariantB7({ m, preview }: { m: CreditModel; preview: boolean }) {
  const { totals, used, remaining } = m;
  const shown = ORDER.filter((c) => m.shown.includes(c));
  const picks = m.selections.length;
  const toPanel = () =>
    document.getElementById('credit-panel')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <>
      <h1 className="font-display text-4xl uppercase">use your credits</h1>
      <p className="font-body text-base text-off-white/70 mb-6">
        {EVENT} · combined from all your donations. Each credit works only on its own category.
      </p>

      {!shown.length ? (
        <NoCredit />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
          <div className="min-w-0">
            {/* Mobile only: the panel sits below the list, so keep balances in view. */}
            <div className="lg:hidden sticky top-0 z-30 btrl-panel-dark shadow-lg p-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-data text-base">
              {shown.map((c) => (
                <span key={c} className={remaining[c] < 0 ? 'text-red' : ACCENT[c].text}>
                  {LABELS[c]} {fmt(remaining[c])} left
                </span>
              ))}
              <button className="ml-auto text-d-yellow underline" onClick={toPanel}>
                review ↓
              </button>
            </div>
            {!m.reviewing && <ErrorAlert m={m} className="mb-4 lg:hidden" />}
            <fieldset disabled={m.reviewing} className={m.reviewing ? 'opacity-50' : ''}>
              {shown.map((c) => (
                <section key={c} className="mb-8" aria-label={`${LABELS[c]} incentives`}>
                  <h2
                    className={`font-display text-3xl border-b-2 pb-1 mb-4 ${ACCENT[c].text} ${ACCENT[c].border}`}
                  >
                    {LABELS[c]}
                  </h2>
                  {c === 'polls' && (
                    <div className="space-y-3">
                      {POLLS.map((poll) => {
                        const view = m.pollView(poll);
                        return (
                          <article key={poll.id} className="btrl-panel p-4">
                            <p className="font-data font-bold text-lg">
                              {poll.title}
                              <Tag>{channelTag(poll.channelId)}</Tag>
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2 mt-3">
                              {view.options.map((option) => (
                                <div key={option.id} className="min-w-0">
                                  <div className="flex justify-between font-data text-base mb-1">
                                    <span>{option.label}</span>
                                    <span className="text-off-white/65">{fmt(option.current)}</span>
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
                              <p className="font-bold text-lg">
                                {goal.title}
                                <Tag>{channelTag(goal.channelId)}</Tag>
                              </p>
                              <p className="text-base text-off-white/65">
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
                      {CREDIT_REWARDS.map((reward) => (
                        <article
                          key={reward.id}
                          className={`btrl-panel p-4 ${(m.stock[reward.id] ?? 0) === 0 ? 'opacity-50' : ''}`}
                        >
                          <p className="font-data font-bold">
                            {reward.title} · {fmt(reward.price)}
                            <Tag>{`${channelTag(reward.channelId)} · ${m.stock[reward.id] ?? 0} left`}</Tag>
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
            aria-label="Credit balances"
            className={`btrl-panel-dark shadow-lg p-5 lg:sticky lg:top-4 lg:overflow-auto ${preview ? 'lg:max-h-[calc(100vh-7rem)]' : 'lg:max-h-[calc(100vh-2rem)]'}`}
          >
            <div className="space-y-4">
              {shown.map((c) => (
                <div key={c}>
                  <div className="flex items-baseline justify-between gap-2 font-data">
                    <span className={`font-bold ${ACCENT[c].text}`}>{LABELS[c]}</span>
                    <span className={remaining[c] < 0 ? 'text-red' : ''}>
                      <strong className="font-display text-3xl">{fmt(remaining[c])}</strong> left
                    </span>
                  </div>
                  <ProgressBar
                    value={Math.max(0, remaining[c])}
                    max={totals[c]}
                    animateOnChange={false}
                  />
                </div>
              ))}
            </div>

            {m.reviewing ? (
              <div className="mt-5 border-t pt-4">
                {shown
                  .filter((c) => used[c] > 0)
                  .map((c) => (
                    <div key={c} className="mb-3">
                      <p className={`font-data font-bold text-base ${ACCENT[c].text}`}>
                        {LABELS[c]} · {fmt(used[c])}
                      </p>
                      <SelectedList m={m} category={c} />
                    </div>
                  ))}
                <p className="font-body text-sm text-off-white/65 py-3 border-t">
                  No payment. Incentive totals change; money totals don’t.
                </p>
                <CreditChanged m={m} />
                <ErrorAlert m={m} className="mb-3" />
                <div className="flex flex-wrap gap-3">
                  <button className="btrl-button btrl-button-outline" onClick={m.backToEdit}>
                    edit
                  </button>
                  <button className="btrl-button flex-1" disabled={!m.canApply} onClick={m.apply}>
                    apply credits
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <ErrorAlert m={m} className="mb-3 hidden lg:block" />
                <button
                  className="btrl-button w-full"
                  disabled={!picks || m.overBudget}
                  onClick={m.review}
                >
                  {picks ? `review ${picks} pick${picks === 1 ? '' : 's'}` : 'review'}
                </button>
              </div>
            )}

            <div className="mt-5 pt-3 border-t font-data text-sm text-off-white/65 flex flex-wrap gap-x-2">
              <span>Wallet credit {fmt(WALLET_CREDIT)} · for new donations</span>
              <button
                className="text-d-yellow underline"
                onClick={() => m.setExtraPanel(m.extraPanel === 'draft' ? null : 'draft')}
              >
                view draft
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
