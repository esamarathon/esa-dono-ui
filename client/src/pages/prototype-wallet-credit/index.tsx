// THROWAWAY UI (#166): one credits page (/wallet or /donate with ?prototype=pool-credit).
// Category credit is combined across all the donor's active donations in the current Event
// and spent on that Event's incentives in one review. Fixtures only; no auth, API, checkout
// or storage. Reload resets everything.
import { useRef, useState } from 'react';
import ProgressBar from '../../components/ProgressBar';

const CATEGORIES = ['rewards', 'polls', 'goals'] as const;
type Category = (typeof CATEGORIES)[number];
type Totals = Record<Category, number>;
const LABELS: Record<Category, string> = { rewards: 'Rewards', polls: 'Polls', goals: 'Goals' };
const SINGULAR: Record<Category, string> = { rewards: 'reward', polls: 'poll', goals: 'goal' };
// Literal class names so Tailwind keeps them. One accent per category keeps balances distinct.
const ACCENT: Record<Category, { text: string; border: string }> = {
  rewards: { text: 'text-pink-pale', border: 'border-pink-pale' },
  polls: { text: 'text-d-yellow', border: 'border-d-yellow' },
  goals: { text: 'text-green', border: 'border-green' },
};
const EVENT = 'ESA Summer 2026';
const CHANNELS = { main: 'ESA Summer · Main', side: 'ESA Summer · Side stream' };
type ChannelId = keyof typeof CHANNELS;
const channelLabel = (channelId: ChannelId | null) => (channelId ? CHANNELS[channelId] : 'Shared');
const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const zero = (): Totals => ({ rewards: 0, polls: 0, goals: 0 });
const WALLET_CREDIT = 2500;
const STALE_DEMO_CENTS = 100;
// Separate from the credit picker. Nothing in this prototype writes to this draft.
const REGULAR_DRAFT = {
  id: 'existing-normal-draft',
  pledge_cents: 2500,
  channel: CHANNELS.main,
  selections: [{ target: 'Digital download', quantity: 1, amount_cents: 300 }],
};

