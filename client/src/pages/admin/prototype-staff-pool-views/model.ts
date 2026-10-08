// THROWAWAY (#172): fixture data and in-memory state for the staff-views prototype.
// No API, auth, storage or providers. Reload resets everything.
// The "server-computed" previews below are simulated here with the rules decided in
// #159 (Wallet refund / chargeback), #160 (Unused pool money) and #167 (Payment refund).
import { useMemo, useState } from 'react';

export type Category = 'reward' | 'poll' | 'goal';
export type Source = 'donor' | 'auto' | 'moderator';
export type Status = 'PENDING' | 'COMPLETED' | 'REFUNDED' | 'CHARGEBACK';
export type ClaimStatus = 'PENDING' | 'FULFILLED' | 'CANCELLING' | 'REVERSED';
export type PaymentRefundStatus =
  'REQUESTED' | 'PENDING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'RESOLVED';

export const CATEGORIES: Category[] = ['reward', 'poll', 'goal'];
export const POOL_LABEL: Record<Category, string> = {
  reward: 'Rewards',
  poll: 'Polls',
  goal: 'Goals',
};
export const STATUSES: Status[] = ['PENDING', 'COMPLETED', 'REFUNDED', 'CHARGEBACK'];

export const NOT_MONEY_NOTE =
  'Incentive amounts are not money: one dollar can count once in rewards, once in polls and once in goals.';

