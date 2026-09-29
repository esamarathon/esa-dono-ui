/**
 * Logging (wayfinder #36). JSONL, crash-durable (append per event so a partial
 * run survives the very hang/500 being hunted). Two streams kept separate:
 *   decisions.jsonl — the reproducible contract (#32), what --replay reads
 *   outcomes.jsonl  — observed server responses, keyed by seq
 *   manifest.json   — self-describing run metadata
 */
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import type { DecisionEntry, OutcomeEntry, Manifest } from './types.js';

export class RunLogger {
  private decisions: WriteStream;
  private outcomes: WriteStream;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.decisions = createWriteStream(join(dir, 'decisions.jsonl'), { flags: 'w' });
    this.outcomes = createWriteStream(join(dir, 'outcomes.jsonl'), { flags: 'w' });
  }

  decision(entry: DecisionEntry): void {
    this.decisions.write(JSON.stringify(entry) + '\n');
  }

  outcome(entry: OutcomeEntry): void {
    this.outcomes.write(JSON.stringify(entry) + '\n');
  }

  manifest(m: Manifest): void {
    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify(m, null, 2));
  }

  async close(): Promise<void> {
    await Promise.all([
      new Promise<void>((r) => this.decisions.end(r)),
      new Promise<void>((r) => this.outcomes.end(r)),
    ]);
  }
}

/** Read a persisted decision log for --replay. */
export function readDecisions(file: string): DecisionEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecisionEntry);
}

/** Read a prior outcome log (for replay-diff), keyed by seq. */
export function readOutcomes(file: string): Map<number, OutcomeEntry> {
  const map = new Map<number, OutcomeEntry>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as OutcomeEntry;
    map.set(o.seq, o);
  }
  return map;
}

export interface Divergence {
  seq: number;
  action: string;
  was: { status: number; accepted: boolean };
  now: { status: number; accepted: boolean };
}

/** Minimal replay-diff (#36): compare status + accept/reject per seq. */
export function diffOutcome(prior: OutcomeEntry | undefined, now: OutcomeEntry): Divergence | null {
  if (!prior) return null;
  if (prior.status === now.status && prior.accepted === now.accepted) return null;
  return {
    seq: now.seq,
    action: now.action,
    was: { status: prior.status, accepted: prior.accepted },
    now: { status: now.status, accepted: now.accepted },
  };
}
