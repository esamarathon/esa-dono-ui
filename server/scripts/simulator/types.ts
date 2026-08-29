/**
 * Shared types for the platform simulator (wayfinder #37).
 *
 * The decision log (`DecisionEntry[]`) is the reproducible contract (#32): it
 * references donors and incentives by SYNTHETIC refs, never server ids, so a log
 * replays against a freshly reset demo DB (#34). The outcome log records what the
 * server actually did, keyed to decisions by `seq`.
 */

export type ActionType =
  'DONATE' | 'CLAIM_REWARD' | 'VOTE_POLL' | 'CONTRIBUTE_GOAL' | 'BID_AUCTION';

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
}
