// Gives each vitest run its own fresh, migrated SQLite database in a
// memory-backed temp directory, and removes it after the run.
//
// Why: the tests used to share server/prisma/dev.db (also the local dev
// server's database). On a slow disk one commit could stall for 15–35 s and
// time out DB-backed tests at random, and test rows leaked between runs.
//
// How the URL reaches the tests: globalSetup runs in the main vitest process
// before the pool starts. Vitest builds each worker's env from `process.env`
// at that point (then overlays `test.env`), so setting `process.env` here is
// enough. `test.env` in vitest.config.ts must therefore not set DATABASE_URL.
// The URL is also `provide`d so a test can assert the worker got it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// /dev/shm is tmpfs on Linux. Elsewhere (macOS, some CI) fall back to the OS
// temp dir.
function tempRoot(): string {
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    return '/dev/shm';
  } catch {
    return os.tmpdir();
  }
}

export default function setup(project: TestProject): () => void {
  const dir = fs.mkdtempSync(path.join(tempRoot(), 'dono-test-db-'));
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true });
  const url = `file:${path.join(dir, 'test.db')}`;
  process.env.DATABASE_URL = url;

  try {
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { cwd: serverDir, env: process.env, stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } catch (err) {
    removeDir();
    throw err;
  }

  project.provide('testDatabaseUrl', url);
  return removeDir;
}
