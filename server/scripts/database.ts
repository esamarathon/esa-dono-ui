import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseProvider } from '../lib/database.js';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sqliteSchema = resolve(serverDir, 'prisma/schema.prisma');
const postgresSchema = resolve(serverDir, 'prisma/postgresql/schema.prisma');
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

function prisma(args: string[], url = process.env.DATABASE_URL) {
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: serverDir,
    env: { ...process.env, ...(url ? { DATABASE_URL: url } : {}) },
    stdio: 'inherit',
  });
}

const command = process.argv[2];
if (command === 'generate') {
  // One source of model definitions. Ship both clients and schemas in the image.
  const postgres = readFileSync(sqliteSchema, 'utf8')
    .replace(
      'provider = "prisma-client-js"',
      'provider = "prisma-client-js"\n  output = "../../generated/postgresql"',
    )
    .replace('provider = "sqlite"', 'provider = "postgresql"');
  mkdirSync(dirname(postgresSchema), { recursive: true });
  writeFileSync(postgresSchema, postgres);
  prisma(['generate', '--schema', sqliteSchema], 'file:./dev.db');
  prisma(['generate', '--schema', postgresSchema], 'postgresql://localhost/dono');
} else if (command === 'migrate') {
  const provider = databaseProvider(process.env.DATABASE_URL);
  console.log(`[database] Applying ${provider} migrations`);
  prisma(['migrate', 'deploy', '--schema', provider === 'sqlite' ? sqliteSchema : postgresSchema]);
} else {
  throw new Error('Usage: tsx scripts/database.ts generate|migrate');
}
