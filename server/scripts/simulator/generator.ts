/**
 * Decision generator (wayfinder #37). Turns a seed + discovered catalog into a
 * deterministic, ordered decision log — the reproducible contract (#32).
 *
 * Every donor's FIRST event is a DONATE, followed by a seeded mix of repeat
 * donations and spends. This models intent, not actual balance: depleted wallets
 * and sold-out incentives can still reject spends, and outcomes never influence
 * generation. The entire decision log remains reproducible offline.
 *
 * BID_AUCTION is generated but the pure-API path cannot satisfy the server's
 * `email_verified` gate (no admin endpoint sets it) — these are expected to be
 * rejected and are surfaced as a known limitation, not a simulator bug.
 */
import type {
  Catalog,
  DecisionEntry,
  ActionType,
  DonorProfile,
  PledgeDecisionItem,
  TrafficPhase,
} from './types.js';
import { makeStreams, int, pick, weighted, exponentialDelayMs, type Streams } from './prng.js';

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

type PledgeItemKind = PledgeDecisionItem['kind'];

const PROFILES: readonly DonorProfile[] = ['casual', 'regular', 'collector', 'voter'];
const ACTIVITY: Record<DonorProfile, number> = { casual: 1, regular: 4, collector: 2, voter: 3 };
const NAMES = ['Aurora', 'Pixel', 'Mika', 'Zoë', 'Renée', 'ねこ', 'Runner', 'Speedy'];
const TRAFFIC_RATE: Record<TrafficPhase, number> = { quiet: 0.5, normal: 1, busy: 2 };

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
  /** Probability of another donation after a donor's first (default 0.3). */
  repeatDonationChance?: number;
  /** Phased traffic keeps the requested expected mean delay across the run. */
  traffic?: 'steady' | 'phased';
}

export function generate(opts: GenerateOptions): DecisionEntry[] {
  const {
    seed,
    events,
    donors,
    ratePerSec,
    catalog,
    repeatDonationChance = 0.3,
    traffic = 'phased',
  } = opts;
  if (!Number.isSafeInteger(events) || events < 0)
    throw new Error('events must be a non-negative integer');
  if (!Number.isSafeInteger(donors) || donors < 1)
    throw new Error('donors must be a positive integer');
  if (!Number.isFinite(ratePerSec) || ratePerSec < 0)
    throw new Error('rate must be finite and non-negative');
  if (
    !Number.isFinite(repeatDonationChance) ||
    repeatDonationChance < 0 ||
    repeatDonationChance > 1
  ) {
    throw new Error('repeatDonationChance must be between 0 and 1');
  }
  if (traffic !== 'steady' && traffic !== 'phased')
    throw new Error('traffic must be steady or phased');
  if (events === 0) return [];
  if (!catalog.channels.length)
    throw new Error('Discovery must provide at least one active channel');

  const s = makeStreams(seed);
  const log: DecisionEntry[] = [];
  const donated = new Set<string>();
  const actors = Array.from({ length: donors }, (_, i) => {
    const profile = pick(s.profile, PROFILES);
    return {
      donorRef: `d${i + 1}`,
      profile,
      displayName: `${pick(s.profile, NAMES)} ${i + 1}`,
      channelRef: pick(s.profile, catalog.channels),
    };
  });
  const actorWeights = actors.map((actor) => [actor, ACTIVITY[actor.profile]] as const);
  const validPolls = catalog.polls.filter((p) => p.options.length > 0);
  const matchesChannel = (ref: string, channel: string) =>
    catalog.channelOf[ref] === undefined || catalog.channelOf[ref] === channel;
  // Choose the channel BEFORE cart items, including for shared incentives.
  const cartCatalogs = new Map(
    catalog.channels.map((channel) => [
      channel,
      {
        ...catalog,
        pledgeableRewards: catalog.pledgeableRewards.filter((ref) => matchesChannel(ref, channel)),
        polls: validPolls.filter((p) => matchesChannel(p.pollRef, channel)),
        goals: catalog.goals.filter((ref) => matchesChannel(ref, channel)),
      },
    ]),
  );
  const cartChannels = catalog.channels.filter(
    (channel) => availablePledgeItemKinds(cartCatalogs.get(channel)!).length > 0,
  );
  const spends = availableSpends(catalog).filter(
    ([action]) => action !== 'PLEDGE_CHECKOUT' || cartChannels.length > 0,
  );
  const phases = trafficPhases(s.traffic, events, traffic);
  // Normalize inverse rates, so expected total waiting time is events / rate.
  // HTTP latency is still additional: serial execution is intentional.
  const meanInverseRate = phases.reduce((sum, phase) => sum + 1 / TRAFFIC_RATE[phase], 0) / events;

  for (let seq = 0; seq < events; seq++) {
    const actor = weighted(s.donor, actorWeights);
    const { donorRef, profile, displayName, channelRef } = actor;
    const trafficPhase = phases[seq]!;
    const delayMs = Math.round(
      exponentialDelayMs(s.timing, ratePerSec * TRAFFIC_RATE[trafficPhase] * meanInverseRate),
    );
    const mustDonate = !donated.has(donorRef) || s.repeatDonation() < repeatDonationChance;
    const action: ActionType =
      mustDonate || spends.length === 0
        ? 'DONATE'
        : weighted(
            s.incentiveType,
            spends.map(([a, weight]) => [a, weight * preferenceWeight(profile, a)] as const),
          );

    // Prefer the donor's channel, but allow exploration and shared incentives.
    const choose = <T>(pool: readonly T[], ref: (item: T) => string): T => {
      const preferred = pool.filter((item) => matchesChannel(ref(item), channelRef));
      return pick(s.incentivePick, preferred.length && s.preference() < 0.8 ? preferred : pool);
    };
    const chooseChannel = (pool: string[]) =>
      pool.includes(channelRef) && s.preference() < 0.8 ? channelRef : pick(s.incentivePick, pool);
    let params: Record<string, unknown> = {};
    let targetRef: Record<string, string> | undefined;
    let items: PledgeDecisionItem[] | undefined;

    switch (action) {
      case 'DONATE':
        donated.add(donorRef);
        params = {
          amountCents: donationAmount(s),
          channelRef: chooseChannel(catalog.channels),
          displayName,
          ...commentParams(s.comment),
        };
        break;
      case 'CLAIM_REWARD':
        targetRef = { rewardRef: choose(catalog.rewards, (ref) => ref) };
        params = { quantity: rewardQuantity(s.quantity) };
        break;
      case 'VOTE_POLL': {
        const poll = choose(validPolls, (p) => p.pollRef);
        targetRef = { pollRef: poll.pollRef, optionRef: pick(s.incentivePick, poll.options) };
        params = { amountCents: spendAmount(s.voteAmount, 20) };
        break;
      }
      case 'CONTRIBUTE_GOAL':
        targetRef = { goalRef: choose(catalog.goals, (ref) => ref) };
        params = { amountCents: spendAmount(s.voteAmount, 20) };
        break;
      case 'BID_AUCTION':
        targetRef = { auctionRef: pick(s.incentivePick, catalog.auctions) };
        params = { amountCents: int(s.amount, 10, 500) * 100 };
        break;
      case 'PLEDGE_CHECKOUT': {
        const channel = chooseChannel(cartChannels);
        const pool = cartCatalogs.get(channel)!;
        targetRef = { channelRef: channel };
        params = { displayName, ...commentParams(s.comment) };
        const count = weighted(s.cart, [
          [1, 5],
          [2, 3],
          [3, 1],
          [4, 1],
        ]);
        items = Array.from({ length: count }, (): PledgeDecisionItem => {
          const kind = weighted(s.cart, availablePledgeItemKinds(pool));
          if (kind === 'REWARD') {
            const rewardRef = pick(s.incentivePick, pool.pledgeableRewards);
            return {
              kind,
              rewardRef,
              amountCents: catalog.rewardCostCents[rewardRef]!,
              quantity: rewardQuantity(s.quantity),
            };
          }
          const amountCents = spendAmount(s.voteAmount, 5);
          if (kind === 'POLL_VOTE') {
            const poll = pick(s.incentivePick, pool.polls);
            return {
              kind,
              pollRef: poll.pollRef,
              optionRef: pick(s.incentivePick, poll.options),
              amountCents,
            };
          }
          return { kind, goalRef: pick(s.incentivePick, pool.goals), amountCents };
        });
        break;
      }
    }

    log.push({
      seq,
      delayMs,
      actor: { donorRef, profile },
      action,
      params,
      trafficPhase,
      ...(targetRef ? { targetRef } : {}),
      ...(items ? { items } : {}),
    });
  }
  return log;
}

