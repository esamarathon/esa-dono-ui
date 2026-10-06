// THROWAWAY (#166): small atoms shared by the layout variants. No page layout lives here.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CATEGORIES,
  EVENT,
  LABELS,
  REGULAR_DRAFT,
  SINGULAR,
  STALE_DEMO_CENTS,
  WALLET_CREDIT,
  fmt,
  type Category,
  type CreditModel,
  type Reward,
  type Target,
  type Variant,
  VARIANTS,
  VARIANT_NAMES,
} from './model';

type M = { m: CreditModel };

export function AmountControl({
  m,
  t,
  compact = false,
}: M & {
  t: Target;
  compact?: boolean;
}) {
  const selection = m.selectionOf(t.id, t.category);
  const input = m.amountInput(t);
  const max = m.maxFor(t);
  const small = compact ? 'text-sm px-3 py-1' : 'text-sm';
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'mt-3'}`}>
      <label className="font-data text-sm">
        ${' '}
        <input
          aria-label={`${t.label} credit in dollars`}
          type="text"
          inputMode="decimal"
          className={compact ? 'w-20 px-2 py-1' : 'w-24 px-2 py-1'}
          placeholder="0.00"
          value={input}
          onChange={(e) => m.setAmountInput(t, e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && m.chooseAmount(t)}
        />
      </label>
      <button
        className={`btrl-button ${small}`}
        disabled={!input.trim()}
        onClick={() => m.chooseAmount(t)}
      >
        {compact ? 'set' : selection ? 'update' : 'add'}
      </button>
      <button
        className={`btrl-button btrl-button-outline ${small}`}
        disabled={max <= 0 || selection?.cents === max}
        onClick={() => m.fillRemaining(t)}
      >
        {compact ? 'max' : `use all remaining${max > 0 ? ` (${fmt(max)})` : ''}`}
      </button>
      {selection && (
        <>
          <button
            className={`btrl-button btrl-button-outline ${small}`}
            aria-label={`Remove ${t.label}`}
            onClick={() => m.remove(t.id, t.category)}
          >
            {compact ? '×' : 'remove'}
          </button>
          {!compact && (
            <span className="font-data text-green">Selected {fmt(selection.cents)}</span>
          )}
        </>
      )}
    </div>
  );
}

export function RewardControl({ m, reward }: M & { reward: Reward }) {
  const selection = m.selectionOf(reward.id, 'rewards');
  const quantity = selection?.quantity ?? 0;
  const left = m.stock[reward.id] ?? 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <button
          aria-label={`Decrease ${reward.title} quantity`}
          className="btrl-button btrl-button-outline"
          disabled={!selection}
          onClick={() => m.setRewardQuantity(reward, quantity - 1)}
        >
          −
        </button>
        <span className="font-data text-xl">{quantity}</span>
        <button
          aria-label={`Increase ${reward.title} quantity`}
          className="btrl-button"
          disabled={quantity >= left || m.remaining.rewards < reward.price}
          onClick={() => m.setRewardQuantity(reward, quantity + 1)}
        >
          +
        </button>
        <span className="font-data text-sm text-off-white/55">
          {left === 0
            ? 'sold out'
            : selection
              ? `${fmt(selection.cents)} selected`
              : 'not selected'}
        </span>
      </div>
      {reward.type === 'SHOUTOUT' && quantity > 0 && (
        <label className="block font-data font-bold text-sm mt-4">
          Shoutout message (optional)
          <input
            className="w-full px-3 py-2 mt-2 font-body font-normal"
            maxLength={200}
            placeholder="Your message to the stream"
            value={selection?.message ?? ''}
            onChange={(e) => m.setRewardMessage(reward.id, e.target.value)}
          />
        </label>
      )}
    </>
  );
}

export function ErrorAlert({ m, className = 'mb-4' }: M & { className?: string }) {
  if (!m.error) return null;
  return (
    <p role="alert" className={`btrl-panel-dark p-4 text-red font-body text-sm ${className}`}>
      {m.error}
    </p>
  );
}

export function WalletLine({ m }: M) {
  return (
    <div className="flex flex-wrap items-center gap-3 font-data text-sm">
      <p className="text-off-white/70">
        <strong className="text-off-white">Wallet credit {fmt(WALLET_CREDIT)}</strong> — used when
        you make a new donation
      </p>
      <button
        className="text-d-yellow underline"
        onClick={() => m.setExtraPanel(m.extraPanel === 'draft' ? null : 'draft')}
      >
        view draft
      </button>
    </div>
  );
}

export function NoCredit() {
  return (
    <div>
      <p className="font-display text-3xl">No credit left to use</p>
      <p className="font-body text-sm text-off-white/60 mt-1">
        All your {EVENT} category credit is applied. See where it came from and where it went below.
      </p>
    </div>
  );
}

export function SelectedList({ m, category }: M & { category: Category }) {
  return (
    <ul className="divide-y divide-off-white/10">
      {m.selections
        .filter((item) => item.category === category)
        .map((item) => (
          <li key={item.id} className="py-3 flex justify-between gap-4 font-data">
            <div className="min-w-0">
              <p className="font-bold break-words">
                {item.label}
                {item.quantity ? ` × ${item.quantity}` : ''}
              </p>
              <p className="text-sm text-off-white/55 break-words">{item.detail}</p>
              {item.message && (
                <p className="font-body text-sm text-off-white/60 break-words">“{item.message}”</p>
              )}
            </div>
            <span>{fmt(item.cents)}</span>
          </li>
        ))}
    </ul>
  );
}

export function NoPaymentNote({ className = '' }: { className?: string }) {
  return (
    <p className={`font-body text-sm text-off-white/60 ${className}`}>
      No payment or new donation. Applying credit changes incentive totals, not money totals. Wallet
      credit ({fmt(WALLET_CREDIT)}) is not used.
    </p>
  );
}

// Shown in every variant's review/confirm step: the stale-credit block and the demo trigger.
export function CreditChanged({ m }: M) {
  if (!m.creditChanged) return null;
  return (
    <div className="border-t py-4 mb-3">
      <p className="font-body text-sm text-red mb-3">
        Your credit changed since you opened this review. Nothing was applied. Refresh the balances
        and reconfirm; edit first if the selections no longer fit.
      </p>
      <p className="font-data text-sm text-off-white/60 mb-3">
        {CATEGORIES.filter((c) => m.reviewed?.[c] !== m.totals[c])
          .map(
            (c) => `${LABELS[c]}: reviewed ${fmt(m.reviewed?.[c] ?? 0)}, now ${fmt(m.totals[c])}`,
          )
          .join(' · ')}
      </p>
      <button className="btrl-button btrl-button-outline" onClick={m.refreshBalances}>
        refresh balances
      </button>
    </div>
  );
}

export function StaleDemoButton({ m, preview }: M & { preview: boolean }) {
  if (!preview) return null;
  return (
    <button
      className="block font-mono text-xs text-off-white/55 underline mt-6 text-left"
      disabled={m.staleSimulated || !m.staleCategory}
      onClick={m.simulateStale}
    >
      demo: reduce {m.staleCategory ? SINGULAR[m.staleCategory] : 'one category’s'} credit by{' '}
      {fmt(STALE_DEMO_CENTS)} while reviewing
    </button>
  );
}

export function Navbar({ m }: M) {
  const toggle = (panel: 'help' | 'draft') =>
    m.setExtraPanel(m.extraPanel === panel ? null : panel);
  return (
    <nav
      className="flex flex-wrap items-center gap-4 md:gap-6 px-4 md:px-6 py-4 border-b"
      style={{ background: 'var(--dark-gray)' }}
    >
      <button onClick={m.toTop} className="font-display text-2xl tracking-wide uppercase">
        esa dono
      </button>
      <button
        onClick={m.toTop}
        className="font-data font-bold text-sm tracking-wider uppercase text-off-white/55"
      >
        home
      </button>
      <button
        onClick={() => toggle('help')}
        className="font-data font-bold text-sm tracking-wider uppercase text-off-white/55"
      >
        help
      </button>
      <button
        onClick={m.toTop}
        className="font-data font-bold text-sm tracking-wider uppercase text-d-yellow"
      >
        wallet
      </button>
      <button
        onClick={() => toggle('draft')}
        className="btrl-button btrl-button-outline ml-auto text-sm"
      >
        resume $25 donation
      </button>
    </nav>
  );
}

export function ExtraPanel({ m }: M) {
  if (!m.extraPanel) return null;
  return (
    <aside className="btrl-panel-dark p-5 mb-6">
      <div className="flex justify-between gap-4">
        <h2 className="font-display text-2xl">
          {m.extraPanel === 'help' ? 'credit guide' : 'existing donation draft · $25.00'}
        </h2>
        <button className="text-d-yellow font-data" onClick={() => m.setExtraPanel(null)}>
          close
        </button>
      </div>
      {m.extraPanel === 'help' ? (
        <p className="font-body text-sm text-off-white/60 mt-2">
          When an incentive you paid for is reversed or rejected, the amount comes back as credit
          for the same category. Your credit for each category is combined across your donations to
          this Event. Use it on any open incentive of that category below, then apply everything in
          one review. No payment is made. Wallet credit is separate and is only used when you make a
          new donation.
        </p>
      ) : (
        <p className="font-body text-sm text-off-white/60 mt-2">
          Normal donation flow preview only · {REGULAR_DRAFT.channel} · $25.00 donation · 1 digital
          download selected. This separate mock draft stays untouched. Your {fmt(WALLET_CREDIT)}{' '}
          wallet credit is used there, not on this page.
        </p>
      )}
    </aside>
  );
}

export function History({ m }: M) {
  return (
    <details className="btrl-panel p-5 mt-8">
      <summary className="font-data font-bold text-sm cursor-pointer uppercase tracking-wide">
        where your credit came from
      </summary>
      <p className="font-body text-sm text-off-white/60 mt-3">
        Credit is used oldest donation first. You do not need to choose.
      </p>
      {[
        { title: EVENT, list: m.active },
        { title: 'Past Events', list: m.ended },
      ].map(({ title, list }) => (
        <div key={title} className="mt-5">
          <h3 className="font-display text-2xl">{title}</h3>
          <div className="space-y-4 mt-2">
            {list.map((d) => (
              <article key={d.id} className="border-t pt-3">
                <div className="flex flex-wrap justify-between gap-2 font-data text-sm">
                  <p>
                    <strong>{d.name}</strong> · {d.date} · {d.channel}
                  </p>
                  <p className="text-off-white/60">Original pledge {fmt(d.original)}</p>
                </div>
                <ul className="mt-2 space-y-1 list-disc pl-5 font-body text-sm text-off-white/60 break-words">
                  {d.history.map((line, index) => (
                    <li key={index}>{line.text}</li>
                  ))}
                </ul>
                <p className="font-data text-sm mt-2">
                  {d.ended
                    ? 'Event ended · history only'
                    : CATEGORIES.some((c) => d.credit[c] > 0)
                      ? `Remaining: ${CATEGORIES.filter((c) => d.credit[c] > 0)
                          .map((c) => `${LABELS[c]} ${fmt(d.credit[c])}`)
                          .join(' · ')}`
                      : 'Remaining: no credit left'}
                </p>
              </article>
            ))}
          </div>
        </div>
      ))}
    </details>
  );
}

export function DemoState({ m, variant }: M & { variant: Variant }) {
  return (
    <details className="btrl-panel-dark p-4 mt-8">
      <summary className="font-mono text-xs text-off-white/55 cursor-pointer">
        DEMO STATE · credit / selections / untouched draft
      </summary>
      <pre className="text-xs font-mono overflow-auto p-3 mt-3 max-h-96">
        {JSON.stringify(
          {
            variant,
            reviewing: m.reviewing,
            category_totals_cents: m.totals,
            selected_cents_by_category: m.used,
            remaining_cents_by_category: m.remaining,
            reviewed_category_totals_cents: m.reviewed,
            per_source_credit_cents: m.donations.map((d) => ({
              id: d.id,
              date: d.date,
              channel: d.channel,
              ended: d.ended,
              credit: d.credit,
            })),
            selections: m.selections,
            wallet_credit_cents: WALLET_CREDIT,
            regular_draft: REGULAR_DRAFT,
            stock: m.stock,
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}

export function Switcher({ variant }: { variant: Variant }) {
  const location = useLocation();
  const navigate = useNavigate();
  const go = (offset: number) => {
    const next =
      VARIANTS[(VARIANTS.indexOf(variant) + offset + VARIANTS.length) % VARIANTS.length] ?? 'A';
    const params = new URLSearchParams(location.search);
    params.set('variant', next);
    navigate(`${location.pathname}?${params}`, { replace: true });
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select'))
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        goRef.current(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 btrl-panel-dark shadow-lg p-2 flex items-center gap-2 w-max max-w-[95vw]">
      <button
        className="btrl-button btrl-button-outline shrink-0 px-3 py-1"
        aria-label="Previous credits layout"
        onClick={() => go(-1)}
      >
        ←
      </button>
      <p className="font-mono text-xs text-d-yellow min-w-0 text-center leading-tight">
        PROTOTYPE · {variant} / {VARIANTS.length} ·{' '}
        <span className="font-data font-bold text-sm text-off-white">{VARIANT_NAMES[variant]}</span>
      </p>
      <button
        className="btrl-button shrink-0 px-3 py-1"
        aria-label="Next credits layout"
        onClick={() => go(1)}
      >
        →
      </button>
    </div>
  );
}
