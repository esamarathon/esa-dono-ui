// THROWAWAY UI (#166): three /wallet layouts via ?variant=A|B|C, one familiar
// /donate browse/review surface. Fixtures only; no auth, API, checkout or storage.
// Cancellation balances are post-adjustment examples, NOT an accounting model.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ProgressBar from '../../components/ProgressBar';

const CATEGORIES = ['rewards', 'polls', 'goals'] as const;
type Category = (typeof CATEGORIES)[number];
const VARIANTS = ['A', 'B', 'C'] as const;
type Variant = (typeof VARIANTS)[number];
const VARIANT_NAMES = { A: 'Stacked pledges', B: 'Wallet sidebar', C: 'Donation timeline' };
const LABELS = { rewards: 'Rewards', polls: 'Polls', goals: 'Fund goals' };
const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const WALLET_CREDIT = 2500;
const MIN_CREDIT_CENTS = 100;
// Separate from the pool picker. Nothing in this prototype writes to this draft.
const REGULAR_DRAFT = {
  id: 'existing-normal-draft',
  pledge_cents: 2500,
  channel: 'ESA Summer · Main',
  selections: [{ target: 'Digital download', quantity: 1, amount_cents: 300 }],
};

type Selection = {
  id: string;
  category: Category;
  label: string;
  cents: number;
  quantity?: number;
  message?: string;
};
type HistoryLine = { text: string; category?: Category; items?: Selection[] };
type Pledge = {
  id: string;
  date: string;
  channelId: string;
  channel: string;
  ended: boolean;
  original: number;
  funded: number;
  credit: Record<Category, number>;
  allocated: Record<Category, number>;
  history: HistoryLine[];
};

function fixtures(): Pledge[] {
  return [
    {
      id: 'pledge-main-12',
      date: '12 July 2026',
      channelId: 'main',
      channel: 'ESA Summer · Main',
      ended: false,
      original: 2500,
      funded: 1000,
      credit: { rewards: 800, polls: 600, goals: 200 },
      allocated: { rewards: 200, polls: 400, goals: 800 },
      history: [
        {
          text: 'Original pledge $25.00: $15.00 new money + $10.00 wallet credit. Shipping was a separate $5.00 charge.',
        },
        {
          text: 'Unshipped physical item cancelled: $15.00 item + $5.00 unused shipping refunded to Stripe. Remaining funded pledge: $10.00; live category cap: $10.00 each.',
        },
        {
          text: 'The active balances shown above are post-adjustment fixtures. Cancellation accounting is not simulated here.',
        },
      ],
    },
    {
      id: 'pledge-side-10',
      date: '10 July 2026',
      channelId: 'side',
      channel: 'ESA Summer · Side stream',
      ended: false,
      original: 1000,
      funded: 1000,
      credit: { rewards: 0, polls: 300, goals: 50 },
      allocated: { rewards: 1000, polls: 700, goals: 950 },
      history: [
        {
          text: 'Original pledge $10.00. A rejected poll option and reversed goal contribution returned credit to their own pools, not to the wallet.',
        },
      ],
    },
    {
      id: 'pledge-winter-20',
      date: '20 February 2026',
      channelId: 'winter',
      channel: 'ESA Winter · Main',
      ended: true,
      original: 1000,
      funded: 1000,
      credit: { rewards: 0, polls: 0, goals: 0 },
      allocated: { rewards: 700, polls: 800, goals: 900 },
      history: [
        {
          text: 'Event ended: $2.00 poll credit and $1.00 goal credit became unused pool money for a moderator to assign.',
        },
        {
          text: '$3.00 reward pool credit expired. None of these amounts became wallet credit; there is no donor spending action.',
        },
      ],
    },
  ];
}

