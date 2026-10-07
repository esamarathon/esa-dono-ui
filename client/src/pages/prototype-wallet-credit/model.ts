// THROWAWAY (#166): fixtures and credit rules shared by every layout variant, so the rules
// stay identical while the layouts differ. No auth, API, checkout or storage.
import { useRef, useState } from 'react';

export const CATEGORIES = ['rewards', 'polls', 'goals'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Totals = Record<Category, number>;
export const LABELS: Record<Category, string> = {
  rewards: 'Rewards',
  polls: 'Polls',
  goals: 'Goals',
};
export const SINGULAR: Record<Category, string> = {
  rewards: 'reward',
  polls: 'poll',
  goals: 'goal',
};
// Literal class names so Tailwind keeps them. One accent per category keeps balances distinct.
export const ACCENT: Record<Category, { text: string; border: string; bg: string }> = {
  rewards: { text: 'text-pink-pale', border: 'border-pink-pale', bg: 'bg-pink-pale' },
  polls: { text: 'text-d-yellow', border: 'border-d-yellow', bg: 'bg-d-yellow' },
  goals: { text: 'text-green', border: 'border-green', bg: 'bg-green' },
};
export const VARIANTS = ['B7', 'B'] as const;
export type Variant = (typeof VARIANTS)[number];
export const DEFAULT_VARIANT: Variant = 'B7';
export const VARIANT_NAMES: Record<Variant, string> = {
  B7: 'Refined B',
  B: 'Original B',
};
export const EVENT = 'ESA Summer 2026';
const CHANNELS = { main: 'ESA Summer · Main', side: 'ESA Summer · Side stream' };
type ChannelId = keyof typeof CHANNELS;
export const channelLabel = (channelId: ChannelId | null) =>
  channelId ? CHANNELS[channelId] : 'Shared';
const CHANNEL_TAGS = { main: 'Main', side: 'Side stream' };
// Short form for a subtle tag; the Event name is already in the page header.
export const channelTag = (channelId: ChannelId | null) =>
  channelId ? CHANNEL_TAGS[channelId] : 'Shared';
export const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const zero = (): Totals => ({ rewards: 0, polls: 0, goals: 0 });
export const WALLET_CREDIT = 2500;
export const STALE_DEMO_CENTS = 100;
// Separate from the credit picker. Nothing in this prototype writes to this draft.
export const REGULAR_DRAFT = {
  id: 'existing-normal-draft',
  pledge_cents: 2500,
  channel: CHANNELS.main,
  selections: [{ target: 'Digital download', quantity: 1, amount_cents: 300 }],
};

export type Selection = {
  id: string;
  category: Category;
  label: string;
  detail: string;
  cents: number;
  quantity?: number;
  message?: string;
};
// Something a donor can put poll or goal credit on (one poll option or one goal).
export type Target = { id: string; category: Category; label: string; detail: string };
type HistoryLine = { text: string; items?: Selection[] };
export type Donation = {
  id: string;
  name: string;
  date: string;
  sortKey: string;
  channel: string;
  ended: boolean;
  original: number;
  credit: Totals;
  history: HistoryLine[];
};

function fixtures(): Donation[] {
  return [
    {
      id: 'donation-a',
      name: 'Donation A',
      date: '12 July 2026',
      sortKey: '2026-07-12',
      channel: CHANNELS.main,
      ended: false,
      original: 1000,
      credit: { rewards: 0, polls: 300, goals: 0 },
      history: [{ text: 'Poll vote reversed by an admin: $3.00 returned as poll credit.' }],
    },
    {
      id: 'donation-b',
      name: 'Donation B',
      date: '10 July 2026',
      sortKey: '2026-07-10',
      channel: CHANNELS.side,
      ended: false,
      original: 1500,
      credit: { rewards: 0, polls: 700, goals: 600 },
      history: [
        { text: 'Rejected write-in: $7.00 returned as poll credit.' },
        { text: 'Goal contribution reversed: $6.00 returned as goal credit.' },
      ],
    },
    {
      id: 'donation-winter',
      name: 'ESA Winter donation',
      date: '20 February 2026',
      sortKey: '2026-02-20',
      channel: 'ESA Winter · Main',
      ended: true,
      original: 1000,
      credit: zero(),
      history: [
        {
          text: 'Event ended: $2.00 poll credit and $1.00 goal credit became unused pool money for moderators to assign.',
        },
        {
          text: '$3.00 reward credit expired. None of these amounts became wallet credit; there is nothing to spend.',
        },
      ],
    },
  ];
}

export type Reward = {
  id: string;
  channelId: ChannelId | null;
  title: string;
  type: 'DIGITAL' | 'SHOUTOUT' | 'PHYSICAL';
  price: number;
  stock: number;
  description: string;
};
const REWARDS: Reward[] = [
  {
    id: 'download',
    channelId: null,
    title: 'Digital download',
    type: 'DIGITAL',
    price: 300,
    stock: 3,
    description: 'A downloadable ESA art pack.',
  },
  {
    id: 'shoutout',
    channelId: 'main',
    title: 'On-stream shoutout',
    type: 'SHOUTOUT',
    price: 500,
    stock: 2,
    description: 'Send a short message to the Main stream.',
  },
  {
    id: 'sold-out-pack',
    channelId: 'side',
    title: 'Bonus digital pack',
    type: 'DIGITAL',
    price: 200,
    stock: 0,
    description: 'Example of an unavailable reward.',
  },
  {
    id: 'poster',
    channelId: null,
    title: 'Signed poster',
    type: 'PHYSICAL',
    price: 2000,
    stock: 10,
    description: 'Physical rewards need a new paid donation; credit never covers them.',
  },
];
export const CREDIT_REWARDS = REWARDS.filter((r) => r.type !== 'PHYSICAL');
export type Poll = {
  id: string;
  channelId: ChannelId | null;
  title: string;
  options: { id: string; label: string; current: number }[];
};
export const POLLS: Poll[] = [
  {
    id: 'route',
    channelId: 'main',
    title: 'Choose the bonus route',
    options: [
      { id: 'forest', label: 'Forest route', current: 14000 },
      { id: 'city', label: 'City route', current: 9000 },
    ],
  },
  {
    id: 'side-game',
    channelId: 'side',
    title: 'Side stream bonus game',
    options: [
      { id: 'racing', label: 'Racing', current: 7000 },
      { id: 'puzzle', label: 'Puzzle', current: 5000 },
    ],
  },
  {
    id: 'costume',
    channelId: null,
    title: 'Choose the finale costume',
    options: [
      { id: 'wizard', label: 'Wizard', current: 8000 },
      { id: 'pirate', label: 'Pirate', current: 12000 },
    ],
  },
];
export type Goal = {
  id: string;
  channelId: ChannelId | null;
  title: string;
  current: number;
  target: number;
};
export const GOALS: Goal[] = [
  {
    id: 'bonus-run',
    channelId: 'main',
    title: 'Unlock a bonus speedrun',
    current: 32000,
    target: 50000,
  },
  { id: 'side-race', channelId: 'side', title: 'Side stream race', current: 21000, target: 30000 },
  { id: 'encore', channelId: null, title: 'Community encore', current: 64000, target: 100000 },
];
const initialStock = (): Record<string, number> =>
  Object.fromEntries(REWARDS.map((r) => [r.id, r.stock]));
const AMOUNT_PATTERN = /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;
export const inputKey = (category: Category, id: string) => `${category}:${id}`;
// Cents for a typed dollar amount, or null when it is not a dollar amount with at most 2 decimals.
export function parseCents(text: string) {
  const input = text.trim();
  const cents = Math.round(Number(input) * 100);
  return AMOUNT_PATTERN.test(input) && Number.isSafeInteger(cents) ? cents : null;
}

function joinWithAnd(parts: string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

export function useCreditModel() {
  const [donations, setDonations] = useState(fixtures);
  const [stock, setStock] = useState(initialStock);
  // This picker state never shares the mock normal draft, let alone the real cart.
  const [selections, setSelections] = useState<Selection[]>([]);
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [extraPanel, setExtraPanel] = useState<'draft' | null>(null);
  const [reviewed, setReviewed] = useState<Totals | null>(null);
  const [staleSimulated, setStaleSimulated] = useState(false);
  // Bumps on apply and reset so a variant remounts and drops its own tab/step state.
  const [round, setRound] = useState(0);
  const applyLock = useRef(false);

  const active = donations.filter((d) => !d.ended);
  const ended = donations.filter((d) => d.ended);
  const totals = zero();
  for (const d of active) for (const c of CATEGORIES) totals[c] += d.credit[c];
  const used = zero();
  for (const item of selections) used[item.category] += item.cents;
  const remaining: Totals = {
    rewards: totals.rewards - used.rewards,
    polls: totals.polls - used.polls,
    goals: totals.goals - used.goals,
  };
  const shown = CATEGORIES.filter((c) => totals[c] > 0 || used[c] > 0);
  const overBudget = CATEGORIES.some((c) => remaining[c] < 0);
  const creditChanged = !reviewed || CATEGORIES.some((c) => reviewed[c] !== totals[c]);
  const selectionOf = (id: string, category: Category) =>
    selections.find((s) => s.id === id && s.category === category);
  const existingAmount = (id: string, category: Category) =>
    donations.reduce(
      (sum, d) =>
        sum +
        d.history.reduce(
          (subtotal, h) =>
            subtotal +
            (h.items
              ?.filter((i) => i.id === id && i.category === category)
              .reduce((n, i) => n + i.cents, 0) ?? 0),
          0,
        ),
      0,
    );
  const pollView = (poll: Poll) => {
    const detail = `${poll.title} · ${channelLabel(poll.channelId)}`;
    const options = poll.options.map((o) => ({
      ...o,
      current: o.current + existingAmount(o.id, 'polls'),
      pending: selectionOf(o.id, 'polls')?.cents ?? 0,
      target: { id: o.id, category: 'polls', label: o.label, detail } satisfies Target,
    }));
    const total = options.reduce((sum, o) => sum + o.current, 0);
    const pendingTotal = options.reduce((sum, o) => sum + o.pending, 0);
    return {
      total,
      options: options.map((o) => ({
        ...o,
        previewPct: ((o.current + o.pending) / (total + pendingTotal)) * 100,
      })),
    };
  };
  const goalView = (goal: Goal) => {
    const current = goal.current + existingAmount(goal.id, 'goals');
    const pending = selectionOf(goal.id, 'goals')?.cents ?? 0;
    return {
      current,
      pending,
      previewPct: ((current + pending) / goal.target) * 100,
      target: {
        id: goal.id,
        category: 'goals',
        label: goal.title,
        detail: channelLabel(goal.channelId),
      } satisfies Target,
    };
  };
  // Largest amount this target can take: what is left plus what it already holds.
  const maxFor = (t: Target) => remaining[t.category] + (selectionOf(t.id, t.category)?.cents ?? 0);

  const toTop = () => {
    setExtraPanel(null);
    window.scrollTo({ top: 0 });
  };
  const reset = () => {
    setDonations(fixtures());
    setStock(initialStock());
    setSelections([]);
    setAmountInputs({});
    setReviewing(false);
    setReviewed(null);
    setStaleSimulated(false);
    setError('');
    setNotice('Demo reset. Wallet credit and the separate $25.00 donation draft are untouched.');
    setRound((r) => r + 1);
    applyLock.current = false;
    toTop();
  };
  const fits = (item: Selection) =>
    used[item.category] - (selectionOf(item.id, item.category)?.cents ?? 0) + item.cents <=
    totals[item.category];
  const upsert = (item: Selection) => {
    setSelections((list) =>
      list.some((s) => s.id === item.id && s.category === item.category)
        ? list.map((s) => (s.id === item.id && s.category === item.category ? item : s))
        : [...list, item],
    );
    setError('');
  };
  // Returns false when the amount does not fit, so an inline editor can stay open.
  const replaceSelection = (item: Selection) => {
    if (!fits(item)) {
      setError(
        `Only ${fmt(maxFor(item))} ${SINGULAR[item.category]} credit is left for this. Other categories cannot cover it. Reduce or remove another ${SINGULAR[item.category]} selection first.`,
      );
      return false;
    }
    upsert(item);
    return true;
  };
  const remove = (id: string, category: Category) => {
    setSelections((list) => list.filter((s) => s.id !== id || s.category !== category));
    setAmountInputs((inputs) => ({ ...inputs, [inputKey(category, id)]: '' }));
    setError('');
  };
  const amountInput = (t: Target) => amountInputs[inputKey(t.category, t.id)] ?? '';
  const setAmountInput = (t: Target, value: string) =>
    setAmountInputs((inputs) => ({ ...inputs, [inputKey(t.category, t.id)]: value }));
  const chooseAmount = (t: Target) => {
    const input = amountInput(t).trim();
    if (!input) return false;
    const cents = parseCents(input);
    if (cents === null || cents < 1) {
      setError(
        'Enter a positive dollar amount with at most two decimal places. Use remove to take a selection out.',
      );
      return false;
    }
    return replaceSelection({ ...t, cents });
  };
  const fillRemaining = (t: Target) => {
    const max = maxFor(t);
    if (max <= 0) return;
    setAmountInput(t, (max / 100).toFixed(2));
    replaceSelection({ ...t, cents: max });
  };
  const setRewardQuantity = (reward: Reward, quantity: number) => {
    if (quantity <= 0) {
      remove(reward.id, 'rewards');
      return;
    }
    replaceSelection({
      id: reward.id,
      category: 'rewards',
      label: reward.title,
      detail: channelLabel(reward.channelId),
      quantity,
      cents: quantity * reward.price,
      message: selectionOf(reward.id, 'rewards')?.message,
    });
  };
  const setRewardMessage = (rewardId: string, message: string) =>
    setSelections((list) =>
      list.map((s) => (s.id === rewardId && s.category === 'rewards' ? { ...s, message } : s)),
    );
  const review = () => {
    setReviewed({ ...totals });
    applyLock.current = false;
    setError('');
    setReviewing(true);
  };
  const backToEdit = () => {
    setReviewing(false);
    setError('');
  };
  const refreshBalances = () => {
    setReviewed({ ...totals });
    setError(
      overBudget
        ? 'Your selections are more than the refreshed credit in a category. Edit to reduce or remove them; nothing can be applied yet.'
        : '',
    );
  };
  const isEligible = (item: Selection) => {
    if (!Number.isSafeInteger(item.cents) || item.cents < 1) return false;
    if (item.category === 'rewards') {
      const reward = CREDIT_REWARDS.find((r) => r.id === item.id);
      return Boolean(
        reward &&
        item.quantity &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0 &&
        item.quantity <= (stock[item.id] ?? 0) &&
        item.cents === item.quantity * reward.price,
      );
    }
    return item.category === 'polls'
      ? POLLS.some((p) => p.options.some((o) => o.id === item.id))
      : GOALS.some((g) => g.id === item.id);
  };
  const apply = () => {
    // Synchronous lock: a second click before React re-renders does nothing.
    if (applyLock.current || !selections.length) return;
    // Validate the whole batch before any in-memory write. If one check fails, nothing applies.
    if (creditChanged) {
      setError(
        'Your credit changed while you were reviewing. Nothing was applied. Refresh the balances and reconfirm, or edit your selections.',
      );
      return;
    }
    if (overBudget || !selections.every(isEligible)) {
      setError(
        'Nothing was applied. Some selections no longer fit their own category credit or stock. Edit them before applying.',
      );
      return;
    }
    applyLock.current = true;

    // Draw each category from its source credits, oldest donation first. A selection can span
    // two donations. The donor never chooses the source.
    const sources = [...active].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const left = Object.fromEntries(sources.map((d) => [d.id, { ...d.credit }]));
    const parts: Record<string, Record<Category, Selection[]>> = {};
    for (const item of selections) {
      let need = item.cents;
      for (const source of sources) {
        const credit = left[source.id];
        if (!credit || need === 0) continue;
        const take = Math.min(need, credit[item.category]);
        if (take <= 0) continue;
        credit[item.category] -= take;
        need -= take;
        const bySource = (parts[source.id] ??= { rewards: [], polls: [], goals: [] });
        bySource[item.category].push({ ...item, cents: take });
      }
    }
    const fullCents = (part: Selection) => selectionOf(part.id, part.category)?.cents ?? part.cents;
    setDonations((list) =>
      list.map((d) => {
        const bySource = parts[d.id];
        const credit = left[d.id];
        if (!bySource || !credit) return d;
        const lines: HistoryLine[] = CATEGORIES.filter((c) => bySource[c].length).map((c) => {
          const items = bySource[c];
          const sum = items.reduce((n, i) => n + i.cents, 0);
          const described = items
            .map(
              (i) =>
                `${i.label}${i.quantity ? ` × ${i.quantity}` : ''} ${fmt(i.cents)}${
                  i.cents < fullCents(i) ? ` (of ${fmt(fullCents(i))})` : ''
                }`,
            )
            .join(', ');
          return {
            text: `Applied ${fmt(sum)} ${SINGULAR[c]} credit: ${described} (part of a combined credit use).`,
            items,
          };
        });
        return { ...d, credit, history: [...d.history, ...lines] };
      }),
    );
    setStock((previous) => {
      const next = { ...previous };
      for (const item of selections.filter((s) => s.category === 'rewards'))
        next[item.id] = (next[item.id] ?? 0) - (item.quantity ?? 0);
      return next;
    });
    const applied = CATEGORIES.filter((c) => used[c] > 0).map(
      (c) => `${fmt(used[c])} ${SINGULAR[c]} credit`,
    );
    setNotice(
      `Applied ${joinWithAnd(applied)} in one step. Wallet credit and your $25 donation draft are unchanged. Money totals did not change.`,
    );
    setSelections([]);
    setAmountInputs({});
    setReviewing(false);
    setReviewed(null);
    setStaleSimulated(false);
    setError('');
    setRound((r) => r + 1);
    toTop();
  };
  const staleSource = [...active]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .find((d) => CATEGORIES.some((c) => d.credit[c] >= STALE_DEMO_CENTS));
  const staleCategory = CATEGORIES.find((c) => (staleSource?.credit[c] ?? 0) >= STALE_DEMO_CENTS);
  const simulateStale = () => {
    if (!staleSource || !staleCategory || staleSimulated) return;
    setDonations((list) =>
      list.map((d) =>
        d.id === staleSource.id
          ? {
              ...d,
              credit: { ...d.credit, [staleCategory]: d.credit[staleCategory] - STALE_DEMO_CENTS },
              history: [
                ...d.history,
                {
                  text: `Demo only: ${fmt(STALE_DEMO_CENTS)} ${SINGULAR[staleCategory]} credit used in another session while this review was open.`,
                },
              ],
            }
          : d,
      ),
    );
    setStaleSimulated(true);
    setError(
      `Demo: your ${SINGULAR[staleCategory]} credit went down by ${fmt(STALE_DEMO_CENTS)}. The whole batch is blocked; nothing was applied. Refresh the balances and reconfirm, or edit if the selections no longer fit.`,
    );
  };

  return {
    donations,
    active,
    ended,
    stock,
    selections,
    totals,
    used,
    remaining,
    shown,
    overBudget,
    reviewing,
    reviewed,
    creditChanged,
    // The lock is a ref so a double click is blocked before React re-renders.
    canApply: selections.length > 0 && !overBudget && !creditChanged && !applyLock.current,
    error,
    notice,
    extraPanel,
    setExtraPanel,
    round,
    staleSimulated,
    staleCategory,
    selectionOf,
    pollView,
    goalView,
    maxFor,
    amountInput,
    setAmountInput,
    chooseAmount,
    fillRemaining,
    setRewardQuantity,
    setRewardMessage,
    remove,
    review,
    backToEdit,
    refreshBalances,
    apply,
    simulateStale,
    reset,
    toTop,
  };
}

export type CreditModel = ReturnType<typeof useCreditModel>;
