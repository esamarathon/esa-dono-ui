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

/**
 * Empirical donation-amount distribution from real ESA Tiltify data
 * (970 donations, Winter 2026). Heavily right-skewed: ~84% are $20 or under
 * (median ~$15, mean ~$34), with a long tail of rare large gifts up to $1500.
 * Each entry is [amountCents, weight]; weights mirror the observed histogram.
 */
const DONATE_AMOUNTS: readonly (readonly [number, number])[] = [
  [100, 38], // $1
  [200, 38], // $2
  [300, 25], // $3
  [400, 10], // $4
  [500, 177], // $5
  [1000, 185], // $6–$10
  [1500, 25], // $11–$15
  [2000, 240], // $16–$20
  [2500, 23], // $21–$25
  [3000, 17], // $26–$30
  [3500, 8], // $31–$35
  [4000, 9], // $36–$40
  [5000, 85], // $41–$50
  [6000, 3], // $51–$60
  [7000, 8], // $61–$70
  [10000, 39], // $71–$100
  [15000, 7], // $101–$150
  [20000, 9], // $151–$200
  [50000, 19], // $201–$500
  [100000, 5], // >$500
];

/** Canned donor comments attached to simulated DONATE events (#37). */
const COMMENTS = [
  'Good luck with the marathon!',
  'Proud of everyone involved.',
  'Keep up the great work!',
  'Watching from home, sending love.',
  'Amazing cause, happy to help.',
  'One more run, go go go!',
  'Rooting for you all.',
  'This is why I love this community.',
  'Keep the energy high!',
  'In memory of a friend. 💙',
  'Let’s smash that goal!',
  'So glad to support this.',
];

const SPEND_WEIGHTS: readonly (readonly [ActionType, number])[] = [
  ['CLAIM_REWARD', 3],
  ['VOTE_POLL', 3],
  ['CONTRIBUTE_GOAL', 2],
  ['BID_AUCTION', 1],
  ['PLEDGE_CHECKOUT', 3],
];

type PledgeItemKind = 'REWARD' | 'POLL_VOTE' | 'GOAL';

/**
 * PLEDGE_CHECKOUT amounts are deliberately small ($1–$5, vs the $1–$20 range
 * plain VOTE_POLL/CONTRIBUTE_GOAL use) to raise the odds a donor's already-
 * donated wallet balance fully covers the cart — this sim never drives a real
 * Stripe checkout, so a pledge that isn't wallet-fully-covered just sits OPEN
 * until it expires, never becoming a visible fulfilled donation (#58).
 */
const PLEDGE_ITEM_WEIGHTS: readonly (readonly [PledgeItemKind, number])[] = [
  ['REWARD', 3],
  ['POLL_VOTE', 3],
  ['GOAL', 2],
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
          amountCents: weighted(s.amount, DONATE_AMOUNTS),
          channelRef: pick(s.incentivePick, catalog.channels),
          comment: pick(s.comment, COMMENTS),
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
      case 'PLEDGE_CHECKOUT': {
        const itemKind = weighted(s.incentiveType, availablePledgeItemKinds(catalog));
        if (itemKind === 'REWARD') {
          const rewardRef = pick(s.incentivePick, catalog.pledgeableRewards);
          targetRef = {
            rewardRef,
            channelRef: catalog.channelOf[rewardRef] ?? pick(s.incentivePick, catalog.channels),
          };
        } else if (itemKind === 'POLL_VOTE') {
          const eligiblePolls = catalog.polls.filter((p) => p.options.length > 0);
          const poll = pick(s.incentivePick, eligiblePolls);
          targetRef = {
            pollRef: poll.pollRef,
            optionRef: pick(s.incentivePick, poll.options),
            channelRef: catalog.channelOf[poll.pollRef] ?? pick(s.incentivePick, catalog.channels),
          };
        } else {
          const goalRef = pick(s.incentivePick, catalog.goals);
          targetRef = {
            goalRef,
            channelRef: catalog.channelOf[goalRef] ?? pick(s.incentivePick, catalog.channels),
          };
        }
        params = { itemKind };
        if (itemKind === 'REWARD') {
          // Mirror the real donor cart (RewardList.tsx): amount_cents is
          // always the reward's own cost, sent explicitly on the item —
          // the server defaults a REWARD item's stored amount_cents to 0
          // when a client omits it (#58 data-quality fix).
          params.amountCents = catalog.rewardCostCents[targetRef.rewardRef!];
        } else {
          params.amountCents = MIN_SPEND_CENTS * int(s.voteAmount, 1, 5);
        }
        break;
      }
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
    PLEDGE_CHECKOUT:
      catalog.pledgeableRewards.length > 0 ||
      catalog.polls.some((p) => p.options.length > 0) ||
      catalog.goals.length > 0,
  };
  const available = SPEND_WEIGHTS.filter(([a]) => has[a]);
  // If no incentives exist at all, fall back to more donations.
  return available.length > 0 ? available : [['DONATE', 1]];
}

/** Only offer PLEDGE_CHECKOUT item kinds whose incentive type actually exists. */
function availablePledgeItemKinds(
  catalog: Catalog,
): readonly (readonly [PledgeItemKind, number])[] {
  const has: Record<PledgeItemKind, boolean> = {
    REWARD: catalog.pledgeableRewards.length > 0,
    POLL_VOTE: catalog.polls.some((p) => p.options.length > 0),
    GOAL: catalog.goals.length > 0,
  };
  const available = PLEDGE_ITEM_WEIGHTS.filter(([k]) => has[k]);
  // availableSpends() already gates PLEDGE_CHECKOUT itself on at least one of
  // these being true, so this is unreachable in practice — kept defensive.
  return available.length > 0 ? available : [['GOAL', 1]];
}
