// PROTOTYPE — throwaway (#157). Shared state + small atoms. Each variant owns
// its own layout; only item-level pieces are shared.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useCart } from '../../context/CartContext';
import type { Goal, Poll, Reward } from '../../types';
import {
  CATEGORY_LABEL,
  FIXTURE_GOALS,
  FIXTURE_POLLS,
  FIXTURE_REWARDS,
  MIN_PLEDGE_CENTS,
  PRESETS_CENTS,
  allocate,
  canCheckout,
  fmt,
  parseDollars,
  pools,
  raiseTo,
  used,
  type Category,
  type PoolStatus,
  type Selection,
} from './model';

export interface Proto {
  rewards: Reward[];
  polls: Poll[];
  goals: Goal[];
  usingFixtures: boolean;
  defaultGoalIds: string[];
  pledge: number;
  setPledge: (c: number) => void;
  walletCents: number;
  setWalletCents: (c: number) => void;
  sels: Selection[];
  setSel: (s: Omit<Selection, 'order'>) => void;
  remove: (key: string) => void;
  clear: () => void;
  comment: string;
  setComment: (s: string) => void;
}

export function useProto(): Proto {
  const cart = useCart();
  const live = cart.rewards.length + cart.polls.length + cart.goals.length > 0;
  const rewards = live ? cart.rewards : FIXTURE_REWARDS;
  const polls = live ? cart.polls : FIXTURE_POLLS;
  const goals = live ? cart.goals : FIXTURE_GOALS;
  // Stand-in for the Channel's moderator-ordered default goal list (#155):
  // the first two goals. The first is often nearly complete, to show "first
  // eligible wins" and overshoot.
  const defaultGoalIds = useMemo(() => goals.slice(0, 2).map((g) => g.id), [goals]);

  const [pledge, setPledge] = useState(0);
  const [walletCents, setWalletCents] = useState(0);
  const [sels, setSels] = useState<Selection[]>([]);
  const [comment, setComment] = useState('');
  const [counter, setCounter] = useState(0);

  const setSel = useCallback(
    (s: Omit<Selection, 'order'>) => {
      setSels((prev) => {
        const i = prev.findIndex((p) => p.key === s.key);
        if (s.cents <= 0) return prev.filter((p) => p.key !== s.key);
        if (i >= 0) return prev.map((p, j) => (j === i ? { ...p, ...s } : p));
        return [...prev, { ...s, order: counter }];
      });
      setCounter((c) => c + 1);
    },
    [counter],
  );
  const remove = useCallback((key: string) => setSels((p) => p.filter((s) => s.key !== key)), []);
  const clear = useCallback(() => setSels([]), []);

  return {
    rewards,
    polls,
    goals,
    usingFixtures: !live,
    defaultGoalIds,
    pledge,
    setPledge,
    walletCents,
    setWalletCents,
    sels,
    setSel,
    remove,
    clear,
    comment,
    setComment,
  };
}

// ---------- atoms ----------

export function PoolMeter({ s, compact = false }: { s: PoolStatus; compact?: boolean }) {
  const pct = s.pool > 0 ? Math.min(100, (s.used / s.pool) * 100) : s.used > 0 ? 100 : 0;
  const over = s.over > 0;
  return (
    <div className={compact ? 'min-w-0 flex-1' : ''} data-testid={`pool-${s.category}`}>
      <div className="flex justify-between font-data text-xs uppercase tracking-wider">
        <span className={over ? 'text-[color:var(--red)]' : 'text-off-white/70'}>
          {CATEGORY_LABEL[s.category]}
        </span>
        <span className={over ? 'text-[color:var(--red)] font-bold' : 'text-off-white'}>
          {fmt(s.used)} / {fmt(s.pool)}
        </span>
      </div>
      <div className={`${compact ? 'h-1.5' : 'h-2.5'} rounded-sm overflow-hidden mt-1`} style={{ background: 'rgba(239,238,236,.1)' }}>
        <div
          className="h-full transition-all"
          style={{ width: `${pct}%`, background: over ? 'var(--red)' : 'var(--grad)' }}
        />
      </div>
      {!compact && (
        <p className="font-body text-xs text-off-white/55 mt-1">
          {over
            ? `${fmt(s.over)} over your donation`
            : s.used === s.pool
              ? 'pool fully used'
              : `${fmt(s.pool - s.used)} left in this pool`}
        </p>
      )}
    </div>
  );
}

