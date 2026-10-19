import type { PrismaClient } from '@prisma/client';
import { databaseProvider } from '../../lib/database.js';

type FailTrigger = {
  name: string;
  table: string;
  operation: 'INSERT' | 'UPDATE';
  // Trusted test SQL, with quoted identifiers so the predicate works on both providers.
  when?: string;
  message: string;
};

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Inject a real row-write failure, including predicates that fail only on a late row. */
export async function createFailTrigger(prisma: PrismaClient, trigger: FailTrigger) {
  const { name, table, operation, when, message } = trigger;
  if (databaseProvider(process.env.DATABASE_URL) === 'sqlite') {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${identifier(name)} BEFORE ${operation}
      ON ${identifier(table)} ${when ? `WHEN ${when}` : ''}
      BEGIN SELECT RAISE(ABORT, ${literal(message)}); END`);
    return;
  }
  const fn = identifier(`test_${name}`);
  // Match SQLite trigger failures' P2003 classification. Keep the predicate inside
  // the function: PostgreSQL trigger WHEN clauses cannot contain subqueries.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $failure$
    BEGIN
      ${when ? `IF ${when} THEN` : ''}
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = ${literal(message)};
      ${when ? 'END IF;' : ''}
      RETURN NEW;
    END;
    $failure$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${identifier(name)} BEFORE ${operation}
    ON ${identifier(table)} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
}

export async function dropFailTrigger(prisma: PrismaClient, name: string) {
  if (databaseProvider(process.env.DATABASE_URL) === 'sqlite') {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${identifier(name)}`);
  } else {
    // The trigger depends on this test-only function, so CASCADE removes both even
    // when a parameterized test installed the trigger on a different table.
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${identifier(`test_${name}`)}() CASCADE`,
    );
  }
}
