import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});

const exec = promisify(execFile);
const prisma = createDatabaseClient();
const serverDir = fileURLToPath(new URL('../../', import.meta.url));
let uploadsDir: string;
let donorId: string;
let goalId: string;
let pollId: string;
let optionId: string;

// Run the actual entry point under Node's fatal unhandled-rejection policy.
// Override only the listen address: the OS chooses an unused loopback port.
async function runDelete(path: string) {
  return exec(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import express from 'express';
        const listen = express.application.listen;
        let server;
        const ready = new Promise(resolve => {
          express.application.listen = function (_port, callback) {
            server = listen.call(this, 0, '127.0.0.1', callback);
            server.on('listening', resolve);
            return server;
          };
        });
        await import('./index.ts');
        await ready;
        const base = 'http://127.0.0.1:' + server.address().port;
        const response = await fetch(base + process.env.TEST_DELETE_PATH, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer key_admin_test-admin-key' },
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.json();
        const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) });
        console.log('RESULT ' + JSON.stringify({ status: response.status, body, health: health.status }));
        process.exit(0);
      `,
    ],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        UPLOADS_DIR: uploadsDir,
        OTEL_TRACES_ENABLED: 'false',
        TEST_DELETE_PATH: path,
      },
      timeout: 15_000,
    },
  );
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'dono-async-errors-'));
  const donor = await prisma.donor.create({ data: { email: `async-${randomUUID()}@example.com` } });
  donorId = donor.id;
  const goal = await prisma.fundGoal.create({
    data: { event_id: DEFAULT_EVENT_ID, title: 'Funded goal', target_cents: 500 },
  });
  goalId = goal.id;
  await prisma.fundContribution.create({
    data: { donor_id: donorId, goal_id: goalId, amount_cents: 500 },
  });
  const poll = await prisma.poll.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      title: 'Voted poll',
      options: { create: { label: 'Voted option' } },
    },
    include: { options: true },
  });
  pollId = poll.id;
  optionId = poll.options[0]!.id;
  await prisma.pollVote.create({
    data: { donor_id: donorId, poll_id: pollId, poll_option_id: optionId, amount_cents: 300 },
  });
});

afterAll(async () => {
  await prisma.fundContribution.deleteMany({ where: { donor_id: donorId } });
  await prisma.fundGoal.deleteMany({ where: { id: goalId } });
  await prisma.pollVote.deleteMany({ where: { donor_id: donorId } });
  await prisma.poll.deleteMany({ where: { id: pollId } });
  await prisma.donor.deleteMany({ where: { id: donorId } });
  await prisma.$disconnect();
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('async route errors keep the backend running (#175)', () => {
  it.each([
    { label: 'moderator funded goal', path: '/api/moderator/goals/', id: () => goalId },
    {
      label: 'moderator voted poll option',
      path: '/api/moderator/polls/options/',
      id: () => optionId,
    },
    { label: 'moderator voted poll', path: '/api/moderator/polls/', id: () => pollId },
    { label: 'admin voted poll', path: '/api/admin/polls/', id: () => pollId },
  ])(
    'returns the history conflict for a $label delete and serves a following request',
    async ({ path, id }) => {
      const { stdout, stderr } = await runDelete(path + id());
      const result = JSON.parse(stdout.split('RESULT ')[1]!);
      expect(result).toEqual({
        status: 409,
        body: { error: 'This has allocation history. Deactivate it instead.' },
        health: 200,
      });
      expect(stderr).not.toContain('P2003');
    },
  );

  it('still deletes a goal with no contributions', async () => {
    const goal = await prisma.fundGoal.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Empty goal', target_cents: 500 },
    });
    try {
      const { stdout } = await runDelete(`/api/moderator/goals/${goal.id}`);
      expect(JSON.parse(stdout.split('RESULT ')[1]!)).toEqual({
        status: 200,
        body: { success: true },
        health: 200,
      });
    } finally {
      await prisma.fundGoal.deleteMany({ where: { id: goal.id } });
    }
  });
});