export function OverageBanner({ p }: { p: Proto }) {
  const overs = pools(p.pledge, p.sels).filter((s) => s.over > 0);
  if (overs.length === 0) return null;
  const target = raiseTo(p.pledge, p.sels);
  return (
    <div className="p-3 rounded-sm my-3" style={{ background: 'rgba(252,28,103,.14)' }} role="alert">
      <p className="font-data text-sm" style={{ color: 'var(--pink-pale)' }}>
        {overs
          .map((o) => `Your ${CATEGORY_LABEL[o.category]} add up to ${fmt(o.used)}`)
          .join('; ')}
        {' '}— more than your {fmt(p.pledge)} donation.
      </p>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <button className="btrl-button" onClick={() => p.setPledge(target)}>
          raise my donation to {fmt(target)}
        </button>
        <span className="font-body text-xs text-off-white/55">or remove items. Checkout is blocked until it fits.</span>
      </div>
    </div>
  );
}

export function AmountInput({
  p,
  big = false,
  autoFocus = false,
}: {
  p: Proto;
  big?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(p.pledge ? (p.pledge / 100).toString() : '');
  useEffect(() => {
    setText(p.pledge ? (p.pledge / 100).toString() : '');
  }, [p.pledge]);
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {PRESETS_CENTS.map((c) => (
          <button
            key={c}
            onClick={() => p.setPledge(c)}
            className={`font-data font-bold ${big ? 'text-xl px-5 py-3' : 'text-sm px-3 py-1.5'} rounded-sm ${
              p.pledge === c ? 'text-black' : 'text-off-white/80'
            }`}
            style={{ background: p.pledge === c ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)' }}
          >
            {fmt(c)}
          </button>
        ))}
        <label className="flex items-center gap-1 font-data">
          <span className={big ? 'text-xl' : ''}>$</span>
          <input
            autoFocus={autoFocus}
            aria-label="pledge amount"
            inputMode="decimal"
            className={`bg-transparent border-b border-off-white/30 focus:outline-none ${big ? 'text-xl w-28' : 'w-20'}`}
            placeholder="other"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => p.setPledge(parseDollars(text))}
            onKeyDown={(e) => e.key === 'Enter' && p.setPledge(parseDollars(text))}
          />
        </label>
      </div>
      {p.pledge > 0 && p.pledge < MIN_PLEDGE_CENTS && (
        <p className="text-xs font-data" style={{ color: 'var(--red)' }}>
          minimum is {fmt(MIN_PLEDGE_CENTS)}
        </p>
      )}
    </div>
  );
}

function MoneyField({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (c: number) => void;
  label: string;
}) {
  const [t, setT] = useState(value ? (value / 100).toString() : '');
  useEffect(() => setT(value ? (value / 100).toString() : ''), [value]);
  return (
    <span className="inline-flex items-center gap-1 font-data text-sm">
      $
      <input
        aria-label={label}
        inputMode="decimal"
        className="bg-transparent border-b border-off-white/30 w-16 focus:outline-none"
        placeholder="0"
        value={t}
        onChange={(e) => setT(e.target.value)}
        onBlur={() => onCommit(parseDollars(t))}
        onKeyDown={(e) => e.key === 'Enter' && onCommit(parseDollars(t))}
      />
    </span>
  );
}

/** "+ rest of pool" quick-fill: sets this line so the category exactly uses the pool. */
function restOf(p: Proto, cat: Category, key: string): number {
  const others = used(
    p.sels.filter((s) => s.key !== key),
    cat,
  );
  return Math.max(0, p.pledge - others);
}

