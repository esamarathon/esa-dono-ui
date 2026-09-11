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

/** One intended action — the reproducible contract entry (#32.6). Intent only. */
export interface DecisionEntry {
  seq: number;
  /** ms to wait BEFORE dispatching this event (seeded `timing` sub-stream, #36). */
  delayMs: number;
  actor: { donorRef: string };
  action: ActionType;
  params: Record<string, unknown>;
  targetRef?: Record<string, string>;
}

/** Observed server response for a decision, keyed by `seq` (#36). */
export interface OutcomeEntry {
  seq: number;
  action: ActionType;
  status: number;
  /** true = server accepted (2xx), false = rejected/errored. */
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
   * shared (channel_id is null server-side) — lets PLEDGE_CHECKOUT (#58) pick
   * a pledge channel_id consistent with the item's own channel scoping,
   * mirroring the real donor cart flow's "no mixing channels" rule.
   */
  channelOf: Record<string, string | undefined>;
  /**
   * Non-physical reward refs only. PHYSICAL rewards always require a Stripe
   * checkout to collect a shipping address (never wallet-auto-fulfilled), and
   * this simulator never drives real Stripe checkouts — so a pledge cart
   * containing one would just sit OPEN forever. Excluded from PLEDGE_CHECKOUT's
   * reward pool (CLAIM_REWARD's plain wallet-claim pool is unaffected).
   */
  pledgeableRewards: string[];
  /**
   * rewardRef -> cost_cents, so PLEDGE_CHECKOUT can send amount_cents on a
   * REWARD cart item — the real donor cart always does (RewardList.tsx),
   * and the server defaults a REWARD item's stored amount_cents to 0 when a
   * client omits it (the pledge total itself is computed server-side from
   * the reward, but the *per-item* amount is whatever the client sent).
   */
  rewardCostCents: Record<string, number>;
}
