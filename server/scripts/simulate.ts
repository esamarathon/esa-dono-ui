/**
 * Seeded pseudo-random platform simulator (wayfinder #37, map #30).
 *
 * Drives random donations + incentive selections against the API to shake out
 * bugs. A `--seed` makes runs reproducible: same seed => same decision stream
 * (#32). Designed for the daily/weekly-resettable demo site (#34).
 *
 * Run:
 *   npx tsx server/scripts/simulate.ts --seed bug-tuesday --events 200 --rate 2/s
 *   npx tsx server/scripts/simulate.ts --seed 4823 --events 50 --dry-run
 *   npx tsx server/scripts/simulate.ts --replay sim-runs/<runId>/decisions.jsonl
 *
 * Known limitation: auction bids require a donor with a verified email, which no
 * admin API can set — those bids are attempted but expected to be gated (403).
 */
import { randomBytes } from 'node:crypto';
import { execSync as sh } from 'node:child_process';
import { join } from 'node:path';
import { discover } from './simulator/discovery.js';
import { generate } from './simulator/generator.js';
import { Executor } from './simulator/executor.js';
import { RunLogger, readDecisions, readOutcomes, diffOutcome } from './simulator/logging.js';
import type { DecisionEntry, Manifest, OutcomeEntry } from './simulator/types.js';

const SIM_VERSION = 'v1';

// --- CLI parsing -----------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parseRate(v: string | undefined): number {
  if (!v) return 2; // default 2/s
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(s|sec|m|min)$/.exec(v.trim());
  if (!m) throw new Error(`invalid --rate "${v}" (use e.g. 2/s or 30/m)`);
  const n = Number(m[1]);
  return m[2]!.startsWith('m') ? n / 60 : n;
}

function parseDurationMs(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(v.trim());
  if (!m) throw new Error(`invalid --duration "${v}" (use e.g. 30m, 2h, 90s)`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]!]!;
  return n * mult;
}

