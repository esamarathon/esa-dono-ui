import { PrismaClient } from '@prisma/client';

/**
 * SQLite allows one writer. With Prisma's default connection pool, concurrent
 * interactive transactions on separate connections deadlock: each holds a read
 * lock that blocks the other's commit, until Prisma times out. Measured: 4 of 5
 * concurrent single-write transactions timed out after 10 s. One connection makes
 * Prisma queue transactions in-process instead, so concurrent donations and the
 * transactional webhook outbox (ADR-0007) serialise cleanly.
 *
 * An explicit `connection_limit` in DATABASE_URL is respected.
 */
export function sqliteDatasourceUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith('file:') || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

/**
 * With one connection, concurrent transactions queue. Prisma's default wait to
 * start a transaction (2 s) rejects a burst of ~20 concurrent donations with
 * P2028. Allow a longer queue; each transaction's own run time limit is unchanged.
 */
export const TRANSACTION_MAX_WAIT_MS = 15_000;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const datasourceUrl = sqliteDatasourceUrl(process.env.DATABASE_URL);
const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    transactionOptions: { maxWait: TRANSACTION_MAX_WAIT_MS },
  });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