type Selection = {
  id: string;
  category: Category;
  label: string;
  detail: string;
  cents: number;
  quantity?: number;
  message?: string;
};
type HistoryLine = { text: string; items?: Selection[] };
type Donation = {
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

const REWARDS: {
  id: string;
  channelId: ChannelId | null;
  title: string;
  type: 'DIGITAL' | 'SHOUTOUT' | 'PHYSICAL';
  price: number;
  stock: number;
  description: string;
}[] = [
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
const CREDIT_REWARDS = REWARDS.filter((r) => r.type !== 'PHYSICAL');
const POLLS: {
  id: string;
  channelId: ChannelId | null;
  title: string;
  options: { id: string; label: string; current: number }[];
}[] = [
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
const GOALS: {
  id: string;
  channelId: ChannelId | null;
  title: string;
  current: number;
  target: number;
}[] = [
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

function joinWithAnd(parts: string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

export default function WalletCreditPrototype({ standalone = false }: { standalone?: boolean }) {
  const preview = import.meta.env.DEV || standalone;
  const [donations, setDonations] = useState(fixtures);
  const [stock, setStock] = useState(initialStock);
  // This picker state never shares the mock normal draft, let alone the real cart.
  const [selections, setSelections] = useState<Selection[]>([]);
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Category | null>(null);
  const [step, setStep] = useState<'browse' | 'review'>('browse');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [extraPanel, setExtraPanel] = useState<'help' | 'draft' | null>(null);
  const [reviewed, setReviewed] = useState<Totals | null>(null);
  const [staleSimulated, setStaleSimulated] = useState(false);
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
  const currentTab = tab && shown.includes(tab) ? tab : shown[0];
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

  const toTop = () => {
    setExtraPanel(null);
    window.scrollTo({ top: 0 });
  };
  const reset = () => {
    setDonations(fixtures());
    setStock(initialStock());
    setSelections([]);
    setAmountInputs({});
    setTab(null);
    setStep('browse');
    setReviewed(null);
    setStaleSimulated(false);
    setError('');
    setNotice('Demo reset. Wallet credit and the separate $25.00 donation draft are untouched.');
    applyLock.current = false;
    toTop();
  };
  const replaceSelection = (item: Selection) => {
    const previous = selectionOf(item.id, item.category)?.cents ?? 0;
    if (used[item.category] - previous + item.cents > totals[item.category]) {
      setError(
        `Only ${fmt(remaining[item.category] + previous)} ${SINGULAR[item.category]} credit is left for this. Other categories cannot cover it. Reduce or remove another ${SINGULAR[item.category]} selection first.`,
      );
      return;
    }
    setSelections((list) =>
      list.some((s) => s.id === item.id && s.category === item.category)
        ? list.map((s) => (s.id === item.id && s.category === item.category ? item : s))
        : [...list, item],
    );
    setError('');
  };
  const remove = (id: string, category: Category) => {
    setSelections((list) => list.filter((s) => s.id !== id || s.category !== category));
    setAmountInputs((inputs) => ({ ...inputs, [`${category}:${id}`]: '' }));
    setError('');
  };
  const chooseAmount = (id: string, label: string, detail: string, category: Category) => {
    const input = (amountInputs[`${category}:${id}`] ?? '').trim();
    if (!input) return;
    const cents = Math.round(Number(input) * 100);
    if (!AMOUNT_PATTERN.test(input) || !Number.isSafeInteger(cents) || cents < 1) {
      setError(
        'Enter a positive dollar amount with at most two decimal places. Use remove to take a selection out.',
      );
      return;
    }
    replaceSelection({ id, category, label, detail, cents });
  };
  const fillRemaining = (id: string, label: string, detail: string, category: Category) => {
    const max = remaining[category] + (selectionOf(id, category)?.cents ?? 0);
    if (max <= 0) return;
    setAmountInputs((inputs) => ({ ...inputs, [`${category}:${id}`]: (max / 100).toFixed(2) }));
    replaceSelection({ id, category, label, detail, cents: max });
  };
  const review = () => {
    setReviewed({ ...totals });
    applyLock.current = false;
    setError('');
    setStep('review');
  };
  const backToEdit = () => {
    setStep('browse');
    setError('');
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
    setTab(null);
    setStep('browse');
    setReviewed(null);
    setStaleSimulated(false);
    setError('');
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

  const amountControl = (id: string, label: string, detail: string, category: Category) => {
    const selection = selectionOf(id, category);
    const inputKey = `${category}:${id}`;
    const input = amountInputs[inputKey] ?? '';
    const max = remaining[category] + (selection?.cents ?? 0);
    return (
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <label className="font-data text-sm">
          ${' '}
          <input
            aria-label={`${label} credit in dollars`}
            type="text"
            inputMode="decimal"
            className="w-24 px-2 py-1"
            placeholder="0.00"
            value={input}
            onChange={(e) =>
              setAmountInputs((inputs) => ({ ...inputs, [inputKey]: e.target.value }))
            }
          />
        </label>
        <button
          className="btrl-button text-sm"
          disabled={!input.trim()}
          onClick={() => chooseAmount(id, label, detail, category)}
        >
          {selection ? 'update' : 'add'}
        </button>
        <button
          className="btrl-button btrl-button-outline text-sm"
          disabled={max <= 0 || selection?.cents === max}
          onClick={() => fillRemaining(id, label, detail, category)}
        >
          use all remaining{max > 0 ? ` (${fmt(max)})` : ''}
        </button>
        {selection && (
          <>
            <button
              className="btrl-button btrl-button-outline text-sm"
              onClick={() => remove(id, category)}
            >
              remove
            </button>
            <span className="font-data text-green">Selected {fmt(selection.cents)}</span>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen pb-16 overflow-x-hidden">
      {preview && (
        <style>{`
        @font-face { font-family: 'Bebas Neue Pro'; src: url('${import.meta.env.BASE_URL}fonts/BebasNeuePro.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Cabin BTRL'; src: url('${import.meta.env.BASE_URL}fonts/Cabin-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Bold.ttf') format('truetype'); font-weight: 700; font-style: normal; font-display: swap; }
      `}</style>
      )}
      <nav
        className="flex flex-wrap items-center gap-4 md:gap-6 px-4 md:px-6 py-4 border-b"
        style={{ background: 'var(--dark-gray)' }}
      >
        <button onClick={toTop} className="font-display text-2xl tracking-wide uppercase">
          esa dono
        </button>
        <button
          onClick={toTop}
          className="font-data font-bold text-sm tracking-wider uppercase text-off-white/55"
        >
          home
        </button>
        <button
          onClick={() => setExtraPanel(extraPanel === 'help' ? null : 'help')}
          className="font-data font-bold text-sm tracking-wider uppercase text-off-white/55"
        >
          help
        </button>
        <button
          onClick={toTop}
          className="font-data font-bold text-sm tracking-wider uppercase text-d-yellow"
        >
          wallet
        </button>
        <button
          onClick={() => setExtraPanel(extraPanel === 'draft' ? null : 'draft')}
          className="btrl-button btrl-button-outline ml-auto text-sm"
        >
          resume $25 donation
        </button>
      </nav>
      <div className="max-w-5xl mx-auto px-4 md:px-8 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6 font-mono text-xs text-d-yellow">
          <p>THROWAWAY · FIXTURES ONLY · NO PAYMENT OR STORAGE</p>
          <button className="btrl-button btrl-button-outline text-sm" onClick={reset}>
            reset demo
          </button>
        </div>
        {extraPanel && (
          <aside className="btrl-panel-dark p-5 mb-6">
            <div className="flex justify-between gap-4">
              <h2 className="font-display text-2xl">
                {extraPanel === 'help' ? 'credit guide' : 'existing donation draft · $25.00'}
              </h2>
              <button className="text-d-yellow font-data" onClick={() => setExtraPanel(null)}>
                close
              </button>
            </div>
            {extraPanel === 'help' ? (
              <p className="font-body text-sm text-off-white/60 mt-2">
                When an incentive you paid for is reversed or rejected, the amount comes back as
                credit for the same category. Your credit for each category is combined across your
                donations to this Event. Use it on any open incentive of that category below, then
                apply everything in one review. No payment is made. Wallet credit is separate and is
                only used when you make a new donation.
              </p>
            ) : (
              <p className="font-body text-sm text-off-white/60 mt-2">
                Normal donation flow preview only · {REGULAR_DRAFT.channel} · $25.00 donation · 1
                digital download selected. This separate mock draft stays untouched. Your{' '}
                {fmt(WALLET_CREDIT)} wallet credit is used there, not on this page.
              </p>
            )}
          </aside>
        )}
        {notice && (
          <div role="status" className="btrl-panel p-4 mb-6 text-green font-body text-sm">
            {notice}
          </div>
        )}

        <h1 className="font-display text-4xl uppercase mb-2">your credits</h1>
        <p className="font-body text-sm text-off-white/60 mb-4">
          {EVENT} · combined from all your donations to this Event. Each category’s credit can only
          be used on that category.
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
            <div>
              <p className="font-display text-3xl">No credit left to use</p>
              <p className="font-body text-sm text-off-white/60 mt-1">
                All your {EVENT} category credit is applied. See where it came from and where it
                went below.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-5 pt-4 border-t font-data text-sm">
            <p className="text-off-white/70">
              <strong className="text-off-white">Wallet credit {fmt(WALLET_CREDIT)}</strong> — used
              when you make a new donation
            </p>
            <button
              className="text-d-yellow underline"
              onClick={() => setExtraPanel(extraPanel === 'draft' ? null : 'draft')}
            >
              view draft
            </button>
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
                {step === 'browse' ? (
                  <button
                    className="btrl-button"
                    disabled={!selections.length || overBudget}
                    onClick={review}
                  >
                    review →
                  </button>
                ) : (
                  <button className="btrl-button btrl-button-outline" onClick={backToEdit}>
                    edit selections
                  </button>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="btrl-panel-dark p-4 mb-4 text-red font-body text-sm">
                {error}
              </p>
            )}
            {step === 'review' ? (
              <section className="btrl-panel p-5 md:p-6">
                <h2 className="font-display text-3xl mb-4">review your credit use</h2>
                {CATEGORIES.filter((c) => used[c] > 0).map((c) => (
                  <div key={c} className="mb-5">
                    <div className="flex flex-wrap justify-between gap-2">
                      <h3 className={`font-data font-bold ${ACCENT[c].text}`}>
                        {LABELS[c]} credit
                      </h3>
                      <p className={`font-data text-sm ${remaining[c] < 0 ? 'text-red' : ''}`}>
                        {fmt(used[c])} used · {fmt(remaining[c])} remaining
                      </p>
                    </div>
                    <ul className="divide-y divide-off-white/10">
                      {selections
                        .filter((item) => item.category === c)
                        .map((item) => (
                          <li key={item.id} className="py-3 flex justify-between gap-4 font-data">
                            <div className="min-w-0">
                              <p className="font-bold">
                                {item.label}
                                {item.quantity ? ` × ${item.quantity}` : ''}
                              </p>
                              <p className="text-sm text-off-white/55">{item.detail}</p>
                              {item.message && (
                                <p className="font-body text-sm text-off-white/60 break-words">
                                  “{item.message}”
                                </p>
                              )}
                            </div>
                            <span>{fmt(item.cents)}</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
                <p className="font-body text-sm text-off-white/60 py-4 mb-4 border-t">
                  No payment or new donation. Applying credit changes incentive totals, not money
                  totals. Wallet credit ({fmt(WALLET_CREDIT)}) is not used.
                </p>
                {creditChanged && (
                  <div className="border-t py-4 mb-3">
                    <p className="font-body text-sm text-red mb-3">
                      Your credit changed since you opened this review. Nothing was applied. Refresh
                      the balances and reconfirm; edit first if the selections no longer fit.
                    </p>
                    <p className="font-data text-sm text-off-white/60 mb-3">
                      {CATEGORIES.filter((c) => reviewed?.[c] !== totals[c])
                        .map(
                          (c) =>
                            `${LABELS[c]}: reviewed ${fmt(reviewed?.[c] ?? 0)}, now ${fmt(totals[c])}`,
                        )
                        .join(' · ')}
                    </p>
                    <button
                      className="btrl-button btrl-button-outline"
                      onClick={() => {
                        setReviewed({ ...totals });
                        setError(
                          overBudget
                            ? 'Your selections are more than the refreshed credit in a category. Edit to reduce or remove them; nothing can be applied yet.'
                            : '',
                        );
                      }}
                    >
                      refresh balances
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <button className="btrl-button btrl-button-outline" onClick={backToEdit}>
                    edit
                  </button>
                  <button
                    className="btrl-button"
                    disabled={
                      !selections.length || overBudget || creditChanged || applyLock.current
                    }
                    onClick={apply}
                  >
                    apply credits
                  </button>
                </div>
                {preview && (
                  <button
                    className="block font-mono text-xs text-off-white/55 underline mt-6 text-left"
                    disabled={staleSimulated || !staleCategory}
                    onClick={simulateStale}
                  >
                    demo: reduce {staleCategory ? SINGULAR[staleCategory] : 'one category’s'} credit
                    by {fmt(STALE_DEMO_CENTS)} while reviewing
                  </button>
                )}
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
                      Non-physical rewards only. Whole units at the current price, while stock
                      lasts.
                    </p>
                    <div className="grid md:grid-cols-2 gap-4">
                      {CREDIT_REWARDS.map((reward) => {
                        const selection = selectionOf(reward.id, 'rewards');
                        const quantity = selection?.quantity ?? 0;
                        const left = stock[reward.id] ?? 0;
                        const detail = channelLabel(reward.channelId);
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
                              {reward.type} · {detail} · {left} left
                            </p>
                            <div className="flex flex-wrap items-center gap-3 mt-4">
                              <button
                                aria-label={`Decrease ${reward.title} quantity`}
                                className="btrl-button btrl-button-outline"
                                disabled={!selection}
                                onClick={() =>
                                  selection &&
                                  (quantity === 1
                                    ? remove(reward.id, 'rewards')
                                    : replaceSelection({
                                        ...selection,
                                        quantity: quantity - 1,
                                        cents: (quantity - 1) * reward.price,
                                      }))
                                }
                              >
                                −
                              </button>
                              <span className="font-data text-xl">{quantity}</span>
                              <button
                                aria-label={`Increase ${reward.title} quantity`}
                                className="btrl-button"
                                disabled={quantity >= left || remaining.rewards < reward.price}
                                onClick={() =>
                                  replaceSelection({
                                    id: reward.id,
                                    category: 'rewards',
                                    label: reward.title,
                                    detail,
                                    quantity: quantity + 1,
                                    cents: (quantity + 1) * reward.price,
                                    message: selection?.message,
                                  })
                                }
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
                                  onChange={(e) =>
                                    setSelections((list) =>
                                      list.map((s) =>
                                        s.id === reward.id && s.category === 'rewards'
                                          ? { ...s, message: e.target.value }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                              </label>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </>
                )}
                {currentTab === 'polls' && (
                  <div className="space-y-4">
                    {POLLS.map((poll) => {
                      const detail = `${poll.title} · ${channelLabel(poll.channelId)}`;
                      const pollTotal = poll.options.reduce(
                        (sum, o) => sum + o.current + existingAmount(o.id, 'polls'),
                        0,
                      );
                      const pendingTotal = poll.options.reduce(
                        (sum, o) => sum + (selectionOf(o.id, 'polls')?.cents ?? 0),
                        0,
                      );
                      return (
                        <article key={poll.id} className="btrl-panel p-5">
                          <h3 className="font-data font-bold text-lg">{poll.title}</h3>
                          <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                            {channelLabel(poll.channelId)}
                          </p>
                          <div className="space-y-5">
                            {poll.options.map((option) => {
                              const current = option.current + existingAmount(option.id, 'polls');
                              const pending = selectionOf(option.id, 'polls')?.cents ?? 0;
                              return (
                                <div key={option.id}>
                                  <div className="flex justify-between font-data text-sm mb-2">
                                    <span className="font-bold">{option.label}</span>
                                    <span className="text-off-white/55">{fmt(current)}</span>
                                  </div>
                                  <ProgressBar
                                    value={current}
                                    max={pollTotal}
                                    previewPct={
                                      ((current + pending) / (pollTotal + pendingTotal)) * 100
                                    }
                                    animateOnChange={false}
                                  />
                                  {amountControl(option.id, option.label, detail, 'polls')}
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
                {currentTab === 'goals' && (
                  <div className="space-y-4">
                    {GOALS.map((goal) => {
                      const current = goal.current + existingAmount(goal.id, 'goals');
                      const pending = selectionOf(goal.id, 'goals')?.cents ?? 0;
                      return (
                        <article key={goal.id} className="btrl-panel p-5">
                          <h3 className="font-data font-bold text-lg">{goal.title}</h3>
                          <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                            {channelLabel(goal.channelId)}
                          </p>
                          <ProgressBar
                            value={current}
                            max={goal.target}
                            previewPct={((current + pending) / goal.target) * 100}
                            animateOnChange={false}
                          />
                          <div className="flex justify-between font-data text-sm text-off-white/55 mt-2">
                            <span>{fmt(current)} raised</span>
                            <span>goal {fmt(goal.target)}</span>
                          </div>
                          {amountControl(
                            goal.id,
                            goal.title,
                            channelLabel(goal.channelId),
                            'goals',
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <details className="btrl-panel p-5 mt-8">
          <summary className="font-data font-bold text-sm cursor-pointer uppercase tracking-wide">
            where your credit came from
          </summary>
          <p className="font-body text-sm text-off-white/60 mt-3">
            Credit is used oldest donation first. You do not need to choose.
          </p>
          {[
            { title: EVENT, list: active },
            { title: 'Past Events', list: ended },
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

        <details className="btrl-panel-dark p-4 mt-8">
          <summary className="font-mono text-xs text-off-white/55 cursor-pointer">
            DEMO STATE · credit / selections / untouched draft
          </summary>
          <pre className="text-xs font-mono overflow-auto p-3 mt-3 max-h-96">
            {JSON.stringify(
              {
                step,
                category_totals_cents: totals,
                selected_cents_by_category: used,
                remaining_cents_by_category: remaining,
                reviewed_category_totals_cents: reviewed,
                per_source_credit_cents: donations.map((d) => ({
                  id: d.id,
                  date: d.date,
                  channel: d.channel,
                  ended: d.ended,
                  credit: d.credit,
                })),
                selections,
                wallet_credit_cents: WALLET_CREDIT,
                regular_draft: REGULAR_DRAFT,
                stock,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}