function preferenceWeight(profile: DonorProfile, action: ActionType): number {
  if (profile === 'collector' && (action === 'CLAIM_REWARD' || action === 'PLEDGE_CHECKOUT'))
    return 3;
  if (profile === 'voter' && action === 'VOTE_POLL') return 4;
  if (profile === 'regular' && action === 'CONTRIBUTE_GOAL') return 2;
  return 1;
}

function donationAmount(s: Streams): number {
  const amount = weighted(s.amount, DONATE_AMOUNTS);
  if (s.amountStyle() < 0.7) return amount;
  const index = DONATE_AMOUNTS.findIndex(([value]) => value === amount);
  const lower = index === 0 ? MIN_SPEND_CENTS : DONATE_AMOUNTS[index - 1]![0] + 1;
  return int(s.amount, lower, amount);
}

function spendAmount(rng: () => number, maxDollars: number): number {
  return rng() < 0.6
    ? MIN_SPEND_CENTS * int(rng, 1, maxDollars)
    : int(rng, MIN_SPEND_CENTS, maxDollars * 100);
}

function rewardQuantity(rng: () => number): number {
  return weighted(rng, [
    [1, 8],
    [2, 2],
    [3, 1],
  ]);
}

function commentParams(rng: () => number): { comment?: string } {
  const sentences = weighted(rng, [
    [0, 3],
    [1, 5],
    [2, 1],
    [4, 1],
  ]);
  return sentences === 0
    ? {}
    : { comment: Array.from({ length: sentences }, () => pick(rng, COMMENTS)).join(' ') };
}

function trafficPhases(
  rng: () => number,
  events: number,
  traffic: 'steady' | 'phased',
): TrafficPhase[] {
  if (traffic === 'steady') return Array<TrafficPhase>(events).fill('normal');
  const phases: TrafficPhase[] = [];
  while (phases.length < events) {
    const phase = weighted<TrafficPhase>(rng, [
      ['quiet', 1],
      ['normal', 2],
      ['busy', 1],
    ]);
    const length = int(rng, 15, 40);
    phases.push(...Array<TrafficPhase>(Math.min(length, events - phases.length)).fill(phase));
  }
  return phases;
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
  return PLEDGE_ITEM_WEIGHTS.filter(([k]) => has[k]);
}