export function RewardsPicker({ p }: { p: Proto }) {
  return (
    <ul className="space-y-2">
      {p.rewards.map((r) => {
        const key = `REWARD:${r.id}`;
        const sel = p.sels.find((s) => s.key === key);
        const qty = sel?.quantity ?? 0;
        const left = r.quantity_total == null ? null : r.quantity_total - r.quantity_claimed;
        const setQty = (q: number) =>
          p.setSel({ key, category: 'rewards', targetId: r.id, label: r.title, cents: q * r.cost_cents, quantity: q });
        return (
          <li key={r.id} className="btrl-panel p-3 flex items-center justify-between gap-3">
            <div>
              <p className="font-data font-bold">{r.title}</p>
              <p className="font-body text-xs text-off-white/55">
                {fmt(r.cost_cents)} each{left != null ? ` · ${left} left` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2 font-data">
              <button className="btrl-button btrl-button-outline px-2 py-0.5" disabled={qty === 0} onClick={() => setQty(qty - 1)}>
                −
              </button>
              <span className="w-5 text-center">{qty}</span>
              <button className="btrl-button btrl-button-outline px-2 py-0.5" disabled={left != null && qty >= left} onClick={() => setQty(qty + 1)}>
                +
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PollsPicker({ p }: { p: Proto }) {
  return (
    <ul className="space-y-3">
      {p.polls.map((poll) => (
        <li key={poll.id} className="btrl-panel p-3">
          <p className="font-data font-bold mb-2">{poll.title}</p>
          <ul className="space-y-1.5">
            {poll.options.map((o) => {
              const key = `POLL_VOTE:${o.id}`;
              const sel = p.sels.find((s) => s.key === key);
              const set = (c: number) =>
                p.setSel({ key, category: 'polls', targetId: o.id, pollId: poll.id, label: `${poll.title} — ${o.label}`, cents: c });
              return (
                <li key={o.id} className="flex items-center justify-between gap-2">
                  <span className="font-body text-sm">
                    {o.label} <span className="text-off-white/40 text-xs">{fmt(o.votes_cents)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <MoneyField label={`vote ${o.label}`} value={sel?.cents ?? 0} onCommit={set} />
                    <button
                      className="font-data text-xs text-d-yellow hover:text-off-white"
                      onClick={() => set(restOf(p, 'polls', key))}
                      title="put the rest of the poll pool here"
                    >
                      + rest
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function GoalsPicker({ p }: { p: Proto }) {
  return (
    <ul className="space-y-2">
      {p.goals.map((g) => {
        const key = `GOAL:${g.id}`;
        const sel = p.sels.find((s) => s.key === key);
        const set = (c: number) => p.setSel({ key, category: 'goals', targetId: g.id, label: g.title, cents: c });
        const isDefault = p.defaultGoalIds[0] === g.id;
        return (
          <li key={g.id} className="btrl-panel p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-data font-bold">
                {g.title}
                {isDefault && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm" style={{ background: 'rgba(92,189,125,.2)', color: 'var(--green)' }}>
                    default
                  </span>
                )}
              </p>
              <span className="flex items-center gap-2">
                <MoneyField label={`goal ${g.title}`} value={sel?.cents ?? 0} onCommit={set} />
                <button className="font-data text-xs text-d-yellow hover:text-off-white" onClick={() => set(restOf(p, 'goals', key))}>
                  + rest
                </button>
              </span>
            </div>
            <div className="h-1.5 rounded-sm mt-2 overflow-hidden" style={{ background: 'rgba(239,238,236,.1)' }}>
              <div className="h-full" style={{ width: `${Math.min(100, (g.current_cents / g.target_cents) * 100)}%`, background: 'var(--green)' }} />
            </div>
            <p className="font-body text-xs text-off-white/55 mt-1">
              {fmt(g.current_cents)} of {fmt(g.target_cents)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export const PICKERS: Record<Category, (props: { p: Proto }) => ReactNode> = {
  rewards: RewardsPicker,
  polls: PollsPicker,
  goals: GoalsPicker,
};

/** Review: own vs auto-allocated per line. Auto rows have no remove control (rule 5 as amended). */
export function Review({ p, onEdit, dense = false }: { p: Proto; onEdit?: () => void; dense?: boolean }) {
  const a = allocate(p.pledge, p.sels, p.goals, p.defaultGoalIds);
  const ok = canCheckout(p.pledge, p.sels);
  const walletApplied = Math.min(p.walletCents, p.pledge);
  const charge = p.pledge - walletApplied;
  const [sent, setSent] = useState(false);
  return (
    <div className={dense ? 'text-sm' : ''}>
      {(['rewards', 'polls', 'goals'] as const).map((cat) => {
        const lines = a.lines.filter((l) => l.category === cat);
        return (
          <div key={cat} className="mb-3">
            <p className="font-mono text-xs tracking-widest uppercase text-d-yellow">
              {CATEGORY_LABEL[cat]} · pool {fmt(p.pledge)}
            </p>
            {lines.length === 0 && <p className="font-body text-xs text-off-white/40">nothing</p>}
            <ul>
              {lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-2 font-body text-sm py-0.5">
                  <span>
                    {l.label}
                    {l.autoCents > 0 && (
                      <span
                        title="Auto-allocated. It cannot be removed; it makes full use of your donation."
                        className="ml-1.5 text-[10px] uppercase tracking-wider px-1 py-0.5 rounded-sm"
                        style={{ background: 'rgba(115,78,158,.35)' }}
                      >
                        🔒 auto{l.donorCents === 0 && l.why ? ` · ${l.why}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="font-data whitespace-nowrap">
                    {l.donorCents > 0 && fmt(l.donorCents)}
                    {l.donorCents > 0 && l.autoCents > 0 && ' + '}
                    {l.autoCents > 0 && <span className="text-[color:var(--purple)]">{fmt(l.autoCents)}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="font-body text-xs text-off-white/55">{a.explain[cat]}</p>
          </div>
        );
      })}
      <div className="btrl-sep my-2" />
      <dl className="font-data text-sm grid grid-cols-2 gap-y-0.5">
        <dt className="text-off-white/60">your donation</dt>
        <dd className="text-right">{fmt(p.pledge)}</dd>
        {walletApplied > 0 && (
          <>
            <dt className="text-off-white/60">wallet credit applied</dt>
            <dd className="text-right">−{fmt(walletApplied)}</dd>
          </>
        )}
        <dt className="font-bold">card charge</dt>
        <dd className="text-right font-bold">{fmt(charge)}</dd>
        {a.walletCredit > 0 && (
          <>
            <dt className="text-off-white/60">back to your wallet</dt>
            <dd className="text-right">{fmt(a.walletCredit)}</dd>
          </>
        )}
      </dl>
      <label className="block mt-3">
        <span className="font-mono text-xs uppercase tracking-widest text-off-white/55">message (optional)</span>
        <textarea className="w-full mt-1 bg-transparent border border-off-white/20 rounded-sm p-2 font-body text-sm" rows={dense ? 2 : 3} value={p.comment} onChange={(e) => p.setComment(e.target.value)} />
      </label>
      <div className="flex gap-2 mt-3">
        {onEdit && (
          <button className="btrl-button btrl-button-outline" onClick={onEdit}>
            ← edit
          </button>
        )}
        <button className="btrl-button flex-1" disabled={!ok} onClick={() => setSent(true)} style={{ opacity: ok ? 1 : 0.4 }}>
          pay {fmt(charge)} with Stripe
        </button>
      </div>
      {sent && (
        <pre className="mt-2 text-[10px] p-2 rounded-sm overflow-auto" style={{ background: 'rgba(0,0,0,.4)' }}>
          {`PROTOTYPE: would POST /api/pledge\n${JSON.stringify(
            {
              pledge_amount_cents: p.pledge,
              comment: p.comment || undefined,
              items: a.lines
                .filter((l) => l.donorCents > 0)
                .map((l) => ({ category: l.category, label: l.label, amount_cents: l.donorCents + l.autoCents, auto_cents: l.autoCents })),
              default_goal_remainder_cents: a.lines.find((l) => l.donorCents === 0)?.autoCents ?? 0,
            },
            null,
            2,
          )}`}
        </pre>
      )}
    </div>
  );
}

/** Rule-5 explainer in one line, for headers. */
export function poolSummary(p: Proto): string {
  return pools(p.pledge, p.sels)
    .map((s) => `${CATEGORY_LABEL[s.category]} ${fmt(s.used)}/${fmt(s.pool)}`)
    .join(' · ');
}

export function StateDump({ p }: { p: Proto }) {
  const [open, setOpen] = useState(false);
  const a = allocate(p.pledge, p.sels, p.goals, p.defaultGoalIds);
  return (
    <div className="fixed top-20 right-2 z-50 text-[11px] font-mono max-w-xs">
      <button className="px-2 py-1 rounded-sm" style={{ background: '#000', color: '#0f0' }} onClick={() => setOpen((o) => !o)}>
        {open ? 'hide' : 'show'} prototype state
      </button>
      {open && (
        <div className="mt-1 p-2 rounded-sm max-h-[70vh] overflow-auto" style={{ background: 'rgba(0,0,0,.9)', color: '#0f0' }}>
          <p>{p.usingFixtures ? 'data: FIXTURES (no live incentives)' : 'data: live channel incentives'}</p>
          <label className="block my-1">
            pretend wallet balance ${' '}
            <input className="bg-transparent border-b border-green-700 w-12" defaultValue="0" onBlur={(e) => p.setWalletCents(parseDollars(e.target.value))} />
          </label>
          <pre>{JSON.stringify({ pledge: p.pledge, canCheckout: canCheckout(p.pledge, p.sels), pools: pools(p.pledge, p.sels), sels: p.sels, allocation: a }, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}

// ---------- variant switcher (dev only) ----------

export const VARIANTS: { key: string; name: string }[] = [
  { key: 'current', name: 'Current shopping cart' },
  { key: 'A', name: 'Amount gate + sticky pool bar' },
  { key: 'B', name: 'One-page budget sheet' },
  { key: 'C', name: 'Guided questions' },
];

export function PrototypeSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const current = params.get('variant') ?? 'current';
  const idx = Math.max(0, VARIANTS.findIndex((v) => v.key === current));
  const go = useCallback(
    (d: number) => {
      const next = VARIANTS[(idx + d + VARIANTS.length) % VARIANTS.length]!;
      const sp = new URLSearchParams(location.search);
      sp.set('variant', next.key);
      navigate({ pathname: location.pathname, search: sp.toString() }, { replace: true });
    },
    [idx, location.pathname, location.search, navigate],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);
  if (import.meta.env.PROD) return null;
  const v = VARIANTS[idx]!;
  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 px-4 py-2 rounded-full shadow-2xl font-mono text-sm" style={{ background: '#fff', color: '#000' }}>
      <button aria-label="previous variant" onClick={() => go(-1)}>
        ◀
      </button>
      <span>
        PROTOTYPE {v.key} ({v.name})
      </span>
      <button aria-label="next variant" onClick={() => go(1)}>
        ▶
      </button>
    </div>
  );
}
