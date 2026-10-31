// No dotenv import. Every database, adapter and report path must be explicit.
import { existsSync, readFileSync, openSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { captureCheckpoint, checkRollback, type Checkpoint } from './rollback-check.js';
import {
  correctShipping,
  drainCheckouts,
  financialReport,
  publishCorrections,
  type CheckoutAdapter,
  type CheckoutFacts,
  type Correction,
} from './transition.js';

const usage = `Usage: tsx server/scripts/transition-cli.ts <report|drain|shipping|publish|checkpoint|rollback>
  --database-url file:/absolute/existing.db --report /absolute/NEW-report.json
  drain|shipping: --before ISO-UTC --limit 1..1000 [--after ID]
    (--stripe-fixture /absolute/sessions.json | --stripe-key-file /absolute/key) [--apply]
  publish: [--corrections /absolute/APPLIED-shipping-report.json (repeatable)]
    [--wallet-baseline /absolute/PRE-migration-financial-report.json]
    [--apply --overlay-binding-ack]
  checkpoint: --backup-at ISO-UTC (immediately after migrations, BEFORE starting writers)
  rollback: --checkpoint /absolute/checkpoint.json [--freeze-ack --migration-review-ack]
Dry-run is default. Drain NEVER modifies SQLite. Shipping NEVER publishes. Publication queues
only; the backend dispatches later. A binding acknowledgement permits replaying old alerts.
Rollback never restores anything: missing proof means FIX_FORWARD. No default DB, Stripe key or .env.
Reports contain financial ids/hashes, not secrets; store them privately. --help needs no inputs.`;

function absolute(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) throw Error('An absolute path is required');
  return value;
}
async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'database-url': { type: 'string' },
      report: { type: 'string' },
      before: { type: 'string' },
      limit: { type: 'string' },
      after: { type: 'string' },
      apply: { type: 'boolean' },
      'stripe-fixture': { type: 'string' },
      'stripe-key-file': { type: 'string' },
      corrections: { type: 'string', multiple: true },
      'wallet-baseline': { type: 'string' },
      'overlay-binding-ack': { type: 'boolean' },
      'backup-at': { type: 'string' },
      checkpoint: { type: 'string' },
      'freeze-ack': { type: 'boolean' },
      'migration-review-ack': { type: 'boolean' },
    },
  });
  if (v.help) {
    console.log(usage);
    return;
  }
  const op = positionals[0];
  if (
    positionals.length !== 1 ||
    !['report', 'drain', 'shipping', 'publish', 'checkpoint', 'rollback'].includes(op ?? '')
  )
    throw Error(usage);
  const url = v['database-url'];
  const file = url?.startsWith('file:') ? url.slice(5) : undefined;
  if (!file || !path.isAbsolute(file) || file.includes('?') || !existsSync(file))
    throw Error('Explicit existing absolute SQLite database URL required');
  if (v.apply && !['drain', 'shipping', 'publish'].includes(op!))
    throw Error('--apply is not valid for this read-only operation');
  const fd = openSync(absolute(v.report), 'wx', 0o600);
  const db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
  try {
    let result: unknown;
    if (op === 'drain' || op === 'shipping') {
      if (!v.before || !/Z$/.test(v.before) || !v.limit)
        throw Error('--before UTC and --limit required');
      if (!!v['stripe-fixture'] === !!v['stripe-key-file'])
        throw Error('Exactly one explicit Stripe adapter input is required');
      let adapter: CheckoutAdapter;
      if (v['stripe-fixture']) {
        const sessions = JSON.parse(readFileSync(absolute(v['stripe-fixture']), 'utf8')) as Record<
          string,
          CheckoutFacts
        >;
        adapter = {
          retrieve: async (id) => {
            if (!sessions[id]) throw Error('Unknown fixture');
            return sessions[id];
          },
          expire: async (id) => {
            const f = sessions[id];
            if (!f || f.status !== 'open') throw Error('Not open');
            return (sessions[id] = { ...f, status: 'expired' });
          },
        };
      } else {
        const stripe = new Stripe(readFileSync(absolute(v['stripe-key-file']), 'utf8').trim(), {
          maxNetworkRetries: 0,
          timeout: 10000,
        });
        adapter = {
          retrieve: (id) => stripe.checkout.sessions.retrieve(id),
          expire: (id) => stripe.checkout.sessions.expire(id),
        };
      }
      const bound = {
        before: new Date(v.before),
        limit: Number(v.limit),
        after: v.after,
        apply: !!v.apply,
      };
      result =
        op === 'drain'
          ? await drainCheckouts(db, adapter, bound)
          : await correctShipping(db, adapter, bound);
    } else if (op === 'publish') {
      const corrections: Correction[] = [];
      for (const filename of v.corrections ?? []) {
        const report = JSON.parse(readFileSync(absolute(filename), 'utf8')) as {
          operation: string;
          apply: boolean;
          corrected: Correction[];
        };
        if (
          report.operation !== 'shipping' ||
          report.apply !== true ||
          !Array.isArray(report.corrected)
        )
          throw Error('Applied shipping report required');
        corrections.push(...report.corrected);
      }
      if (v['wallet-baseline']) {
        const baseline = JSON.parse(
          readFileSync(absolute(v['wallet-baseline']), 'utf8'),
        ) as Awaited<ReturnType<typeof financialReport>>;
        for (const d of baseline.wallet)
          if (d.amount_cents > 0)
            corrections.push({
              id: d.id,
              external_id: d.external_id,
              before_cents: d.amount_cents,
              after_cents: 0,
              shipping_cents: null,
              shipping_recorded_at: null,
              kind: 'wallet',
            });
      }
      result = await publishCorrections(db, corrections, !!v.apply, !!v['overlay-binding-ack']);
    } else {
      await db.$executeRawUnsafe('PRAGMA query_only = ON');
      await db.$executeRawUnsafe('BEGIN');
      if (op === 'report') result = await financialReport(db);
      else if (op === 'checkpoint') {
        if (!v['backup-at']?.endsWith('Z')) throw Error('--backup-at UTC required');
        result = await captureCheckpoint(db, new Date(v['backup-at']));
      } else
        result = await checkRollback(
          db,
          JSON.parse(readFileSync(absolute(v.checkpoint), 'utf8')) as Checkpoint,
          !!v['freeze-ack'],
          !!v['migration-review-ack'],
        );
      await db.$executeRawUnsafe('COMMIT');
    }
    writeFileSync(fd, JSON.stringify(result, null, 2) + '\n');
    console.log(
      `Wrote ${op} report (apply=${!!v.apply}). Review unresolved rows and pagination before proceeding.`,
    );
  } finally {
    closeSync(fd);
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Transition tool failed. Check explicit inputs and private report; no provider errors or credentials are printed. Use --help.',
  );
  process.exitCode = 1;
});
