// THROWAWAY (#166): calm building blocks for the split-view variants. In B2, rows show a name
// and a thin bar; amount controls appear only in the one editor the donor opens.
import { type ReactNode } from 'react';
import {
  ACCENT,
  CREDIT_REWARDS,
  EVENT,
  GOALS,
  LABELS,
  POLLS,
  WALLET_CREDIT,
  channelTag,
  fmt,
  type Category,
  type CreditModel,
  type Reward,
  type Target,
} from './model';
import { CreditChanged } from './shared';

type M = { m: CreditModel };
// Key of the one open editor (`category:id`), or null.
export type OpenEditor = { open: string | null; setOpen: (key: string | null) => void };
const keyOf = (category: Category, id: string) => `${category}:${id}`;

export function QuietHeader() {
  return (
    <header className="mb-6">
      <h1 className="font-display text-4xl uppercase">your credits</h1>
      <p className="font-body text-sm text-off-white/60">
        {EVENT} · each credit works only on its own kind of incentive.
      </p>
    </header>
  );
}

export function WalletFooter() {
  return (
    <p className="font-data text-xs text-off-white/45">
      Wallet credit {fmt(WALLET_CREDIT)} · for new donations
    </p>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 font-mono text-[11px] font-normal uppercase tracking-wide text-off-white/40">
      {children}
    </span>
  );
}

