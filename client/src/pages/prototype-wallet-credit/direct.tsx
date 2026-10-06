// THROWAWAY (#166): B2's calm split view for B4, B5 and B6, but every row carries one compact
// control that is always visible and changes the selection directly: no editor to open and no
// separate "set" step. Each variant supplies only its control.
import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  CREDIT_REWARDS,
  GOALS,
  POLLS,
  SINGULAR,
  channelTag,
  fmt,
  inputKey,
  parseCents,
  type Category,
  type CreditModel,
  type Reward,
  type Target,
} from './model';
import { Tag, ThinBar } from './quiet';
import { QuietSplit } from './VariantB2';

export type ControlProps = {
  m: CreditModel;
  t: Target;
  // Text being typed for this row, if any. Absent means the row shows its committed amount.
  draft: string | undefined;
  setDraft: (text: string | null) => void;
  // Commits the typed text (empty removes); keeps it when it is not a usable amount.
  commitDraft: () => void;
  invalid: boolean;
};
type Draft = { t: Target; text: string };

// Literal class names so Tailwind keeps them. Important, because the list's divide-y colour
// would otherwise win over the left edge colour.
const EDGE: Record<Category, string> = {
  rewards: '!border-l-pink-pale/70',
  polls: '!border-l-d-yellow/70',
  goals: '!border-l-green/70',
};

export function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="w-7 h-7 shrink-0 rounded-sm border border-off-white/25 font-data text-off-white/80 hover:border-off-white/60 disabled:opacity-30 disabled:hover:border-off-white/25"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// "max" text link. `reveal` holds the visibility classes, so each variant decides when it shows.
export function MaxLink({
  t,
  reveal,
  onClick,
}: {
  t: Target;
  reveal: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`Use all remaining ${SINGULAR[t.category]} credit on ${t.label}`}
      className={`font-data text-xs text-off-white/55 hover:text-off-white underline underline-offset-2 ${reveal}`}
      // Keep focus in the amount field, so the link does not hide between press and click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      max
    </button>
  );
}

// The amount in B5 and B6: shows the committed amount; tap it to type an exact amount.
// Enter or leaving the field commits; Escape cancels.
export function TypedAmount({
  t,
  cents,
  draft,
  setDraft,
  commitDraft,
  invalid,
}: Omit<ControlProps, 'm'> & { cents: number }) {
  const cancelled = useRef(false);
  if (draft === undefined)
    return (
      <button
        aria-label={`${t.label} credit ${fmt(cents)}. Type an amount`}
        className={`w-16 text-right font-data text-sm underline decoration-dotted underline-offset-4 ${cents ? '' : 'text-off-white/45 decoration-off-white/30'}`}
        onClick={() => setDraft(cents ? (cents / 100).toFixed(2) : '')}
      >
        {fmt(cents)}
      </button>
    );
  return (
    <input
      aria-label={`${t.label} credit in dollars`}
      aria-invalid={invalid}
      type="text"
      inputMode="decimal"
      autoFocus
      placeholder="0.00"
      className={`w-16 px-1.5 py-0.5 border font-data text-sm text-right ${invalid ? '!border-red' : ''}`}
      value={draft}
      onFocus={(e) => {
        cancelled.current = false;
        e.target.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => !cancelled.current && commitDraft()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(null);
        }
      }}
    />
  );
}

const isSettled = (m: CreditModel, { t, text }: Draft) => {
  const selected = m.selectionOf(t.id, t.category)?.cents;
  return text.trim() ? parseCents(text) === selected : selected === undefined;
};

// Row message. `soft` problems are unfinished typing ("0.", ".") and stay hidden while focused.
function problemOf(m: CreditModel, t: Target, draft: string | undefined) {
  const max = m.maxFor(t);
  const left = {
    text: `Only ${fmt(Math.max(0, max))} ${SINGULAR[t.category]} credit left`,
    soft: false,
  };
  if (draft?.trim()) {
    const cents = parseCents(draft);
    if (cents === null)
      return { text: 'Use dollars and cents, like 4.25', soft: /^\.?$/.test(draft.trim()) };
    if (cents < 1) return { text: 'Enter more than $0, or clear it', soft: true };
    return cents > max ? left : null;
  }
  return (m.selectionOf(t.id, t.category)?.cents ?? 0) > max ? left : null;
}

