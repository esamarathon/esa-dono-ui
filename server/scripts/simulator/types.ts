/**
 * Shared types for the platform simulator (wayfinder #37).
 *
 * The decision log (`DecisionEntry[]`) is the reproducible contract (#32): it
 * references donors and incentives by SYNTHETIC refs, never server ids, so a log
 * replays against a freshly reset demo DB (#34). The outcome log records what the
 * server actually did, keyed to decisions by `seq`.
 */

export type ActionType =
  'DONATE' | 'CLAIM_REWARD' | 'VOTE_POLL' | 'CONTRIBUTE_GOAL' | 'BID_AUCTION' | 'PLEDGE_CHECKOUT';

export type DonorProfile = 'casual' | 'regular' | 'collector' | 'voter';
export type TrafficPhase = 'quiet' | 'normal' | 'busy';

/** V2 cart lines retain synthetic refs so logs can replay against a reset DB. */
export type PledgeDecisionItem =
  | { kind: 'REWARD'; rewardRef: string; amountCents: number; quantity: number }
  | { kind: 'POLL_VOTE'; pollRef: string; optionRef: string; amountCents: number }
  | { kind: 'GOAL'; goalRef: string; amountCents: number };

/** One intended action — the reproducible contract entry (#32.6). Intent only. */
export interface DecisionEntry {
  seq: number;
  /** ms to wait BEFORE dispatching this event (seeded `timing` sub-stream, #36). */
  delayMs: number;
  actor: { donorRef: string; profile?: DonorProfile };
  action: ActionType;
  params: Record<string, unknown>;
  targetRef?: Record<string, string>;
  /** Absent in v1 logs, which used params.itemKind + targetRef for one line. */
  items?: PledgeDecisionItem[];
  trafficPhase?: TrafficPhase;
}

/** Observed server response for a decision, keyed by `seq` (#36). */
export interface OutcomeEntry {
  seq: number;
  action: ActionType;
  status: number;
  /** For pledges, true requires wallet fulfillment, not merely HTTP 2xx. */
  accepted: boolean;
  latencyMs: number;
  note?: string;
}

/** Self-describing run metadata (#36). */
export interface Manifest {
  simVersion: string;
  seed: string | number;
  runId: string;
  args: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  eventCount: number;
  gitSha?: string;
}

/** Synthetic-ref catalog of currently-open incentives, built by discovery. */
export interface Catalog {
  channels: string[]; // synthetic channelRef -> resolved separately
  rewards: string[];
  polls: { pollRef: string; options: string[] }[];
  goals: string[];
  auctions: string[];
  /** Maps synthetic ref -> real server id, resolved at execution time (#34). */
  resolve: Record<string, string>;
  /**
   * Synthetic channelRef each reward/poll/goal belongs to, or undefined when
   * shared (channel_id is null server-side). A null mapping means its channel
   * was not discovered, so it is NOT eligible for any pledge channel. This
   * preserves the real donor cart flow's "no mixing channels" rule.
   */
  channelOf: Record<string, string | null | undefined>;
  /**
   * Non-physical reward refs only. PHYSICAL rewards always require a Stripe
   * checkout to collect a shipping address (never wallet-auto-fulfilled), and
   * this simulator never drives real Stripe checkouts — so a pledge cart
   * containing one would just sit OPEN forever. A direct Wallet claim of one is
   * always rejected. Both CLAIM_REWARD and PLEDGE_CHECKOUT draw from this pool.
   */
  pledgeableRewards: string[];
  /**
   * rewardRef -> cost_cents for seeded selection generation. The pooled
   * executor reads live prices/types at review and uses the shared planner;
   * creation stores confirmed line totals, not a replay log's old estimate.
   */
  rewardCostCents: Record<string, number>;
}
