// PROTOTYPE — throwaway (wayfinder ticket "Prototype the amount-first donate flow", #157).
// Pure pool / auto-allocation model shared by every variant so the rules are
// identical and only the layout differs. Rules from map #151:
//   - each category (rewards, polls, goals) has a pool = pledge amount
//   - a category over the pledge amount blocks checkout ("raise to $X")
//   - poll remainder -> donor's own poll selections (proportional, Hamilton)
//     else unused (no default poll)
//   - goal remainder -> donor's own goals (proportional) else the Channel's
//     default goal list (first eligible) else the eligible goal closest to
//     completion
//   - wallet credit = pledge amount - most-used category (after allocation)
//   - the donor cannot untick auto-allocation
import type { Goal, Poll, Reward } from '../../types';

export type Category = 'rewards' | 'polls' | 'goals';
export const CATEGORIES: Category[] = ['rewards', 'polls', 'goals'];
export const CATEGORY_LABEL: Record<Category, string> = {
  rewards: 'rewards',
  polls: 'polls',
  goals: 'fund goals',
};

export interface Selection {
  key: string; // stable: kind:target
  category: Category;
  targetId: string;
  pollId?: string;
  label: string; // "Poll title — option" / reward title / goal title
  cents: number; // donor's own allocation (line total for rewards)
  quantity?: number;
  order: number; // add order, Hamilton tie-break
}

export const MIN_PLEDGE_CENTS = 100;
export const PRESETS_CENTS = [500, 1000, 2500, 5000];

export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function parseDollars(v: string): number {
  const n = Math.round(parseFloat(v) * 100);
  return Number.isFinite(n) ? n : 0;
}

export function used(sels: Selection[], cat: Category): number {
  return sels.filter((s) => s.category === cat).reduce((a, s) => a + s.cents, 0);
}

export interface PoolStatus {
  category: Category;
  used: number;
  pool: number;
  over: number; // > 0 when over the pledge amount
}

export function pools(pledgeCents: number, sels: Selection[]): PoolStatus[] {
  return CATEGORIES.map((c) => {
    const u = used(sels, c);
    return { category: c, used: u, pool: pledgeCents, over: Math.max(0, u - pledgeCents) };
  });
}

/** Smallest pledge amount that fits every category. */
export function raiseTo(pledgeCents: number, sels: Selection[]): number {
  return Math.max(pledgeCents, ...CATEGORIES.map((c) => used(sels, c)));
}

export function canCheckout(pledgeCents: number, sels: Selection[]): boolean {
  return pledgeCents >= MIN_PLEDGE_CENTS && pools(pledgeCents, sels).every((p) => p.over === 0);
}

/** Largest-remainder split of `amount` over weights; ties -> lower order. */
export function hamilton(amount: number, items: { weight: number; order: number }[]): number[] {
  const total = items.reduce((a, i) => a + i.weight, 0);
  if (total === 0 || amount <= 0) return items.map(() => 0);
  const raw = items.map((i) => (amount * i.weight) / total);
  const floors = raw.map(Math.floor);
  let left = amount - floors.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r), order: items[idx]!.order }))
    .sort((a, b) => b.frac - a.frac || a.order - b.order);
  for (const { idx } of byFrac) {
    if (left <= 0) break;
    floors[idx]! += 1;
    left -= 1;
  }
  return floors;
}

export interface AllocationLine {
  category: Category;
  label: string;
  donorCents: number;
  autoCents: number;
  why?: string;
}

export interface Allocation {
  lines: AllocationLine[];
  unused: Record<Category, number>;
  walletCredit: number;
  explain: Record<Category, string>;
}

function eligibleGoal(g: Goal) {
  return g.is_active !== false && !g.is_complete;
}