function gitSha(): string | undefined {
  try {
    // stdio 'pipe' suppresses stderr noise when git isn't installed (e.g. the
    // minimal backend runtime image) — absence is expected there, not an error.
    return sh('git rev-parse --short HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Synthetic catalog for offline dry runs (no server needed). */
function mockCatalog(): Awaited<ReturnType<typeof discover>> {
  return {
    channels: ['c1', 'c2'],
    rewards: ['r1', 'r2', 'r3'],
    polls: [
      { pollRef: 'p1', options: ['p1o1', 'p1o2'] },
      { pollRef: 'p2', options: ['p2o1', 'p2o2', 'p2o3'] },
    ],
    goals: ['g1', 'g2'],
    auctions: ['a1'],
    channelOf: {},
    pledgeableRewards: ['r1', 'r2', 'r3'],
    rewardCostCents: { r1: 500, r2: 1000, r3: 1500 },
    resolve: {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const replayFile = typeof args.replay === 'string' ? args.replay : null;
  const seedArg = (args.seed as string) ?? (replayFile ? null : null);
  if (!seedArg && !replayFile) {
    console.error('Error: --seed is required (or --replay <decisions.jsonl>)');
    process.exit(1);
  }

  const baseUrl = (args['base-url'] as string) ?? 'http://localhost:3001';
  const adminKey = (args['admin-key'] as string) ?? process.env.ADMIN_API_KEY ?? 'change-me';
  const events = Number(args.events ?? 200);
  const donors = Number(args.donors ?? 5);
  const ratePerSec = parseRate(args.rate as string | undefined);
  const durationMs = parseDurationMs(args.duration as string | undefined);
  const dryRun = args['dry-run'] === true;
  const verbose = args.verbose === true;
  const runId = (args['run-id'] as string) ?? randomBytes(4).toString('hex');
  const outDir = (args.out as string) ?? join(process.cwd(), 'sim-runs', runId);

  // --- Build the decision log (generate or replay) -------------------------
  let seed: string | number = 0;
  let decisions: DecisionEntry[];
  let catalog: Awaited<ReturnType<typeof discover>>;

  if (replayFile) {
    console.log(`==> Replaying ${replayFile}`);
    decisions = readDecisions(replayFile);
    catalog = await discover(baseUrl);
    seed = 'replay';
  } else {
    seed = /^\d+$/.test(seedArg!) ? Number(seedArg) : seedArg!;
    // Dry runs work offline: if discovery fails (no server), use a mock catalog
    // so a seed's decision stream can be inspected without a running platform.
    try {
      catalog = await discover(baseUrl);
    } catch (err) {
      if (!dryRun) throw err;
      console.log(
        `==> Discovery failed (${(err as Error).message}); using mock catalog for dry run.`,
      );
      catalog = mockCatalog();
    }
    decisions = generate({ seed, events, donors, ratePerSec, catalog });
  }

  console.log(
    `\nsimVersion=${SIM_VERSION} seed=${JSON.stringify(seed)} runId=${runId} ` +
      `events=${decisions.length} rate=${ratePerSec}/s baseUrl=${baseUrl}\n`,
  );

  // --- Dry run: print the decision log, do not touch the API ---------------
  if (dryRun) {
    for (const e of decisions) {
      const tgt = e.targetRef ? ' ' + JSON.stringify(e.targetRef) : '';
      console.log(
        `  #${String(e.seq).padStart(3)} +${String(e.delayMs).padStart(4)}ms ` +
          `${e.actor.donorRef.padEnd(3)} ${e.action.padEnd(16)} ` +
          `${JSON.stringify(e.params)}${tgt}`,
      );
    }
    console.log('\n(dry run — no API calls made)\n');
    return;
  }

  // --- Execute serially ----------------------------------------------------
  const priorOutcomes = replayFile
    ? readOutcomes(join(replayFile, '..', 'outcomes.jsonl'))
    : new Map<number, OutcomeEntry>();

  const logger = new RunLogger(outDir);
  const manifest: Manifest = {
    simVersion: SIM_VERSION,
    seed,
    runId,
    args: { events, donors, ratePerSec, durationMs, baseUrl, replayFile },
    startedAt: new Date().toISOString(),
    eventCount: decisions.length,
    gitSha: gitSha(),
  };
  logger.manifest(manifest);

  const exec = new Executor({ baseUrl, adminKey, runId, catalog });
  const counts = { accepted: 0, rejected: 0, errors: 0 };
  const byAction: Record<string, number> = {};
  const divergences: ReturnType<typeof diffOutcome>[] = [];
  const startTime = Date.now();

  for (const entry of decisions) {
    if (durationMs && Date.now() - startTime >= durationMs) {
      console.log(`\n==> --duration ${durationMs}ms reached; stopping early.`);
      break;
    }
    await sleep(entry.delayMs);

    logger.decision(entry);
    const outcome = await exec.execute(entry);
    logger.outcome(outcome);

    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
    if (outcome.status === 0) counts.errors++;
    else if (outcome.accepted) counts.accepted++;
    else counts.rejected++;

    // Adaptive console (#36): quiet progress, loud anomalies.
    const anomaly =
      outcome.status >= 500 ||
      outcome.status === 0 ||
      (!outcome.accepted && outcome.action !== 'BID_AUCTION' && !outcome.note);
    if (verbose || anomaly) {
      const tag = anomaly ? 'ANOMALY' : 'event';
      console.log(
        `  [${tag}] #${outcome.seq} ${outcome.action} -> ${outcome.status} ` +
          `${outcome.accepted ? 'ok' : 'reject'}${outcome.note ? ` (${outcome.note})` : ''}`,
      );
    } else {
      process.stdout.write(
        `\r  ${counts.accepted + counts.rejected + counts.errors}/${decisions.length} ` +
          `events, ${counts.rejected} rejected, ${counts.errors} errors   `,
      );
    }

    // Replay-diff (#36): compare against prior recorded outcome.
    const div = diffOutcome(priorOutcomes.get(outcome.seq), outcome);
    if (div) {
      divergences.push(div);
      console.log(
        `\n  [DIVERGENCE] #${div.seq} ${div.action}: was ${div.was.status} -> now ${div.now.status}`,
      );
    }
  }

  manifest.finishedAt = new Date().toISOString();
  logger.manifest(manifest);
  await logger.close();

  // --- Summary -------------------------------------------------------------
  console.log('\n\n=== Run summary ===');
  console.log(`  runId:    ${runId}`);
  console.log(`  output:   ${outDir}`);
  console.log(
    `  accepted: ${counts.accepted}  rejected: ${counts.rejected}  errors: ${counts.errors}`,
  );
  console.log(`  by action: ${JSON.stringify(byAction)}`);
  if (replayFile) {
    console.log(
      `  replay-diff: ${divergences.length} divergence(s)` +
        (divergences.length
          ? ' — SAME DECISIONS, DIFFERENT OUTCOMES (investigate)'
          : ' — outcomes match'),
    );
  }
  console.log('');

  // Exit non-zero if the run surfaced anomalies worth a human's attention.
  process.exit(counts.errors > 0 || divergences.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSimulator failed:', err);
  process.exit(1);
});
