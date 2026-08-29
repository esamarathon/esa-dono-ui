/**
 * Decision generator (wayfinder #37). Turns a seed + discovered catalog into a
 * deterministic, ordered decision log — the reproducible contract (#32).
 *
 * Ordering constraint (#33/#35): a donor must have balance (and a prior donation)
 * before spending. We guarantee every donor's FIRST event is a DONATE, and only
 * emit spend actions for donors who have already donated in the stream.
 *
 * BID_AUCTION is generated but the pure-API path cannot satisfy the server's
 * `email_verified` gate (no admin endpoint sets it) — these are expected to be
 * rejected and are surfaced as a known limitation, not a simulator bug.
 */
import type { Catalog, DecisionEntry, ActionType } from './types.js';
import { makeStreams, int, pick, weighted, exponentialDelayMs } from './prng.js';

const MIN_SPEND_CENTS = 100;

const SPEND_WEIGHTS: readonly (readonly [ActionType, number])[] = [
  ['CLAIM_REWARD', 3],
  ['VOTE_POLL', 3],
  ['CONTRIBUTE_GOAL', 2],
  ['BID_AUCTION', 1],
];

export interface GenerateOptions {
  seed: string | number;
  events: number;
  donors: number;
  ratePerSec: number;
  catalog: Catalog;
}

export function generate(opts: GenerateOptions): DecisionEntry[] {
  const { seed, events, donors, ratePerSec, catalog } = opts;
  const s = makeStreams(seed);
  const log: DecisionEntry[] = [];
  const donated = new Set<string>(); // donorRefs who have donated so far

  for (let seq = 0; seq < events; seq++) {
    const donorRef = `d${int(s.donor, 1, donors)}`;
    const delayMs = Math.round(exponentialDelayMs(s.timing, ratePerSec));

    // A donor's first appearance must be a donation, so spends have balance.
    const mustDonate = !donated.has(donorRef);
    const action: ActionType = mustDonate
      ? 'DONATE'
      : weighted(s.incentiveType, availableSpends(catalog));

    let params: Record<string, unknown> = {};
    let targetRef: Record<string, string> | undefined;

    switch (action) {
      case 'DONATE':
        donated.add(donorRef);
        params = {
          amountCents: int(s.amount, 5, 200) * 100, // $5–$200
          channelRef: pick(s.incentivePick, catalog.channels),
        };
        break;
      case 'CLAIM_REWARD':
        targetRef = { rewardRef: pick(s.incentivePick, catalog.rewards) };
        break;
      case 'VOTE_POLL': {
        const poll = pick(s.incentivePick, catalog.polls);
        targetRef = {
          pollRef: poll.pollRef,
          optionRef: pick(s.incentivePick, poll.options),
        };
        params = { amountCents: MIN_SPEND_CENTS * int(s.voteAmount, 1, 20) };
        break;
      }
      case 'CONTRIBUTE_GOAL':
        targetRef = { goalRef: pick(s.incentivePick, catalog.goals) };
        params = { amountCents: MIN_SPEND_CENTS * int(s.voteAmount, 1, 20) };
        break;
      case 'BID_AUCTION':
        targetRef = { auctionRef: pick(s.incentivePick, catalog.auctions) };
        params = { amountCents: int(s.amount, 10, 500) * 100 };
        break;
    }

    log.push({ seq, delayMs, actor: { donorRef }, action, params, targetRef });
  }
  return log;
}

/** Only offer spend actions whose incentive type actually exists in the catalog. */
function availableSpends(catalog: Catalog): readonly (readonly [ActionType, number])[] {
  const has: Record<ActionType, boolean> = {
    DONATE: true,
    CLAIM_REWARD: catalog.rewards.length > 0,
    VOTE_POLL: catalog.polls.some((p) => p.options.length > 0),
    CONTRIBUTE_GOAL: catalog.goals.length > 0,
    BID_AUCTION: catalog.auctions.length > 0,
  };
  const available = SPEND_WEIGHTS.filter(([a]) => has[a]);
  // If no incentives exist at all, fall back to more donations.
  return available.length > 0 ? available : [['DONATE', 1]];
}