export function allocate(
  pledgeCents: number,
  sels: Selection[],
  goals: Goal[],
  defaultGoalIds: string[],
): Allocation {
  const lines: AllocationLine[] = [];
  const unused: Record<Category, number> = { rewards: 0, polls: 0, goals: 0 };
  const explain: Record<Category, string> = { rewards: '', polls: '', goals: '' };

  // Rewards: never auto-allocated.
  const rewardSels = sels.filter((s) => s.category === 'rewards');
  rewardSels.forEach((s) =>
    lines.push({ category: 'rewards', label: s.label, donorCents: s.cents, autoCents: 0 }),
  );
  unused.rewards = Math.max(0, pledgeCents - used(sels, 'rewards'));
  explain.rewards =
    unused.rewards > 0
      ? `${fmt(unused.rewards)} of the reward pool is not claimed. Rewards are never auto-allocated.`
      : 'Reward pool fully used.';

  // Polls and goals: proportional top-up of own selections.
  for (const cat of ['polls', 'goals'] as const) {
    const own = sels.filter((s) => s.category === cat);
    const remainder = Math.max(0, pledgeCents - used(sels, cat));
    if (own.length > 0) {
      const shares = hamilton(
        remainder,
        own.map((s) => ({ weight: s.cents, order: s.order })),
      );
      own.forEach((s, i) =>
        lines.push({
          category: cat,
          label: s.label,
          donorCents: s.cents,
          autoCents: shares[i]!,
          why: shares[i]! > 0 ? 'your choice, topped up in proportion' : undefined,
        }),
      );
      explain[cat] =
        remainder > 0
          ? `The ${fmt(remainder)} you did not place is split across your own ${CATEGORY_LABEL[cat]} in proportion.`
          : `${CATEGORY_LABEL[cat]} pool fully used by your choices.`;
      continue;
    }
    if (remainder === 0) continue;
    if (cat === 'polls') {
      unused.polls = remainder;
      explain.polls = `You picked no poll option, so ${fmt(remainder)} of poll money stays unused. Polls have no default; a moderator may assign it later.`;
      continue;
    }
    // Goals: default goal list, then closest to completion.
    const fromList = defaultGoalIds
      .map((id) => goals.find((g) => g.id === id))
      .find((g): g is Goal => !!g && eligibleGoal(g));
    const fallback = goals
      .filter(eligibleGoal)
      .sort((a, b) => a.target_cents - a.current_cents - (b.target_cents - b.current_cents))[0];
    const target = fromList ?? fallback;
    if (!target) {
      unused.goals = remainder;
      explain.goals = `No goal is open, so ${fmt(remainder)} of goal money stays unused.`;
      continue;
    }
    lines.push({
      category: 'goals',
      label: target.title,
      donorCents: 0,
      autoCents: remainder,
      why: fromList ? "this channel's current default goal" : 'closest goal to completion',
    });
    explain.goals = fromList
      ? `You picked no goal, so ${fmt(remainder)} goes to the channel's current default goal (now: ${target.title}). This is checked again when your payment completes.`
      : `You picked no goal and the default list has no open goal, so ${fmt(remainder)} goes to the goal closest to completion (now: ${target.title}).`;
  }

  const totals = CATEGORIES.map((c) =>
    lines.filter((l) => l.category === c).reduce((a, l) => a + l.donorCents + l.autoCents, 0),
  );
  const walletCredit = Math.max(0, pledgeCents - Math.max(...totals));
  return { lines, unused, walletCredit, explain };
}

// ---- fixtures (used when the backend has no incentives for the channel) ----

export const FIXTURE_REWARDS: Reward[] = [
  { id: 'r1', title: 'Shout-out on stream', type: 'DIGITAL', cost_cents: 500, quantity_total: null, quantity_claimed: 12 },
  { id: 'r2', title: 'Runner-signed poster', type: 'PHYSICAL', cost_cents: 2500, quantity_total: 20, quantity_claimed: 17 },
  { id: 'r3', title: 'Name in the credits', type: 'DIGITAL', cost_cents: 1000, quantity_total: null, quantity_claimed: 40 },
];

export const FIXTURE_POLLS: Poll[] = [
  {
    id: 'p1',
    title: 'Name the runner’s file (SM64)',
    total_votes_cents: 41200,
    options: [
      { id: 'p1a', label: 'BOWSER', votes_cents: 20500 },
      { id: 'p1b', label: 'ESA', votes_cents: 15200 },
      { id: 'p1c', label: 'PEACH', votes_cents: 5500 },
    ],
  },
  {
    id: 'p2',
    title: 'Character choice (Celeste B-sides)',
    total_votes_cents: 9800,
    options: [
      { id: 'p2a', label: 'Madeline', votes_cents: 6200 },
      { id: 'p2b', label: 'Badeline', votes_cents: 3600 },
    ],
  },
];

export const FIXTURE_GOALS: Goal[] = [
  { id: 'g1', title: 'Bonus run: Super Metroid 100%', current_cents: 31000, target_cents: 50000 },
  { id: 'g2', title: 'Blindfolded Punch-Out!!', current_cents: 74500, target_cents: 75000 },
  { id: 'g3', title: 'Charity hat-cam', current_cents: 2000, target_cents: 20000 },
];
