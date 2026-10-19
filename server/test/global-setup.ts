// Give every run its own migrated database. Ignore ambient DATABASE_URL: it may
// belong to a developer or a running server. PostgreSQL is opt-in through
// TEST_DATABASE_URL and gets a new schema; SQLite always gets a temporary file.
//
// Vitest copies process.env to workers after globalSetup. Do not override
// DATABASE_URL in test.env. Also provide the URL so workers can check isolation.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { databaseProvider } from '../lib/database.js';
import { createDatabaseClient } from '../lib/databaseClient.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// /dev/shm is tmpfs on Linux. Elsewhere fall back to the OS temp directory.
function tempRoot(): string {
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    return '/dev/shm';
  } catch {
    return os.tmpdir();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const target = process.env.TEST_DATABASE_URL;
  let url: string;
  let cleanup: () => Promise<void>;
  if (databaseProvider(target) === 'postgresql') {
    // Only interpolate our own identifier, never a supplied schema name. No
    // existing schema is reset, truncated or dropped, even on setup failure.
    const schema = `dono_test_${randomUUID().replace(/-/g, '')}`;
    const scoped = new URL(target!);
    scoped.searchParams.set('schema', schema);
    url = scoped.toString();
    const admin = createDatabaseClient(target);
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.$disconnect();
    }
    cleanup = async () => {
      const admin = createDatabaseClient(target);
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.$disconnect();
      }
    };
  } else {
    const dir = fs.mkdtempSync(path.join(tempRoot(), 'dono-test-db-'));
    url = `file:${path.join(dir, 'test.db')}`;
    cleanup = async () => fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env.DATABASE_URL = url;

  try {
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    execFileSync(process.execPath, [tsxCli, 'scripts/database.ts', 'migrate'], {
      cwd: serverDir,
      env: process.env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (databaseProvider(url) === 'postgresql') {
      // SQLite's historical migrations inserted this fixture. The PostgreSQL
      // baseline is schema-only; keep fixture business data in test setup.
      const prisma = createDatabaseClient(url);
      try {
        await prisma.event.create({
          data: {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Default Event',
            slug: 'default-event',
          },
        });
      } finally {
        await prisma.$disconnect();
      }
    }
    project.provide('testDatabaseUrl', url);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return cleanup;
}
