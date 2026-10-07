import { PrismaClient } from '@prisma/client';

process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '1025';
process.env.EMAIL_FROM = 'test@example.com';
// High ceiling so the feedback route's IP-keyed rate limiter doesn't trip
// across the many requests a single test file issues from the same IP.
process.env.RATE_LIMIT_FEEDBACK = '1000';
process.env.RATE_LIMIT_API = '100000';

// The test DB is a file on disk. In SQLite's default rollback-journal mode
// every commit makes several fsyncs and creates and deletes a journal file;
// on a slow disk one commit took up to 35 s, so DB-backed tests timed out at
// random. Readers also block writers, so a second PrismaClient waits on the
// lock and fails with P1008. WAL mode makes one fsync per commit and lets
// readers run during a write. The mode is stored in the DB file.
const prisma = new PrismaClient();
await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
await prisma.$disconnect();