function Row({
  category,
  label,
  tag,
  selected,
  bar,
  control,
  message,
  extra,
}: {
  category: Category;
  label: string;
  tag?: string;
  selected: boolean;
  bar: ReactNode;
  control: ReactNode;
  message?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <li
      className={`group/row py-3 -ml-3 pl-2.5 border-l-2 ${selected ? EDGE[category] : '!border-l-transparent'}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
        <div className="min-w-0 flex-1">
          <p className="font-data break-words">
            {label}
            {tag && <Tag>{tag}</Tag>}
          </p>
          <div className="mt-1.5">{bar}</div>
        </div>
        <div className="sm:shrink-0">{control}</div>
      </div>
      {message}
      {extra}
    </li>
  );
}

function RewardStepper({ m, reward }: { m: CreditModel; reward: Reward }) {
  const quantity = m.selectionOf(reward.id, 'rewards')?.quantity ?? 0;
  const left = m.stock[reward.id] ?? 0;
  return (
    <div className="flex items-center gap-1.5 font-data text-sm">
      <StepButton
        label={`Decrease ${reward.title} quantity`}
        disabled={!quantity}
        onClick={() => m.setRewardQuantity(reward, quantity - 1)}
      >
        −
      </StepButton>
      <span className="w-8 text-center">{quantity}</span>
      <StepButton
        label={`Increase ${reward.title} quantity`}
        disabled={quantity >= left || m.remaining.rewards < reward.price}
        onClick={() => m.setRewardQuantity(reward, quantity + 1)}
      >
        +
      </StepButton>
    </div>
  );
}

function CategoryList({
  m,
  category,
  Control,
  drafts,
  setDraft,
}: {
  m: CreditModel;
  category: Category;
  Control: ComponentType<ControlProps>;
  drafts: Record<string, Draft>;
  setDraft: (t: Target, text: string | null) => void;
}) {
  const accent = { rewards: 'bg-pink-pale', polls: 'bg-d-yellow', goals: 'bg-green' }[category];
  const targetRow = (t: Target, bar: ReactNode, tag?: string) => {
    const draft = drafts[inputKey(t.category, t.id)]?.text;
    const selected = m.selectionOf(t.id, t.category);
    const problem = problemOf(m, t, draft);
    const pending = !problem && draft !== undefined && !isSettled(m, { t, text: draft });
    const commitDraft = () => {
      if (draft === undefined) return;
      if (!draft.trim()) {
        if (selected) m.remove(t.id, t.category);
        setDraft(t, null);
        return;
      }
      const cents = parseCents(draft);
      if (cents !== null && (cents === selected?.cents || m.setCents(t, cents))) setDraft(t, null);
    };
    return (
      <Row
        key={t.id}
        category={category}
        label={t.label}
        tag={tag}
        selected={Boolean(selected)}
        bar={bar}
        control={
          <Control
            m={m}
            t={t}
            draft={draft}
            setDraft={(text) => setDraft(t, text)}
            commitDraft={commitDraft}
            invalid={Boolean(problem && !problem.soft)}
          />
        }
        message={
          problem ? (
            <p
              className={`mt-1 font-body text-xs text-red ${problem.soft ? 'group-focus-within/row:hidden' : ''}`}
            >
              {problem.text}
            </p>
          ) : pending ? (
            <p className="mt-1 font-body text-xs text-off-white/50 group-focus-within/row:hidden">
              Not added yet · press Enter in the amount
            </p>
          ) : null
        }
      />
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
  // Rewards keep whole-unit quantity steppers in every variant.
  return (
    <ul className="divide-y divide-off-white/5">
      {CREDIT_REWARDS.map((reward) => {
        const selection = m.selectionOf(reward.id, 'rewards');
        const left = m.stock[reward.id] ?? 0;
        return (
          <Row
            key={reward.id}
            category="rewards"
            label={`${reward.title} · ${fmt(reward.price)}`}
            tag={channelTag(reward.channelId)}
            selected={Boolean(selection)}
            bar={
              <p className="font-data text-xs text-off-white/45">
                {left ? `${left} left` : 'sold out'}
              </p>
            }
            control={<RewardStepper m={m} reward={reward} />}
            extra={
              reward.type === 'SHOUTOUT' &&
              selection && (
                <input
                  aria-label="Shoutout message (optional)"
                  className="w-full px-3 py-1.5 mt-2 font-body text-sm"
                  maxLength={200}
                  placeholder="Shoutout message (optional)"
                  value={selection.message ?? ''}
                  onChange={(e) => m.setRewardMessage(reward.id, e.target.value)}
                />
              )
            }
          />
        );
      })}
    </ul>
  );
}

export function DirectSplit({
  m,
  Control,
  hint,
}: {
  m: CreditModel;
  Control: ComponentType<ControlProps>;
  hint: string;
}) {
  // Typed text that differs from the committed amount, by row. Lives here, not in the model,
  // so switching layouts always shows the committed picks.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const setDraft = (t: Target, text: string | null) =>
    setDrafts((previous) => {
      const key = inputKey(t.category, t.id);
      const next = Object.fromEntries(Object.entries(previous).filter(([k]) => k !== key));
      return text === null ? next : { ...next, [key]: { t, text } };
    });
  const blocked = Object.values(drafts).filter((d) => !isSettled(m, d)).length;
  return (
    <QuietSplit
      m={m}
      hint={hint}
      blocked={blocked}
      onRemove={(s) => setDraft(s, null)}
      rows={(c) => (
        <CategoryList m={m} category={c} Control={Control} drafts={drafts} setDraft={setDraft} />
      )}
    />
  );
}