export function ThinBar({
  value,
  max,
  previewPct,
  accent,
  fill = 'bg-off-white/30',
}: {
  value: number;
  max: number;
  previewPct?: number;
  accent: string;
  fill?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const preview = Math.min(100, previewPct ?? 0);
  return (
    <div className="relative h-1 rounded-full bg-off-white/10 overflow-hidden">
      {preview > pct && (
        <div className={`absolute inset-y-0 left-0 ${accent}`} style={{ width: `${preview}%` }} />
      )}
      <div className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Row({
  category,
  label,
  tag,
  pill,
  canAdd,
  isOpen,
  onToggle,
  bar,
  children,
}: {
  category: Category;
  label: string;
  tag?: string;
  pill?: string;
  canAdd: boolean;
  isOpen: boolean;
  onToggle: () => void;
  bar: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="py-3">
      <button
        type="button"
        className="w-full flex items-center gap-3 text-left font-data disabled:cursor-default"
        aria-expanded={isOpen}
        disabled={!pill && !canAdd}
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1 break-words">
          {label}
          {tag && <Tag>{tag}</Tag>}
        </span>
        {pill ? (
          <span
            className={`shrink-0 rounded-full border px-2 text-sm ${ACCENT[category].border} ${ACCENT[category].text}`}
          >
            {pill}
          </span>
        ) : canAdd ? (
          <span className="shrink-0 text-sm text-off-white/50">
            {isOpen ? 'close' : '+'}
            {!isOpen && <span className="hidden sm:inline"> add credit</span>}
          </span>
        ) : null}
      </button>
      <div className="mt-1.5">{bar}</div>
      {isOpen && <div className="mt-3">{children}</div>}
    </li>
  );
}

function InlineError({ m }: M) {
  if (!m.error) return null;
  return (
    <p role="alert" className="font-body text-sm text-red mt-2">
      {m.error}
    </p>
  );
}

function AmountEditor({ m, t, close }: M & { t: Target; close: () => void }) {
  const selected = m.selectionOf(t.id, t.category);
  const max = m.maxFor(t);
  const done = () => {
    if (!m.amountInput(t).trim()) {
      if (selected) m.remove(t.id, t.category);
      close();
    } else if (m.chooseAmount(t)) close();
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-data text-sm">
        <label>
          ${' '}
          <input
            aria-label={`${t.label} credit in dollars`}
            type="text"
            inputMode="decimal"
            autoFocus
            className="w-24 px-2 py-1"
            value={m.amountInput(t)}
            onChange={(e) => m.setAmountInput(t, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && done()}
          />
        </label>
        {max > 0 && selected?.cents !== max && (
          <button
            className="text-d-yellow underline"
            onClick={() => {
              m.fillRemaining(t);
              close();
            }}
          >
            use all
          </button>
        )}
        <button className="btrl-button text-sm px-4 py-1" onClick={done}>
          done
        </button>
        {selected && (
          <button
            className="text-off-white/55 underline"
            onClick={() => {
              m.remove(t.id, t.category);
              close();
            }}
          >
            remove
          </button>
        )}
      </div>
      <InlineError m={m} />
    </>
  );
}

function RewardEditor({ m, reward, close }: M & { reward: Reward; close: () => void }) {
  const selection = m.selectionOf(reward.id, 'rewards');
  const quantity = selection?.quantity ?? 0;
  const left = m.stock[reward.id] ?? 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 font-data text-sm">
        <button
          aria-label={`Decrease ${reward.title} quantity`}
          className="rounded-full border border-off-white/25 w-8 h-8"
          disabled={!quantity}
          onClick={() => m.setRewardQuantity(reward, quantity - 1)}
        >
          −
        </button>
        <span className="font-data text-lg">{quantity}</span>
        <button
          aria-label={`Increase ${reward.title} quantity`}
          className="rounded-full border border-off-white/25 w-8 h-8"
          disabled={quantity >= left || m.remaining.rewards < reward.price}
          onClick={() => m.setRewardQuantity(reward, quantity + 1)}
        >
          +
        </button>
        <button className="btrl-button text-sm px-4 py-1" onClick={close}>
          done
        </button>
      </div>
      {reward.type === 'SHOUTOUT' && quantity > 0 && (
        <input
          aria-label="Shoutout message (optional)"
          className="w-full px-3 py-2 mt-3 font-body text-sm"
          maxLength={200}
          placeholder="Shoutout message (optional)"
          value={selection?.message ?? ''}
          onChange={(e) => m.setRewardMessage(reward.id, e.target.value)}
        />
      )}
      <InlineError m={m} />
    </>
  );
}

// The open incentives of one category as quiet rows. Only one editor is open at a time.
export function CategoryRows({
  m,
  category,
  open,
  setOpen,
}: M & OpenEditor & { category: Category }) {
  const accent = ACCENT[category].bg;
  const toggle = (t: Target) => {
    m.clearError();
    const key = keyOf(t.category, t.id);
    if (open === key) return setOpen(null);
    const cents = m.selectionOf(t.id, t.category)?.cents ?? m.maxFor(t);
    m.setAmountInput(t, cents > 0 ? (cents / 100).toFixed(2) : '');
    setOpen(key);
  };
  const close = () => setOpen(null);
  const targetRow = (t: Target, bar: ReactNode, tag?: string) => {
    const selected = m.selectionOf(t.id, t.category);
    return (
      <Row
        key={t.id}
        category={category}
        label={t.label}
        tag={tag}
        pill={selected ? fmt(selected.cents) : undefined}
        canAdd={m.maxFor(t) > 0}
        isOpen={open === keyOf(t.category, t.id)}
        onToggle={() => toggle(t)}
        bar={bar}
      >
        <AmountEditor m={m} t={t} close={close} />
      </Row>
    );
  };

  if (category === 'polls')
    return (
      <div className="space-y-5">
        {POLLS.map((poll) => {
          const view = m.pollView(poll);
          return (
            <div key={poll.id}>
              <p className="font-data font-bold text-sm text-off-white/75">
                {poll.title}
                <Tag>{channelTag(poll.channelId)}</Tag>
              </p>
              <ul className="divide-y divide-off-white/5">
                {view.options.map((o) =>
                  targetRow(
                    o.target,
                    <ThinBar
                      value={o.current}
                      max={view.total}
                      previewPct={o.previewPct}
                      accent={accent}
                    />,
                  ),
                )}
              </ul>
            </div>
          );
        })}
      </div>
    );
  if (category === 'goals')
    return (
      <ul className="divide-y divide-off-white/5">
        {GOALS.map((goal) => {
          const view = m.goalView(goal);
          return targetRow(
            view.target,
            <ThinBar
              value={view.current}
              max={goal.target}
              previewPct={view.previewPct}
              accent={accent}
            />,
            channelTag(goal.channelId),
          );
        })}
      </ul>
    );
  return (
    <ul className="divide-y divide-off-white/5">
      {CREDIT_REWARDS.map((reward) => {
        const selected = m.selectionOf(reward.id, 'rewards');
        const left = m.stock[reward.id] ?? 0;
        const key = keyOf('rewards', reward.id);
        return (
          <Row
            key={reward.id}
            category="rewards"
            label={`${reward.title} · ${fmt(reward.price)}`}
            tag={channelTag(reward.channelId)}
            pill={selected ? `×${selected.quantity} · ${fmt(selected.cents)}` : undefined}
            canAdd={left > 0 && m.remaining.rewards >= reward.price}
            isOpen={open === key}
            onToggle={() => {
              m.clearError();
              setOpen(open === key ? null : key);
            }}
            bar={
              <p className="font-data text-xs text-off-white/45">
                {left ? `${left} left` : 'sold out'}
              </p>
            }
          >
            <RewardEditor m={m} reward={reward} close={close} />
          </Row>
        );
      })}
    </ul>
  );
}

// The single review: what each category's credit goes to, then one apply.
export function QuietConfirm({ m, categories }: M & { categories: Category[] }) {
  return (
    <div>
      {categories
        .filter((c) => m.used[c] > 0)
        .map((c) => (
          <div key={c} className="mb-3">
            <p className={`font-data font-bold text-sm ${ACCENT[c].text}`}>
              {LABELS[c]} · {fmt(m.used[c])}
            </p>
            <ul className="font-data text-sm">
              {m.selections
                .filter((s) => s.category === c)
                .map((s) => (
                  <li key={s.id} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words text-off-white/80">
                      {s.label}
                      {s.quantity ? ` × ${s.quantity}` : ''}
                    </span>
                    <span>{fmt(s.cents)}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      <p className="font-body text-xs text-off-white/50 mb-4">
        No payment. Only incentive totals change.
      </p>
      <CreditChanged m={m} />
      {m.error && (
        <p role="alert" className="font-body text-sm text-red mb-3">
          {m.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button className="btrl-button" disabled={!m.canApply} onClick={m.apply}>
          apply credits
        </button>
        <button className="font-data text-sm text-off-white/60 underline" onClick={m.backToEdit}>
          edit
        </button>
      </div>
    </div>
  );
}
