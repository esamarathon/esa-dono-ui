// Read-only post-migration report. Run against an explicit migrated SQLite backup:
// npx tsx server/scripts/pooled-migration-report.ts --database-url file:/absolute/backup.db
// Never loads .env or falls back to DATABASE_URL. No repairs or Stripe calls.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const [flag, url, ...extra] = process.argv.slice(2);
  const file = url?.startsWith('file:') ? url.slice(5) : '';
  if (
    flag !== '--database-url' ||
    extra.length ||
    !path.isAbsolute(file) ||
    file.includes('?') ||
    !existsSync(file)
  ) {
    throw new Error(
      'Usage: pooled-migration-report.ts --database-url file:/absolute/existing-backup.db',
    );
  }
  const db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
  try {
    await db.$executeRawUnsafe('PRAGMA query_only = ON');
    // Prisma's interactive SQLite transaction starts IMMEDIATE (a writer),
    // which query_only rejects. Use a deferred, read-only snapshot on one connection.
    await db.$executeRawUnsafe('BEGIN');
    const report = await (async () => {
      const tx = db;
      const money = await tx.donation.aggregate({
        where: { status: { in: ['COMPLETED', 'REFUNDED'] } },
        _sum: { amount_cents: true },
      });
      const donations = await tx.donation.findMany({
        where: { pledge_amount_cents: null, status: { in: ['REFUNDED', 'CHARGEBACK'] } },
        orderBy: { id: 'asc' },
        include: { reward_claims: true, poll_votes: true, contributions: true },
      });
      const terminal = [];
      for (const d of donations) {
        // Include prior item reversals as well as the donation's terminal adjustment.
        const references = [
          d.id,
          ...d.reward_claims.map((r) => r.id),
          ...d.poll_votes.map((r) => r.id),
          ...d.contributions.map((r) => r.id),
        ];
        const adjustments = await tx.balanceAdjustment.findMany({
          where: { OR: [{ id: d.refund_id ?? '' }, { reference_id: { in: references } }] },
          orderBy: { id: 'asc' },
        });
        terminal.push({
          id: d.id,
          external_id: d.external_id,
          donor_id: d.donor_id,
          status: d.status,
          amount_cents: d.amount_cents,
          live_allocations: {
            claims: d.reward_claims.filter(
              (r) => r.status !== 'REVERSED' && r.reversed_at === null,
            ),
            votes: d.poll_votes.filter((r) => r.reversed_at === null),
            contributions: d.contributions.filter((r) => r.reversed_at === null),
          },
          applied_adjustments: adjustments,
        });
      }
      return {
        counted_money_cents: money._sum.amount_cents ?? 0,
        legacy_terminal_donations: terminal,
      };
    })();
    await db.$executeRawUnsafe('COMMIT');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