const REWARDS: {
  id: string;
  channelId: string | null;
  title: string;
  type: 'DIGITAL' | 'SHOUTOUT';
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
    channelId: null,
    title: 'Bonus digital pack',
    type: 'DIGITAL',
    price: 200,
    stock: 0,
    description: 'Example of an unavailable reward.',
  },
];
const POLLS = [
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
    id: 'costume',
    channelId: null,
    title: 'Choose the finale costume',
    options: [
      { id: 'wizard', label: 'Wizard', current: 8000 },
      { id: 'pirate', label: 'Pirate', current: 12000 },
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
];
const GOALS = [
  {
    id: 'bonus-run',
    channelId: 'main',
    title: 'Unlock a bonus speedrun',
    current: 32000,
    target: 50000,
  },
  { id: 'encore', channelId: null, title: 'Community encore', current: 64000, target: 100000 },
  { id: 'side-race', channelId: 'side', title: 'Side stream race', current: 21000, target: 30000 },
];
const initialStock = () => Object.fromEntries(REWARDS.map((r) => [r.id, r.stock]));

type WalletProps = {
  pledges: Pledge[];
  stock: Record<string, number>;
  spend: (pledge: Pledge) => void;
  showDraft: () => void;
};

const hasUsableCredit = (pledge: Pledge, stock: Record<string, number>) =>
  !pledge.ended &&
  (pledge.credit.polls >= MIN_CREDIT_CENTS ||
    pledge.credit.goals >= MIN_CREDIT_CENTS ||
    REWARDS.some(
      (reward) =>
        (reward.channelId === null || reward.channelId === pledge.channelId) &&
        (stock[reward.id] ?? 0) > 0 &&
        reward.price <= pledge.credit.rewards,
    ));

function WalletCredit({ showDraft }: { showDraft: WalletProps['showDraft'] }) {
  return (
    <section className="btrl-panel p-6">
      <p className="font-mono text-xs uppercase tracking-widest text-d-yellow">wallet credit</p>
      <p className="font-display text-5xl mt-2">{fmt(WALLET_CREDIT)}</p>
      <p className="font-body text-sm text-off-white/60 mt-2">
        For a future normal pledge. Separate from every pledge’s category pools — never added
        together.
      </p>
      <p className="font-data text-sm text-off-white/55 mt-3">
        Wallet and pool credit cannot pay for physical reward prices. Shipping addresses stay in
        Stripe.
      </p>
      <button className="btrl-button btrl-button-outline text-sm mt-4" onClick={showDraft}>
        view normal pledge flow · mock draft
      </button>
    </section>
  );
}

function PledgeHistory({ pledge }: { pledge: Pledge }) {
  return (
    <details className="mt-5 pt-4 border-t">
      <summary className="font-data font-bold text-sm cursor-pointer uppercase tracking-wide">
        pledge history
      </summary>
      <ul className="mt-3 space-y-2 font-body text-sm text-off-white/60">
        {pledge.history.map((line, index) => (
          <li key={index}>
            <p>{line.text}</p>
            {line.items && (
              <ul className="pl-4 mt-1 list-disc text-off-white">
                {line.items.map((item) => (
                  <li key={item.id}>
                    {LABELS[item.category]} · {item.label}
                    {item.quantity ? ` × ${item.quantity}` : ''} · {fmt(item.cents)}
                    {item.message ? ` · “${item.message}”` : ''}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PledgeCard({
  pledge,
  stock,
  spend,
  rows = false,
}: {
  pledge: Pledge;
  stock: WalletProps['stock'];
  spend: WalletProps['spend'];
  rows?: boolean;
}) {
  const positive = CATEGORIES.filter((c) => pledge.credit[c] > 0);
  return (
    <article className="btrl-panel p-5 md:p-6">
      <div className="flex flex-wrap justify-between gap-3 mb-4">
        <div>
          <p className="font-mono text-xs text-off-white/55">
            {pledge.id} · {pledge.date}
          </p>
          <h3 className="font-display text-2xl uppercase mt-1">{pledge.channel}</h3>
        </div>
        <div className="font-data text-sm text-right">
          <p className={pledge.ended ? 'text-off-white/55' : 'text-green'}>
            {pledge.ended ? 'Event ended · history only' : 'Active Event'}
          </p>
          <p>Original pledge {fmt(pledge.original)}</p>
        </div>
      </div>
      {!pledge.ended &&
        (positive.length ? (
          <div>
            <dl className={rows ? 'divide-y divide-off-white/10' : 'flex flex-wrap gap-4'}>
              {positive.map((category) => (
                <div
                  key={category}
                  className={rows ? 'flex flex-wrap items-center gap-4 py-3' : 'font-data py-2'}
                >
                  <dt className="font-data font-bold">{LABELS[category]} credit</dt>
                  <dd className="font-display text-3xl text-d-yellow">
                    {fmt(pledge.credit[category])}
                  </dd>
                  {category !== 'rewards' && pledge.credit[category] < MIN_CREDIT_CENTS && (
                    <p className="font-data text-sm text-off-white/55">
                      Below the current {fmt(MIN_CREDIT_CENTS)} minimum allocation
                    </p>
                  )}
                </div>
              ))}
            </dl>
            <p className="font-data text-sm text-off-white/55 mt-3">
              Use these credits together in one review. Each balance stays with its category and
              this original pledge’s Channel.
            </p>
            <button
              className="btrl-button text-sm mt-4"
              disabled={!hasUsableCredit(pledge, stock)}
              onClick={() => spend(pledge)}
            >
              use credits →
            </button>
            {!hasUsableCredit(pledge, stock) && (
              <p className="font-data text-sm text-off-white/55 mt-2">
                These balances cannot currently cover an eligible reward or the{' '}
                {fmt(MIN_CREDIT_CENTS)} poll/goal minimum. They remain here.
              </p>
            )}
          </div>
        ) : (
          <p className="font-body text-sm text-off-white/55">
            No positive pool credit left in this pledge.
          </p>
        ))}
      <PledgeHistory pledge={pledge} />
    </article>
  );
}

function VariantA({ pledges, stock, spend, showDraft }: WalletProps) {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <WalletCredit showDraft={showDraft} />
      <div>
        <h2 className="font-display text-3xl mb-3">credits by original pledge</h2>
        <div className="space-y-4">
          {pledges
            .filter((p) => !p.ended && CATEGORIES.some((c) => p.credit[c] > 0))
            .map((p) => (
              <PledgeCard key={p.id} pledge={p} stock={stock} spend={spend} />
            ))}
        </div>
      </div>
      <section>
        <h2 className="font-display text-3xl mb-3">past pledges</h2>
        {pledges
          .filter((p) => p.ended || CATEGORIES.every((c) => p.credit[c] === 0))
          .map((p) => (
            <PledgeCard key={p.id} pledge={p} stock={stock} spend={spend} />
          ))}
      </section>
    </div>
  );
}

function VariantB({ pledges, stock, spend, showDraft }: WalletProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] items-start">
      <aside className="lg:sticky lg:top-6">
        <WalletCredit showDraft={showDraft} />
        <p className="font-body text-sm text-off-white/55 mt-4">
          One original pledge per card. Category credit stays with that pledge and Channel.
        </p>
      </aside>
      <div className="space-y-4 min-w-0">
        <h2 className="font-display text-3xl">credits by original pledge</h2>
        {pledges
          .filter((p) => !p.ended && CATEGORIES.some((c) => p.credit[c] > 0))
          .map((p) => (
            <PledgeCard key={p.id} pledge={p} stock={stock} spend={spend} />
          ))}
        <h2 className="font-display text-3xl pt-3">past pledges</h2>
        {pledges
          .filter((p) => p.ended || CATEGORIES.every((c) => p.credit[c] === 0))
          .map((p) => (
            <PledgeCard key={p.id} pledge={p} stock={stock} spend={spend} />
          ))}
      </div>
    </div>
  );
}

function VariantC({ pledges, stock, spend, showDraft }: WalletProps) {
  return (
    <div className="max-w-5xl mx-auto">
      <WalletCredit showDraft={showDraft} />
      <h2 className="font-display text-3xl mt-8 mb-5">donation timeline</h2>
      <ol className="border-l border-off-white/20 ml-2 space-y-7">
        {pledges.map((pledge) => (
          <li key={pledge.id} className="pl-5 relative">
            <span className="absolute -left-1.5 top-3 w-3 h-3 rounded-full bg-d-yellow" />
            <p className="font-data text-sm text-d-yellow mb-2">
              {pledge.date} · {pledge.ended ? 'Past Event' : 'Paid pledge'}
            </p>
            <PledgeCard pledge={pledge} stock={stock} spend={spend} rows />
          </li>
        ))}
      </ol>
    </div>
  );
}

function PrototypeSwitcher({ variant, enabled }: { variant: Variant; enabled: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const change = (offset: number) => {
    const next =
      VARIANTS[(VARIANTS.indexOf(variant) + offset + VARIANTS.length) % VARIANTS.length] ?? 'A';
    const params = new URLSearchParams(location.search);
    params.set('variant', next);
    navigate(`${location.pathname}?${params}`, { replace: true });
  };
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
        change(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    if (!enabled) return;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, location.search, navigate, variant, enabled]);
  if (!enabled) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 btrl-panel-dark shadow-lg p-2 flex items-center gap-3 max-w-[95vw]">
      <button
        className="btrl-button btrl-button-outline"
        aria-label="Previous wallet layout"
        onClick={() => change(-1)}
      >
        ←
      </button>
      <div className="text-center min-w-40">
        <p className="font-mono text-xs text-d-yellow">PROTOTYPE · {variant} / 3</p>
        <p className="font-data font-bold">{VARIANT_NAMES[variant]}</p>
      </div>
      <button className="btrl-button" aria-label="Next wallet layout" onClick={() => change(1)}>
        →
      </button>
    </div>
  );
}

export default function WalletCreditPrototype({ standalone = false }: { standalone?: boolean }) {
  const preview = import.meta.env.DEV || standalone;
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const variant: Variant =
    params.get('variant') === 'B' ? 'B' : params.get('variant') === 'C' ? 'C' : 'A';
  const rawCategory = params.get('category');
  const [pledges, setPledges] = useState(fixtures);
  const [stock, setStock] = useState(initialStock);
  // This picker state never shares the mock normal draft, let alone the real cart.
  const [selections, setSelections] = useState<Selection[]>([]);
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'browse' | 'review'>('browse');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [extraPanel, setExtraPanel] = useState<'help' | 'draft' | null>(null);
  const [reviewCredit, setReviewCredit] = useState<Record<Category, number> | null>(null);
  const [staleSimulated, setStaleSimulated] = useState(false);
  const applyLock = useRef(false);
  const source = pledges.find((p) => p.id === params.get('pledge'));
  const spending = location.pathname === '/donate';
  // Only changing the original source or leaving this mode clears the picker.
  const modeKey = spending ? params.get('pledge') : 'wallet';
  const category =
    CATEGORIES.find((c) => c === rawCategory) ??
    (source?.credit.rewards ? 'rewards' : source?.credit.polls ? 'polls' : 'goals');
  const available = source?.credit ?? { rewards: 0, polls: 0, goals: 0 };
  const used: Record<Category, number> = { rewards: 0, polls: 0, goals: 0 };
  for (const item of selections) used[item.category] += item.cents;
  const remaining = {
    rewards: available.rewards - used.rewards,
    polls: available.polls - used.polls,
    goals: available.goals - used.goals,
  };
  const overBudget = CATEGORIES.some((c) => remaining[c] < 0);
  const creditChanged = !reviewCredit || CATEGORIES.some((c) => reviewCredit[c] !== available[c]);
  const eligibleRewards = REWARDS.filter(
    (r) => r.channelId === null || r.channelId === source?.channelId,
  );
  const eligiblePolls = POLLS.filter(
    (p) => p.channelId === null || p.channelId === source?.channelId,
  );
  const eligibleGoals = GOALS.filter(
    (g) => g.channelId === null || g.channelId === source?.channelId,
  );

  useEffect(() => {
    setSelections([]);
    setAmountInputs({});
    setStep('browse');
    setError('');
    setReviewCredit(null);
    setStaleSimulated(false);
    applyLock.current = false;
  }, [modeKey]);

  const walletUrl = `/wallet?prototype=pool-credit&variant=${variant}`;
  const goWallet = () => {
    setSelections([]);
    setExtraPanel(null);
    navigate(walletUrl);
  };
  const spend: WalletProps['spend'] = (pledge) => {
    setNotice('');
    setExtraPanel(null);
    navigate(`/donate?prototype=pool-credit&variant=${variant}&pledge=${pledge.id}`);
  };
  const selectTab = (next: Category) => {
    const nextParams = new URLSearchParams(location.search);
    nextParams.set('category', next);
    navigate(`${location.pathname}?${nextParams}`, { replace: true });
  };
  const reset = () => {
    setPledges(fixtures());
    setStock(initialStock());
    setSelections([]);
    setAmountInputs({});
    setError('');
    setNotice('Demo reset. Wallet credit and the separate $25.00 normal draft are untouched.');
    goWallet();
  };
  const replaceSelection = (item: Selection) => {
    const total =
      used[item.category] -
      (selections.find((s) => s.id === item.id && s.category === item.category)?.cents ?? 0) +
      item.cents;
    if (total > available[item.category]) {
      setError(
        `Only ${fmt(available[item.category])} is available in this pledge’s ${LABELS[item.category].toLowerCase()} credit. Other category balances cannot cover it. Remove or reduce a selection in this category first.`,
      );
      return;
    }
    setSelections((previous) => [
      ...previous.filter((s) => s.id !== item.id || s.category !== item.category),
      item,
    ]);
    setError('');
  };
  const remove = (id: string, selectedCategory: Category) => {
    setSelections((previous) =>
      previous.filter((s) => s.id !== id || s.category !== selectedCategory),
    );
    setError('');
  };
  const chooseAmount = (id: string, label: string, selectedCategory: Category) => {
    const input = amountInputs[`${selectedCategory}:${id}`] ?? String(MIN_CREDIT_CENTS / 100);
    const cents = Math.round(Number(input) * 100);
    if (
      !/^\d+(\.\d{0,2})?$/.test(input) ||
      !Number.isSafeInteger(cents) ||
      cents < MIN_CREDIT_CENTS
    ) {
      setError(
        `Minimum allocation ${fmt(MIN_CREDIT_CENTS)}; enter a dollar amount with at most two decimal places. Remove a selection to allocate $0.`,
      );
      return;
    }
    replaceSelection({ id, category: selectedCategory, label, cents });
  };
  const existingAmount = (id: string, selectedCategory: Category) =>
    pledges.reduce(
      (sum, p) =>
        sum +
        p.history.reduce(
          (subtotal, h) =>
            subtotal +
            (h.items
              ?.filter((i) => i.id === id && i.category === selectedCategory)
              .reduce((n, i) => n + i.cents, 0) ?? 0),
          0,
        ),
      0,
    );
  const review = () => {
    setReviewCredit({ ...available });
    setError('');
    setStep('review');
  };
  const apply = () => {
    if (applyLock.current || !source || source.ended || !selections.length) return;
    if (creditChanged) {
      setError(
        'Credit changed while you were reviewing. Nothing was applied. Refresh all source balances and reconfirm your selections.',
      );
      return;
    }
    const valid = selections.every((item) => {
      if (item.category === 'rewards') {
        const reward = eligibleRewards.find((r) => r.id === item.id);
        return (
          reward &&
          item.quantity &&
          Number.isInteger(item.quantity) &&
          item.quantity > 0 &&
          item.quantity <= (stock[item.id] ?? 0) &&
          item.cents === item.quantity * reward.price
        );
      }
      const eligible =
        item.category === 'polls'
          ? eligiblePolls.flatMap((p) => p.options).some((o) => o.id === item.id)
          : eligibleGoals.some((g) => g.id === item.id);
      return eligible && Number.isSafeInteger(item.cents) && item.cents >= MIN_CREDIT_CENTS;
    });
    if (!valid || overBudget) {
      setError(
        'Nothing was applied. These selections no longer fit their own category credit or stock. Edit them before applying.',
      );
      return;
    }
    // Validate the whole mock batch before any in-memory writes. No backend operation.
    // Synchronous lock prevents a second click before React renders/navigation finishes.
    applyLock.current = true;
    const appliedCategories = CATEGORIES.filter((c) => used[c] > 0);
    const appliedCopy = appliedCategories.map((c) => `${LABELS[c]} ${fmt(used[c])}`).join(' · ');
    const line: HistoryLine = {
      text: `Mock allocation batch: ${appliedCopy}. Money totals did not change.`,
      items: selections.map((s) => ({ ...s })),
    };
    setPledges((previous) =>
      previous.map((p) =>
        p.id === source.id
          ? {
              ...p,
              credit: { ...remaining },
              allocated: {
                rewards: p.allocated.rewards + used.rewards,
                polls: p.allocated.polls + used.polls,
                goals: p.allocated.goals + used.goals,
              },
              history: [...p.history, line],
            }
          : p,
      ),
    );
    setStock((previous) => {
      const next = { ...previous };
      for (const item of selections.filter((s) => s.category === 'rewards'))
        next[item.id] = (next[item.id] ?? 0) - (item.quantity ?? 0);
      return next;
    });
    setNotice(
      `Applied selected credits in one mock batch: ${appliedCopy}, from ${source.id} · ${source.date} · ${source.channel}. Unused balances stay with their categories. Wallet credit, the $25.00 draft and money totals are unchanged.`,
    );
    goWallet();
  };
  const staleCategory = CATEGORIES.find((c) => available[c] >= MIN_CREDIT_CENTS);
  const simulateStale = () => {
    if (!source || !staleCategory || staleSimulated) return;
    setPledges((previous) =>
      previous.map((p) =>
        p.id === source.id
          ? {
              ...p,
              credit: {
                ...p.credit,
                [staleCategory]: p.credit[staleCategory] - MIN_CREDIT_CENTS,
              },
              allocated: {
                ...p.allocated,
                [staleCategory]: p.allocated[staleCategory] + MIN_CREDIT_CENTS,
              },
              history: [
                ...p.history,
                {
                  text: `Demo only: ${fmt(MIN_CREDIT_CENTS)} ${LABELS[staleCategory].toLowerCase()} credit used elsewhere while this review was open.`,
                  category: staleCategory,
                },
              ],
            }
          : p,
      ),
    );
    setStaleSimulated(true);
    setError(
      'Demo: one category balance changed. The whole batch is blocked; nothing else was applied. Refresh all source balances, then reconfirm (or edit if the selections no longer fit).',
    );
  };

  const amountControl = (id: string, label: string, selectedCategory: Category) => {
    const selection = selections.find((s) => s.id === id && s.category === selectedCategory);
    const inputKey = `${selectedCategory}:${id}`;
    return (
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <label className="font-data text-sm">
          ${' '}
          <input
            aria-label={`${label} allocation in dollars`}
            type="number"
            min={MIN_CREDIT_CENTS / 100}
            step="0.01"
            className="w-20 px-2 py-1"
            value={amountInputs[inputKey] ?? String(MIN_CREDIT_CENTS / 100)}
            onChange={(e) =>
              setAmountInputs((previous) => ({ ...previous, [inputKey]: e.target.value }))
            }
          />
        </label>
        <button
          className="btrl-button text-sm"
          onClick={() => chooseAmount(id, label, selectedCategory)}
        >
          {selection ? 'update' : 'add'}
        </button>
        {selection && (
          <>
            <button
              className="btrl-button btrl-button-outline text-sm"
              onClick={() => remove(id, selectedCategory)}
            >
              remove
            </button>
            <span className="font-data text-green">Selected {fmt(selection.cents)}</span>
          </>
        )}
      </div>
    );
  };
  const invalidSource =
    !source || source.ended || (!hasUsableCredit(source, stock) && selections.length === 0);
  const Layout = variant === 'B' ? VariantB : variant === 'C' ? VariantC : VariantA;

  return (
    <div className="min-h-screen pb-28">
      {preview && (
        <style>{`
        @font-face { font-family: 'Bebas Neue Pro'; src: url('${import.meta.env.BASE_URL}fonts/BebasNeuePro.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Cabin BTRL'; src: url('${import.meta.env.BASE_URL}fonts/Cabin-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Bold.ttf') format('truetype'); font-weight: 700; font-style: normal; font-display: swap; }
      `}</style>
      )}
      <nav
        className="flex flex-wrap items-center gap-4 md:gap-6 px-6 py-4 border-b"
        style={{ background: 'var(--dark-gray)' }}
      >
        <button onClick={goWallet} className="font-display text-2xl tracking-wide uppercase">
          esa dono
        </button>
        <button
          onClick={goWallet}
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
          onClick={goWallet}
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
      <div className="max-w-6xl mx-auto px-4 md:px-8 pt-6">
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
                {extraPanel === 'help' ? 'credit guide' : 'existing normal draft · $25.00'}
              </h2>
              <button className="text-d-yellow font-data" onClick={() => setExtraPanel(null)}>
                close
              </button>
            </div>
            {extraPanel === 'help' ? (
              <p className="font-body text-sm text-off-white/60 mt-2">
                Wallet credit is separate from pool credit. Choose one original pledge, browse all
                incentive tabs, then apply your selected category credits together without a
                payment. Neither type of credit pays for physical reward prices. Ended-Event
                outcomes live only in history.
              </p>
            ) : (
              <p className="font-body text-sm text-off-white/60 mt-2">
                Normal pledge flow preview only · ESA Summer · Main · $25.00 pledge · 1 digital
                download selected. This separate mock draft stays untouched. No wallet credit is
                applied here; normal donation and checkout are outside this prototype.
              </p>
            )}
          </aside>
        )}
        {notice && (
          <div role="status" className="btrl-panel p-4 mb-6 text-green font-body text-sm">
            {notice}
          </div>
        )}
        {!spending ? (
          <>
            <h1 className="font-display text-4xl uppercase mb-2">available credits</h1>
            <p className="font-body text-sm text-off-white/60 mb-6">
              All your outstanding credits in one place. Choose an original pledge to use its
              rewards, polls and goals credits together. Wallet credit follows the normal pledge
              flow.
            </p>
            <Layout
              pledges={pledges}
              stock={stock}
              spend={spend}
              showDraft={() => setExtraPanel('draft')}
            />
          </>
        ) : invalidSource ? (
          <section className="btrl-panel p-6">
            <h1 className="font-display text-3xl mb-3">credit unavailable</h1>
            <p className="font-body text-sm text-off-white/60 mb-4">
              Choose an original live pledge with usable credit from Available credits. Poll and
              goal allocations need at least {fmt(MIN_CREDIT_CENTS)}; rewards need their whole-unit
              price and stock. Ended pledges cannot be spent.
            </p>
            <button className="btrl-button" onClick={goWallet}>
              back to wallet
            </button>
          </section>
        ) : (
          source && (
            <div className="max-w-4xl mx-auto">
              <button className="font-data text-d-yellow mb-4" onClick={goWallet}>
                ← wallet · discard these selections
              </button>
              <h1 className="font-display text-4xl mb-4">use your credits</h1>
              <div className="sticky top-0 z-30 btrl-panel-dark shadow-lg p-4 mb-5">
                <p className="font-data text-sm text-off-white/60 mb-3">
                  {source.id} · {source.date} · {source.channel}
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex-1 grid gap-3 sm:grid-cols-3 min-w-48">
                    {CATEGORIES.map((c) => (
                      <div key={c} className="font-data text-sm">
                        <p className="font-bold">
                          {LABELS[c]} · {fmt(available[c])} available
                        </p>
                        <p className={remaining[c] < 0 ? 'text-red' : 'text-off-white/60'}>
                          {fmt(used[c])} selected · {fmt(remaining[c])} left
                        </p>
                        <ProgressBar value={used[c]} max={available[c]} animateOnChange={false} />
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
                    <button
                      className="btrl-button btrl-button-outline"
                      onClick={() => {
                        setStep('browse');
                        setError('');
                      }}
                    >
                      edit selections
                    </button>
                  )}
                </div>
              </div>
              <p className="font-data text-sm text-off-white/55 mb-4">
                Pool-credit mode · your regular $25.00 donation draft is unchanged.
              </p>
              {error && (
                <p role="alert" className="btrl-panel-dark p-4 mb-4 text-red font-body text-sm">
                  {error}
                </p>
              )}
              {step === 'review' ? (
                <section className="btrl-panel p-6">
                  <p className="font-mono text-xs text-d-yellow uppercase tracking-widest mb-3">
                    2 · review pool credit
                  </p>
                  <h2 className="font-display text-3xl mb-2">your selections</h2>
                  <p className="font-data text-sm text-off-white/60 mb-4">
                    Original pledge {source.id} · {source.date} · {source.channel}
                  </p>
                  {CATEGORIES.filter((c) => used[c] > 0).map((c) => (
                    <div key={c} className="mb-4">
                      <h3 className="font-data font-bold text-d-yellow">{LABELS[c]}</h3>
                      <ul className="divide-y divide-off-white/10">
                        {selections
                          .filter((item) => item.category === c)
                          .map((item) => (
                            <li key={item.id} className="py-3 flex justify-between gap-4 font-data">
                              <div>
                                <p className="font-bold">
                                  {item.label}
                                  {item.quantity ? ` × ${item.quantity}` : ''}
                                </p>
                                {item.message && (
                                  <p className="font-body text-sm text-off-white/60">
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
                  <dl className="font-data space-y-2 py-5 mt-2 border-t">
                    {CATEGORIES.map((c) => (
                      <div key={c} className="flex flex-wrap justify-between gap-2">
                        <dt>{LABELS[c]} credit</dt>
                        <dd className={remaining[c] < 0 ? 'text-red' : ''}>
                          <strong className="text-d-yellow">{fmt(used[c])} used</strong> ·{' '}
                          {fmt(remaining[c])} remaining
                        </dd>
                      </div>
                    ))}
                    <div className="flex justify-between text-off-white/55">
                      <dt>Wallet credit (untouched)</dt>
                      <dd>{fmt(WALLET_CREDIT)}</dd>
                    </div>
                  </dl>
                  <p className="font-body text-sm text-off-white/60 mb-5">
                    No payment or new donation. Applying pool credit changes incentive allocations,
                    not money totals. Unselected credit stays in this pledge and category. Physical
                    rewards are excluded; no shipping checkout or inventory/shipping holds are
                    created.
                  </p>
                  {creditChanged && (
                    <div className="border-t py-4 mb-3">
                      <p className="font-body text-sm text-red mb-3">
                        One or more category balances changed. Nothing in this batch was applied.
                        Refresh all balances and reconfirm; edit first if selections no longer fit.
                      </p>
                      <p className="font-data text-sm text-off-white/60 mb-3">
                        {CATEGORIES.filter((c) => reviewCredit?.[c] !== available[c])
                          .map(
                            (c) =>
                              `${LABELS[c]}: reviewed ${fmt(reviewCredit?.[c] ?? 0)}, now ${fmt(available[c])}`,
                          )
                          .join(' · ')}
                      </p>
                      <button
                        className="btrl-button btrl-button-outline"
                        onClick={() => {
                          setReviewCredit({ ...available });
                          setError(
                            overBudget
                              ? 'Selections exceed their own refreshed category credit. Use Edit to reduce or remove items; no part of this batch can be applied yet.'
                              : '',
                          );
                        }}
                      >
                        refresh all credit balances
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="btrl-button btrl-button-outline"
                      onClick={() => {
                        setStep('browse');
                        setError('');
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="btrl-button"
                      disabled={
                        !selections.length || overBudget || creditChanged || applyLock.current
                      }
                      onClick={apply}
                    >
                      apply selected credits
                    </button>
                  </div>
                  {preview && (
                    <button
                      className="font-mono text-xs text-off-white/55 underline mt-6"
                      disabled={staleSimulated || !staleCategory}
                      onClick={simulateStale}
                    >
                      demo: simulate {fmt(MIN_CREDIT_CENTS)} stale credit in one category
                    </button>
                  )}
                </section>
              ) : (
                <>
                  <p className="font-mono text-xs text-d-yellow uppercase tracking-widest mb-2">
                    1 · choose incentives
                  </p>
                  <p className="font-body text-sm text-off-white/60 mb-6">
                    Open incentives for {source.channel} or shared across Channels. Browse all tabs
                    and use your category balances in one review. Choices stay selected when you
                    switch tabs; each category can only use its own credit.
                  </p>
                  <div className="flex flex-wrap gap-3 mb-6" aria-label="Incentive categories">
                    {CATEGORIES.map((c) => (
                      <button
                        key={c}
                        className={`btrl-button ${category === c ? '' : 'btrl-button-outline'}`}
                        aria-pressed={category === c}
                        onClick={() => selectTab(c)}
                      >
                        {LABELS[c]}
                      </button>
                    ))}
                  </div>
                  {category !== 'rewards' && available[category] < MIN_CREDIT_CENTS && (
                    <p className="font-body text-sm text-off-white/60 mb-4">
                      {fmt(available[category])} {LABELS[category].toLowerCase()} credit remains
                      visible, but is below the current {fmt(MIN_CREDIT_CENTS)} minimum allocation.
                      You can still use other category credits in this review.
                    </p>
                  )}
                  {category === 'rewards' && (
                    <>
                      <p className="font-body text-sm text-off-white/60 mb-4">
                        Non-physical rewards only. Quantities use the current unit price and
                        available stock.
                      </p>
                      <div className="grid md:grid-cols-2 gap-4">
                        {eligibleRewards.map((reward) => {
                          const selection = selections.find(
                            (s) => s.id === reward.id && s.category === 'rewards',
                          );
                          const quantity = selection?.quantity ?? 0;
                          const left = stock[reward.id] ?? 0;
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
                                {reward.type} · {reward.channelId ? source.channel : 'Shared'} ·{' '}
                                {left} left
                              </p>
                              <div className="flex items-center gap-3 mt-4">
                                <button
                                  aria-label={`Decrease ${reward.title} quantity`}
                                  className="btrl-button btrl-button-outline"
                                  disabled={quantity === 0}
                                  onClick={() =>
                                    quantity === 1
                                      ? remove(reward.id, 'rewards')
                                      : replaceSelection({
                                          ...selection!,
                                          quantity: quantity - 1,
                                          cents: (quantity - 1) * reward.price,
                                        })
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
                                      setSelections((previous) =>
                                        previous.map((s) =>
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
                  {category === 'polls' && (
                    <div className="space-y-4">
                      {eligiblePolls.map((poll) => {
                        const pollTotal = poll.options.reduce(
                          (sum, o) => sum + o.current + existingAmount(o.id, 'polls'),
                          0,
                        );
                        const pendingTotal = poll.options.reduce(
                          (sum, o) =>
                            sum +
                            (selections.find((s) => s.id === o.id && s.category === 'polls')
                              ?.cents ?? 0),
                          0,
                        );
                        return (
                          <article key={poll.id} className="btrl-panel p-5">
                            <h3 className="font-data font-bold text-lg">{poll.title}</h3>
                            <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                              {poll.channelId ? source.channel : 'Shared'} · {fmt(MIN_CREDIT_CENTS)}{' '}
                              minimum per option
                            </p>
                            <div className="space-y-5">
                              {poll.options.map((option) => {
                                const current = option.current + existingAmount(option.id, 'polls');
                                const pending =
                                  selections.find(
                                    (s) => s.id === option.id && s.category === 'polls',
                                  )?.cents ?? 0;
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
                                    {amountControl(
                                      option.id,
                                      `${poll.title} / ${option.label}`,
                                      'polls',
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {category === 'goals' && (
                    <div className="space-y-4">
                      {eligibleGoals.map((goal) => {
                        const current = goal.current + existingAmount(goal.id, 'goals');
                        const pending =
                          selections.find((s) => s.id === goal.id && s.category === 'goals')
                            ?.cents ?? 0;
                        return (
                          <article key={goal.id} className="btrl-panel p-5">
                            <h3 className="font-data font-bold text-lg">{goal.title}</h3>
                            <p className="font-mono text-xs text-off-white/55 mt-1 mb-4">
                              {goal.channelId ? source.channel : 'Shared'} · {fmt(MIN_CREDIT_CENTS)}{' '}
                              minimum
                            </p>
                            <ProgressBar
                              value={current}
                              max={goal.target}
                              previewPct={((current + pending) / goal.target) * 100}
                              animateOnChange={false}
                            />
                            <div className="flex justify-between font-data text-sm text-off-white/55 mt-2">
                              <span>{fmt(current)} allocated</span>
                              <span>goal {fmt(goal.target)}</span>
                            </div>
                            {amountControl(goal.id, goal.title, 'goals')}
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex justify-center mt-6">
                    <button
                      className="btrl-button"
                      disabled={!selections.length || overBudget}
                      onClick={review}
                    >
                      review selections →
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        )}
        <details className="btrl-panel-dark p-4 mt-8">
          <summary className="font-mono text-xs text-off-white/55 cursor-pointer">
            DEMO STATE · balances / selections / untouched draft
          </summary>
          <pre className="text-xs font-mono overflow-auto p-3 mt-3 max-h-96">
            {JSON.stringify(
              {
                variant,
                mode: spending ? 'pool-credit' : 'wallet',
                step: spending ? step : null,
                source_pledge: spending ? (source?.id ?? null) : null,
                category: spending ? (category ?? null) : null,
                wallet_credit_cents: WALLET_CREDIT,
                regular_draft: REGULAR_DRAFT,
                selections,
                source_available_credit_cents: spending ? available : null,
                selected_credit_cents_by_category: used,
                remaining_credit_cents_by_category: spending ? remaining : null,
                reviewed_credit_cents_by_category: reviewCredit,
                pledges,
                stock,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
      <PrototypeSwitcher variant={variant} enabled={preview} />
    </div>
  );
}