export function fmt(cents: number) {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
export function signed(cents: number) {
  return cents > 0 ? `+${fmt(cents)}` : fmt(cents);
}

export interface Row {
  id: string;
  category: Category;
  target: string; // reward title, "poll — option" or goal title
  targetChannel: string; // the incentive's Channel; SHARED for channel_id = null
  source: Source;
  cents: number; // recorded amount (claims: price lock, #166)
  live: boolean;
  claim?: { physical: boolean; status: ClaimStatus; flagged?: boolean };
  allocatedBy?: string; // moderator rows (#160)
}

export interface PaymentRefund {
  id: string;
  status: PaymentRefundStatus;
  item: string;
  itemCents: number;
  shippingCents: number;
  stripeRefundId: string | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  resolved: boolean;
}

export interface EndedTargetChange {
  target: string;
  state: string; // "poll ended" | "goal complete"
  deltaCents: number;
  cause: string;
}

export interface Donation {
  id: string;
  donorName: string;
  email: string;
  event: string;
  eventEnded: boolean;
  channel: string | null; // null = unassigned
  status: Status;
  amountCents: number; // money (new money only)
  pledge: {
    pledgeCents: number; // current pledge amount
    walletAppliedCents: number;
    poolCredit: Partial<Record<Category, number>>;
  } | null;
  origin: string; // how it arrived
  stripe: string | null;
  comment: string | null;
  createdAt: string;
  rows: Row[];
  paymentRefunds: PaymentRefund[];
  endedTargetChanges: EndedTargetChange[];
  log: string[]; // prototype-only: what the demo changed
}

const SUMMER = 'ESA Summer 2026';
const AUTUMN = 'ESA Autumn 2026';

function fixtures(): Donation[] {
  return [
    {
      id: 'don_ana',
      donorName: 'Ana',
      email: 'ana@example.com',
      event: SUMMER,
      eventEnded: true,
      channel: 'MAIN',
      status: 'COMPLETED',
      amountCents: 4000,
      pledge: { pledgeCents: 5000, walletAppliedCents: 1000, poolCredit: {} },
      origin: 'Stripe Checkout',
      stripe: 'cs_test_a1Ana',
      comment: "runner's choice",
      createdAt: '2026-07-04T19:12:00Z',
      rows: [
        {
          id: 'r_ana_shirt',
          category: 'reward',
          target: 'ESA T-shirt (physical)',
          targetChannel: 'SHARED',
          source: 'donor',
          cents: 2500,
          live: true,
          claim: { physical: true, status: 'FULFILLED' },
        },
        {
          id: 'r_ana_pa',
          category: 'poll',
          target: 'Final boss runner — Runner A',
          targetChannel: 'MAIN',
          source: 'donor',
          cents: 3000,
          live: true,
        },
        {
          id: 'r_ana_pb',
          category: 'poll',
          target: 'Final boss runner — Runner B',
          targetChannel: 'MAIN',
          source: 'auto',
          cents: 2000,
          live: true,
        },
        {
          id: 'r_ana_glitch',
          category: 'goal',
          target: 'Glitch run',
          targetChannel: 'MAIN',
          source: 'auto',
          cents: 4500,
          live: true,
        },
      ],
      paymentRefunds: [],
      endedTargetChanges: [],
      log: [],
    },
    {
      id: 'don_ben',
      donorName: 'Ben',
      email: 'ben@example.com',
      event: SUMMER,
      eventEnded: true,
      channel: 'MAIN',
      status: 'COMPLETED',
      amountCents: 1500,
      pledge: { pledgeCents: 2500, walletAppliedCents: 1000, poolCredit: {} },
      origin: 'Stripe Checkout',
      stripe: 'cs_test_b2Ben',
      comment: 'good luck!',
      createdAt: '2026-07-05T14:40:00Z',
      rows: [
        {
          id: 'r_ben_shirt',
          category: 'reward',
          target: 'ESA T-shirt (physical)',
          targetChannel: 'SHARED',
          source: 'donor',
          cents: 2500,
          live: false,
          claim: { physical: true, status: 'REVERSED' },
        },
        {
          id: 'r_ben_poll',
          category: 'poll',
          target: 'Final boss runner — Runner A',
          targetChannel: 'MAIN',
          source: 'donor',
          cents: 2500,
          live: true,
        },
        {
          id: 'r_ben_goal',
          category: 'goal',
          target: 'Any% race',
          targetChannel: 'MAIN',
          source: 'donor',
          cents: 2500,
          live: true,
        },
      ],
      paymentRefunds: [
        {
          id: 'pr_ben_1',
          status: 'FAILED',
          item: 'ESA T-shirt (physical)',
          itemCents: 2500,
          shippingCents: 800,
          stripeRefundId: 're_3Ben0001',
          error: 'Payment refund failed: expired_or_canceled_card',
          createdBy: 'admin@localhost',
          createdAt: '2026-07-08T09:15:00Z',
          resolved: false,
        },
      ],
      endedTargetChanges: [
        {
          target: 'Final boss runner — Runner A',
          state: 'poll ended',
          deltaCents: -2500,
          cause: 'Payment refund pr_ben_1',
        },
        {
          target: 'Any% race',
          state: 'goal complete (stays complete)',
          deltaCents: -1500,
          cause: 'Payment refund pr_ben_1',
        },
      ],
      log: [],
    },
    {
      id: 'don_cy',
      donorName: 'Cy',
      email: 'cy@example.com',
      event: AUTUMN,
      eventEnded: false,
      channel: 'SIDE',
      status: 'COMPLETED',
      amountCents: 0,
      pledge: { pledgeCents: 3000, walletAppliedCents: 3000, poolCredit: { goal: 1500 } },
      origin: 'Wallet credit only (no Stripe payment)',
      stripe: null,
      comment: null,
      createdAt: '2026-10-03T20:05:00Z',
      rows: [
        {
          id: 'r_cy_wall',
          category: 'reward',
          target: 'Digital wallpaper pack',
          targetChannel: 'SIDE',
          source: 'donor',
          cents: 500,
          live: true,
          claim: { physical: false, status: 'PENDING' },
        },
        {
          id: 'r_cy_poll',
          category: 'poll',
          target: 'Side category pick — Any% NMG',
          targetChannel: 'SIDE',
          source: 'donor',
          cents: 3000,
          live: true,
        },
        {
          id: 'r_cy_goal',
          category: 'goal',
          target: 'Side bonus run',
          targetChannel: 'SIDE',
          source: 'donor',
          cents: 1500,
          live: true,
        },
      ],
      paymentRefunds: [],
      endedTargetChanges: [],
      log: [],
    },
    {
      id: 'don_dee',
      donorName: 'Dee',
      email: 'dee@example.com',
      event: SUMMER,
      eventEnded: true,
      channel: 'MAIN',
      status: 'CHARGEBACK',
      amountCents: 2000,
      pledge: null,
      origin: 'Admin "add donation" (no pledge)',
      stripe: null,
      comment: null,
      createdAt: '2026-07-06T11:30:00Z',
      rows: [
        {
          id: 'r_dee_poster',
          category: 'reward',
          target: 'Signed poster (physical)',
          targetChannel: 'MAIN',
          source: 'donor',
          cents: 2000,
          live: true,
          claim: { physical: true, status: 'FULFILLED', flagged: true },
        },
      ],
      paymentRefunds: [],
      endedTargetChanges: [],
      log: [],
    },
    {
      id: 'don_eve',
      donorName: 'Eve',
      email: 'eve@example.com',
      event: AUTUMN,
      eventEnded: false,
      channel: 'MAIN',
      status: 'COMPLETED',
      amountCents: 3000,
      pledge: { pledgeCents: 3000, walletAppliedCents: 0, poolCredit: {} },
      origin: 'Stripe Checkout',
      stripe: 'cs_test_e5Eve',
      comment: 'for the mug!',
      createdAt: '2026-10-08T08:02:00Z',
      rows: [
        {
          id: 'r_eve_mug',
          category: 'reward',
          target: 'ESA mug (physical)',
          targetChannel: 'SHARED',
          source: 'donor',
          cents: 1500,
          live: true,
          claim: { physical: true, status: 'CANCELLING' },
        },
        {
          id: 'r_eve_poll',
          category: 'poll',
          target: 'Autumn opener — Runner C',
          targetChannel: 'MAIN',
          source: 'donor',
          cents: 3000,
          live: true,
        },
        {
          id: 'r_eve_goal',
          category: 'goal',
          target: 'Hat trick goal',
          targetChannel: 'MAIN',
          source: 'auto',
          cents: 2000,
          live: true,
        },
        {
          id: 'r_eve_mod',
          category: 'goal',
          target: 'Speedrun charity bonus',
          targetChannel: 'SHARED',
          source: 'moderator',
          cents: 500,
          live: true,
          allocatedBy: 'mod@localhost',
        },
      ],
      paymentRefunds: [
        {
          id: 'pr_eve_1',
          status: 'REQUESTED',
          item: 'ESA mug (physical)',
          itemCents: 1500,
          shippingCents: 600,
          stripeRefundId: null,
          error: null,
          createdBy: 'admin@localhost',
          createdAt: '2026-10-08T09:54:00Z',
          resolved: false,
        },
      ],
      endedTargetChanges: [],
      log: [],
    },
  ];
}

// ---- derived values -------------------------------------------------------

export function liveRows(d: Donation, c?: Category) {
  return d.rows.filter((r) => r.live && (!c || r.category === c));
}
export function sumRows(rows: Row[]) {
  return rows.reduce((s, r) => s + r.cents, 0);
}
export function poolCredit(d: Donation, c: Category) {
  return d.pledge?.poolCredit[c] ?? 0;
}
/** #160: pledge amount − live rows − outstanding Pool credit; 0 after a Wallet refund or chargeback. */
export function unusedPool(d: Donation, c: Category) {
  if (!d.pledge || c === 'reward') return 0;
  if (d.status === 'REFUNDED' || d.status === 'CHARGEBACK') return 0;
  return Math.max(0, d.pledge.pledgeCents - sumRows(liveRows(d, c)) - poolCredit(d, c));
}

export type Flag =
  | 'unused pool money'
  | 'payment refund requested'
  | 'payment refund failed'
  | 'shipped claim after chargeback';

export function flags(d: Donation): Flag[] {
  const out: Flag[] = [];
  if (unusedPool(d, 'poll') + unusedPool(d, 'goal') > 0) out.push('unused pool money');
  if (d.paymentRefunds.some((p) => p.status === 'REQUESTED')) out.push('payment refund requested');
  if (d.paymentRefunds.some((p) => p.status === 'FAILED' && !p.resolved))
    out.push('payment refund failed');
  if (d.rows.some((r) => r.claim?.flagged)) out.push('shipped claim after chargeback');
  return out;
}
export const ATTENTION_FLAGS: Flag[] = [
  'payment refund requested',
  'payment refund failed',
  'shipped claim after chargeback',
];
export function needsAttention(d: Donation) {
  return flags(d).some((f) => ATTENTION_FLAGS.includes(f));
}

// ---- Q4: Wallet refund / Record chargeback --------------------------------

export type Action = 'wallet_refund' | 'chargeback';
export const ACTION_LABEL: Record<Action, string> = {
  wallet_refund: 'Wallet refund',
  chargeback: 'Record chargeback',
};

export function disabledReason(d: Donation): string | null {
  if (d.paymentRefunds.some((p) => p.status === 'REQUESTED'))
    return 'A Payment refund is REQUESTED. Status changes are blocked until it resolves.';
  if (d.status === 'REFUNDED') return 'The status is REFUNDED, which is terminal.';
  if (d.status === 'CHARGEBACK') return 'The status is CHARGEBACK, which is terminal.';
  return null;
}

export interface Preview {
  action: Action;
  reversed: Row[];
  poolCreditCleared: { category: Category; cents: number }[];
  unusedCleared: { category: Category; cents: number }[];
  shippedKept: Row[];
  walletCreditChange: number;
  walletExplain: string;
  moneyTotalChange: number;
}

export function preview(d: Donation, action: Action): Preview {
  const reversed = d.rows.filter((r) => r.live && r.claim?.status !== 'FULFILLED');
  const shippedKept = d.rows.filter((r) => r.live && r.claim?.status === 'FULFILLED');
  const poolCreditCleared = CATEGORIES.map((c) => ({
    category: c,
    cents: poolCredit(d, c),
  })).filter((x) => x.cents > 0);
  const unusedCleared = (['poll', 'goal'] as Category[])
    .map((c) => ({ category: c, cents: unusedPool(d, c) }))
    .filter((x) => x.cents > 0);
  const pledge = d.pledge?.pledgeCents ?? 0;
  let walletCreditChange: number;
  let walletExplain: string;
  if (action === 'wallet_refund') {
    // #159: max rule over rows still live after the reversal (shipped claims stay).
    const mostUsed = Math.max(
      0,
      ...CATEGORIES.map((c) => sumRows(shippedKept.filter((r) => r.category === c))),
    );
    walletCreditChange = pledge - mostUsed;
    walletExplain =
      shippedKept.length > 0
        ? `${fmt(pledge)} pledge amount − ${fmt(mostUsed)} still allocated to fulfilled rewards = ${fmt(walletCreditChange)} returned as Wallet credit.`
        : `The full ${fmt(pledge)} pledge amount returns as Wallet credit because no live allocations remain.`;
  } else {
    walletCreditChange = d.pledge?.walletAppliedCents ?? 0;
    walletExplain = `The Wallet-credit-funded part of the pledge goes back to the wallet; the paid part does not.`;
  }
  return {
    action,
    reversed,
    poolCreditCleared,
    unusedCleared,
    shippedKept,
    walletCreditChange,
    walletExplain,
    moneyTotalChange: action === 'chargeback' ? -d.amountCents : 0,
  };
}

// ---- state hook -------------------------------------------------------------

export function useStaffModel() {
  const [donations, setDonations] = useState<Donation[]>(fixtures);
  const [showKinds, setShowKinds] = useState(false);

  const apply = (id: string, action: Action) => {
    setDonations((all) =>
      all.map((d) => {
        if (d.id !== id || disabledReason(d)) return d;
        const p = preview(d, action);
        const reversedIds = new Set(p.reversed.map((r) => r.id));
        return {
          ...d,
          status: action === 'wallet_refund' ? 'REFUNDED' : 'CHARGEBACK',
          rows: d.rows.map((r) => {
            if (reversedIds.has(r.id))
              return { ...r, live: false, claim: r.claim && { ...r.claim, status: 'REVERSED' } };
            if (action === 'chargeback' && r.live && r.claim?.status === 'FULFILLED')
              return { ...r, claim: { ...r.claim, flagged: true } };
            return r;
          }),
          pledge: d.pledge && { ...d.pledge, poolCredit: {} },
          log: [
            ...d.log,
            `${ACTION_LABEL[action]} (demo): ${p.reversed.length} rows reversed, Wallet credit ${signed(p.walletCreditChange)}, money total ${signed(p.moneyTotalChange)}`,
          ],
        };
      }),
    );
  };

  const reset = () => setDonations(fixtures());

  return useMemo(
    () => ({ donations, apply, reset, showKinds, setShowKinds }),
    [donations, showKinds],
  );
}
export type StaffModel = ReturnType<typeof useStaffModel>;
