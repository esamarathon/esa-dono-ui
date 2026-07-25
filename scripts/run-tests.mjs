#!/usr/bin/env node
// Container entrypoint for distributed testing.
//
// Honors two env vars:
//   TEST_TARGET = server | client | both   (default: both)
//   MODE        = test | lint | build | ci (default: test)
//
// Exit codes: 0 = success, non-zero = failure (suitable for CI/k8s readiness gates).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TARGET = process.env.TEST_TARGET || 'both';
const MODE = process.env.MODE || 'test';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...(opts.env || {}) },
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
    child.on('error', reject);
  });
}

async function runTarget(target) {
  if (MODE === 'test') return run('npm', ['run', 'test', '--workspace', target]);
  if (MODE === 'lint') return run('npm', ['run', 'lint', '--workspace', target]);
  if (MODE === 'build') {
    if (target === 'client') return run('npm', ['run', 'build', '--workspace', 'client']);
    return; // server has no build
  }
  throw new Error(`Unsupported MODE=${MODE} for TARGET=${target}`);
}

async function main() {
  console.log(`[container] TEST_TARGET=${TARGET} MODE=${MODE}`);

  if (MODE === 'ci') {
    await run('npm', ['run', 'lint']);
    await run('npm', ['run', 'typecheck']);
    if (TARGET === 'both' || TARGET === 'server')
      await run('npm', ['run', 'test', '--workspace', 'server']);
    if (TARGET === 'both' || TARGET === 'client')
      await run('npm', ['run', 'test', '--workspace', 'client']);
    if (TARGET === 'both') await run('npm', ['run', 'build']);
    console.log('[container] CI complete');
    return;
  }

  const targets = TARGET === 'both' ? ['server', 'client'] : [TARGET];
  for (const t of targets) {
    await runTarget(t);
  }
  console.log(`[container] ${MODE} ${TARGET} complete`);
}

main().catch((err) => {
  console.error('[container] FAILED:', err.message);
  process.exit(1);
});
