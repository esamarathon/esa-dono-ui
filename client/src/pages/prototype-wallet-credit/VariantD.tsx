// D · Compact table: every open incentive as one dense row (cards on mobile), a sticky footer
// with per-category used/remaining, and a confirmation dialog with the single apply action.
import { useEffect, useRef, type ReactNode } from 'react';
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
  SelectedList,
  StaleDemoButton,
  WalletLine,
} from './shared';

const ORDER: Category[] = ['polls', 'goals', 'rewards'];
const COLS =
  'lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_5.5rem_17.5rem] lg:items-center lg:gap-4';

function Row({
  category,
  title,
  sub,
  channel,
  progress,
  children,
}: {
  category: Category;
  title: string;
  sub?: string;
  channel: string;
  progress: { value: number; max: number; previewPct?: number; text: string };
  children: ReactNode;
}) {
  return (
    <li className={`relative pl-4 pr-3 py-3 ${COLS}`}>
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${ACCENT[category].bg}`} />
      <div className="min-w-0 font-data">
        <p className="font-bold break-words">{title}</p>
        {sub && <p className="text-xs text-off-white/55 break-words">{sub}</p>}
      </div>
      <p className="font-mono text-xs text-off-white/55 break-words mt-1 lg:mt-0">
        {channel}
        <span className={`lg:hidden ${ACCENT[category].text}`}> · {LABELS[category]}</span>
      </p>
      <div className="min-w-0 my-2 lg:my-0">
        <ProgressBar
          value={progress.value}
          max={progress.max}
          previewPct={progress.previewPct}
          animateOnChange={false}
        />
        <p className="font-data text-xs text-off-white/55 mt-1">{progress.text}</p>
      </div>
      <p className={`hidden lg:block font-data font-bold text-sm ${ACCENT[category].text}`}>
        {LABELS[category]}
      </p>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

export default function VariantD({ m, preview }: { m: CreditModel; preview: boolean }) {
  const { totals, used, remaining } = m;
  const shown = ORDER.filter((c) => m.shown.includes(c));
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(m.backToEdit);
  close.current = m.backToEdit;
  useEffect(() => {
    if (!m.reviewing) return;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [m.reviewing]);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2">
        <h1 className="font-display text-4xl uppercase">your credits</h1>
        <p className="font-data text-sm text-off-white/60">{EVENT} · all open incentives</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-5 font-data text-sm">
        {shown.map((c) => (
          <span key={c} className={`font-bold ${ACCENT[c].text}`}>
            {LABELS[c]} credit {fmt(totals[c])} · only for {LABELS[c].toLowerCase()}
          </span>
        ))}
        <WalletLine m={m} />
      </div>

      {!shown.length ? (
        <section className="btrl-panel p-5 md:p-6">
          <NoCredit />
        </section>
      ) : (
        <>
          <div className="btrl-panel overflow-hidden">
            <div
              className={`hidden ${COLS} px-4 py-2 border-b font-mono text-xs uppercase text-off-white/55`}
            >
              <span>Incentive</span>
              <span>Channel</span>
              <span>Current progress</span>
              <span>Category</span>
              <span>Amount</span>
            </div>
            <ul className="divide-y divide-off-white/10">
              {shown.includes('polls') &&
                POLLS.flatMap((poll) => {
                  const view = m.pollView(poll);
                  return view.options.map((o) => (
                    <Row
                      key={`polls:${o.id}`}
                      category="polls"
                      title={o.label}
                      sub={poll.title}
                      channel={channelLabel(poll.channelId)}
                      progress={{
                        value: o.current,
                        max: view.total,
                        previewPct: o.previewPct,
                        text: `${fmt(o.current)} of ${fmt(view.total)} in this poll`,
                      }}
                    >
                      <AmountControl m={m} t={o.target} compact />
                    </Row>
                  ));
                })}
              {shown.includes('goals') &&
                GOALS.map((goal) => {
                  const view = m.goalView(goal);
                  return (
                    <Row
                      key={`goals:${goal.id}`}
                      category="goals"
                      title={goal.title}
                      channel={channelLabel(goal.channelId)}
                      progress={{
                        value: view.current,
                        max: goal.target,
                        previewPct: view.previewPct,
                        text: `${fmt(view.current)} / ${fmt(goal.target)}`,
                      }}
                    >
                      <AmountControl m={m} t={view.target} compact />
                    </Row>
                  );
                })}
              {shown.includes('rewards') &&
                CREDIT_REWARDS.map((reward) => {
                  const left = m.stock[reward.id] ?? 0;
                  const quantity = m.selectionOf(reward.id, 'rewards')?.quantity ?? 0;
                  return (
                    <Row
                      key={`rewards:${reward.id}`}
                      category="rewards"
                      title={`${reward.title} · ${fmt(reward.price)}`}
                      channel={channelLabel(reward.channelId)}
                      progress={{ value: left, max: reward.stock, text: `${left} left` }}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          className="btrl-button btrl-button-outline text-sm px-3 py-1"
                          aria-label={`Decrease ${reward.title} quantity`}
                          disabled={!quantity}
                          onClick={() => m.setRewardQuantity(reward, quantity - 1)}
                        >
                          −
                        </button>
                        <span className="font-data">{quantity}</span>
                        <button
                          className="btrl-button text-sm px-3 py-1"
                          aria-label={`Increase ${reward.title} quantity`}
                          disabled={quantity >= left || remaining.rewards < reward.price}
                          onClick={() => m.setRewardQuantity(reward, quantity + 1)}
                        >
                          +
                        </button>
                      </div>
                      {reward.type === 'SHOUTOUT' && quantity > 0 && (
                        <input
                          aria-label="Shoutout message (optional)"
                          className="w-full px-2 py-1 mt-2 font-body text-sm"
                          maxLength={200}
                          placeholder="Shoutout message (optional)"
                          value={m.selectionOf(reward.id, 'rewards')?.message ?? ''}
                          onChange={(e) => m.setRewardMessage(reward.id, e.target.value)}
                        />
                      )}
                    </Row>
                  );
                })}
            </ul>
          </div>

          <div
            className={`sticky ${preview ? 'bottom-24' : 'bottom-0'} z-30 btrl-panel-dark shadow-lg p-3 mt-4`}
          >
            <ErrorAlert m={m} className="mb-3" />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {shown.map((c) => (
                <p key={c} className="font-data text-sm">
                  <span className={`font-bold ${ACCENT[c].text}`}>{LABELS[c]}</span>{' '}
                  <span className={remaining[c] < 0 ? 'text-red' : 'text-off-white/70'}>
                    {fmt(used[c])} used · {fmt(remaining[c])} left
                  </span>
                </p>
              ))}
              <button
                className="btrl-button ml-auto"
                disabled={!m.selections.length || m.overBudget}
                onClick={m.review}
              >
                review &amp; apply
              </button>
            </div>
          </div>
        </>
      )}

      {m.reviewing && (
        <div
          className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-3"
          onClick={(e) => e.target === e.currentTarget && m.backToEdit()}
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="credit-confirm-title"
            tabIndex={-1}
            className="btrl-panel-dark shadow-lg p-5 w-full max-w-lg max-h-[90vh] overflow-auto outline-none"
          >
            <h2 id="credit-confirm-title" className="font-display text-3xl mb-3">
              confirm credit use
            </h2>
            {shown
              .filter((c) => used[c] > 0)
              .map((c) => (
                <div key={c} className="mb-4">
                  <p className={`font-data font-bold text-sm ${ACCENT[c].text}`}>
                    {LABELS[c]} credit · {fmt(used[c])} used · {fmt(remaining[c])} {SINGULAR[c]}{' '}
                    credit stays
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
        </div>
      )}
    </>
  );
}
