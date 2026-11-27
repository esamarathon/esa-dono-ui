import type { PrismaClient } from '@prisma/client';
import { createDatabaseClient } from './databaseClient.js';

export { sqliteDatasourceUrl, TRANSACTION_MAX_WAIT_MS } from './databaseClient.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? createDatabaseClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
