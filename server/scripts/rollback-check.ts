import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';

type Reader = PrismaClient | Prisma.TransactionClient;
export interface Checkpoint {
  backup_at: string;
  captured_at: string;
  schema_digest: string;
  tables: { name: string; count: number; digest: string; dated_after_backup: number }[];
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** Caller supplies a read snapshot / query_only connection. Includes timestamp-less joins and deletes. */
export async function captureCheckpoint(db: Reader, backupAt: Date): Promise<Checkpoint> {
  if (!Number.isFinite(backupAt.getTime()) || backupAt > new Date())
    throw Error('Invalid backup timestamp');
  const schema = await db.$queryRawUnsafe(
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
  );
  const schemaDigest = createHash('sha256').update(encode(schema)).digest('hex');
  const tables = await db.$queryRawUnsafe<{ name: string; sql: string }[]>(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const result: Checkpoint['tables'] = [];
  for (const table of tables) {
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${quote(table.name)}`,
    );
    const serialized = rows.map((row) => encode(row)).sort();
    const dated = rows.filter((row) =>
      Object.entries(row).some(([key, value]) => {
        if (!key.endsWith('_at') || value === null) return false;
        const date =
          value instanceof Date
            ? value
            : new Date(typeof value === 'bigint' || typeof value === 'number' ? Number(value) : String(value));
        return Number.isFinite(date.getTime()) && date > backupAt;
      }),
    ).length;
    result.push({
      name: table.name,
      count: rows.length,
      digest: createHash('sha256').update(table.sql).update(encode(serialized)).digest('hex'),
      dated_after_backup: dated,
    });
  }
  return {
    backup_at: backupAt.toISOString(),
    captured_at: new Date().toISOString(),
    schema_digest: schemaDigest,
    tables: result,
  };
}

export async function checkRollback(
  db: Reader,
  checkpoint: Checkpoint,
  freezeAck: boolean,
  migrationReviewAck: boolean,
) {
  if (
    !Array.isArray(checkpoint.tables) ||
    !checkpoint.tables.length ||
    !Number.isFinite(Date.parse(checkpoint.captured_at)) ||
    Date.parse(checkpoint.captured_at) < Date.parse(checkpoint.backup_at)
  )
    throw Error('Invalid checkpoint');
  const current = await captureCheckpoint(db, new Date(checkpoint.backup_at));
  const unchanged =
    current.schema_digest === checkpoint.schema_digest &&
    encode(current.tables) === encode(checkpoint.tables);
  return {
    decision: freezeAck && migrationReviewAck && unchanged ? 'SAFE_TO_RESTORE' : 'FIX_FORWARD',
    unchanged,
    freeze_ack: freezeAck,
    migration_review_ack: migrationReviewAck,
    reason:
      'Requires continuous enforced freeze from backup through check, manual migration-only delta review, and identical full final-schema data. Counts alone never prove safety.',
    current,
  };
}
