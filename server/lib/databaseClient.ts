import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PrismaClient as PostgreSQLClient,
  Prisma as PostgreSQL,
} from '../generated/postgresql/index.js';
import { databaseProvider, type DatabaseProvider } from './database.js';

export const TRANSACTION_MAX_WAIT_MS = 15_000;

/** SQLite's single connection queues transactions instead of deadlocking writers. */
export function sqliteDatasourceUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith('file:') || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

/**
 * Preserve the existing serialized transaction model on both providers. PostgreSQL
 * uses one transaction-scoped advisory lock across connections, acquired BEFORE
 * application reads. READ COMMITTED then observes the preceding writer's commit.
 * This deliberately does not promise parallel financial writes or worker replicas.
 */
function transactionLock(
  client: PrismaClient | Prisma.TransactionClient,
  provider: DatabaseProvider,
) {
  return provider === 'postgresql'
    ? client.$queryRaw`SELECT pg_advisory_xact_lock(1163084100, 1)::text`
    : client.$executeRaw`UPDATE "Donor" SET "id" = "id" WHERE FALSE`;
}

export function createDatabaseClient(url = process.env.DATABASE_URL): PrismaClient {
  const provider = databaseProvider(url);
  const datasourceUrl = sqliteDatasourceUrl(url);
  const options = {
    ...(datasourceUrl ? { datasourceUrl } : {}),
    transactionOptions: { maxWait: TRANSACTION_MAX_WAIT_MS },
  };
  // Both clients are generated from the same models. Keep one domain type contract;
  // the connector-specific transaction isolation enums differ between generators.
  const client =
    provider === 'sqlite'
      ? new PrismaClient(options)
      : (new PostgreSQLClient({
          ...options,
          transactionOptions: {
            ...options.transactionOptions,
            isolationLevel: PostgreSQL.TransactionIsolationLevel.ReadCommitted,
          },
        }) as unknown as PrismaClient);
  const transaction = client.$transaction.bind(client);
  type Options = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  };
  const serialized = (
    input: ((tx: Prisma.TransactionClient) => Promise<unknown>) | Prisma.PrismaPromise<unknown>[],
    options?: Options,
  ) => {
    if (typeof input === 'function') {
      return transaction(async (tx) => {
        await transactionLock(tx, provider);
        return input(tx);
      }, options);
    }
    return transaction([transactionLock(client, provider), ...input], options).then((results) =>
      results.slice(1),
    );
  };
  client.$transaction = serialized as PrismaClient['$transaction'];
  return client;
}
