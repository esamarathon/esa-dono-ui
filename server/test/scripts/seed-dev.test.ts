import { afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import adminRouter from '../../routes/admin.js';
import pledgeRouter from '../../routes/pledge.js';
import rewardsRouter from '../../routes/rewards.js';
import pollsRouter from '../../routes/polls.js';
import goalsRouter from '../../routes/goals.js';
import eventsRouter from '../../routes/events.js';
import { createTestChannel, DEFAULT_EVENT_ID } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));
const exec = promisify(execFile);
afterAll(() => prisma.$disconnect());

it('the demo bootstrap creates an active public Event with both Channels before seeding incentives', async () => {
  const original = await prisma.event.findUnique({ where: { slug: 'default-event' } });
  const other = await prisma.event.create({
    data: { name: 'Another Event', slug: `another-${crypto.randomUUID()}` },
  });
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/admin', adminRouter);
  app.use('/api/events', eventsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  try {
    const source = await readFile(new URL('../../../seed-dev.sh', import.meta.url), 'utf8');
    const shell =
      source.slice(0, source.indexOf('# --- Test images ---')) +
      source.slice(source.indexOf('# --- Channels ---'), source.indexOf('# --- Rewards ---'));
    await exec('bash', ['-c', shell, 'seed-dev.sh', `http://127.0.0.1:${address.port}`], {
      env: { ...process.env, ADMIN_API_KEY: 'test-admin-key' },
    });
    const response = await request(app).get('/api/events');
    expect(response.status).toBe(200);
    const event = await prisma.event.findUniqueOrThrow({ where: { slug: 'default-event' } });
    const channels = await prisma.channel.findMany({
      where: { slug: { in: ['main-marathon', 'bonus-stream'] } },
    });
    expect(channels).toHaveLength(2);
    expect(channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000101',
          slug: 'main-marathon',
          event_id: event.id,
          is_active: true,
        }),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000102',
          slug: 'bonus-stream',
          event_id: event.id,
          is_active: true,
        }),
      ]),
    );
    const main = channels.find((channel) => channel.slug === 'main-marathon')!;
    expect(event).toMatchObject({ is_active: true, primary_channel_id: main.id });
    expect(response.body).toContainEqual(
      expect.objectContaining({
        id: event.id,
        primary_channel_id: main.id,
        channels: expect.arrayContaining([
          expect.objectContaining({ slug: 'main-marathon' }),
          expect.objectContaining({ slug: 'bonus-stream' }),
        ]),
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await prisma.event.updateMany({
      where: { slug: 'default-event' },
      data: {
        is_active: original?.is_active ?? false,
        primary_channel_id: original?.primary_channel_id ?? null,
      },
    });
    await prisma.channel.deleteMany({ where: { slug: { in: ['main-marathon', 'bonus-stream'] } } });
    await prisma.event.delete({ where: { id: other.id } });
    if (!original) await prisma.event.deleteMany({ where: { slug: 'default-event' } });
  }
});

it.each([503, 200])(
  'the demo bootstrap fails on an unusable Channel response (HTTP %i)',
  async (status) => {
    const app = express();
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/admin/events', (_req, res) =>
      res.json([{ slug: 'default-event', id: 'demo-event' }]),
    );
    app.post('/api/admin/channels', (_req, res) =>
      res.status(status).json({ error: 'Channel unavailable' }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    try {
      const source = await readFile(new URL('../../../seed-dev.sh', import.meta.url), 'utf8');
      const shell =
        source.slice(0, source.indexOf('# --- Test images ---')) +
        source.slice(source.indexOf('# --- Channels ---'), source.indexOf('# --- Rewards ---'));
      await expect(
        exec('bash', ['-c', shell, 'seed-dev.sh', `http://127.0.0.1:${address.port}`], {
          env: { ...process.env, ADMIN_API_KEY: 'test-admin-key' },
        }),
      ).rejects.toMatchObject({
        code: expect.any(Number),
        stdout: expect.not.stringContaining('   Channels:'),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it('the exact demo claim/vote/contribution/summary shell completes with a cash-funded physical pledge, never a Wallet bypass', async () => {
  const main = await createTestChannel(prisma);
  const bonus = await createTestChannel(prisma);
  const donors = await Promise.all(
    [
      { email: 'alice@example.com', balance_remaining: 13000 },
      { email: 'bob@example.com', balance_remaining: 6000 },
      { email: 'carol@example.com', balance_remaining: 3500 },
      { email: 'dave@example.com', balance_remaining: 20000 },
      { email: 'eve@example.com', balance_remaining: 7500 },
    ].map((data) =>
      prisma.donor.create({
        data: {
          ...data,
          magic_token: crypto.randomUUID(),
          token_expires_at: new Date(Date.now() + 3600000),
        },
      }),
    ),
  );
  const rewards = await Promise.all(
    [
      { title: 'Digital Thank-You Card', type: 'DIGITAL', cost_cents: 500 },
      { title: 'Exclusive Discord Role', type: 'DIGITAL', cost_cents: 1000 },
      {
        title: 'ESA T-Shirt',
        type: 'PHYSICAL',
        cost_cents: 2500,
        quantity_total: 500,
        channel_id: main.id,
      },
      { title: 'Pick the Next Game', type: 'CUSTOM', cost_cents: 5000 },
    ].map((data) => prisma.reward.create({ data: { ...data, event_id: main.event_id } })),
  );
  const polls = await Promise.all(
    [
      { title: 'Finale', channel_id: main.id },
      { title: 'Bonus', channel_id: bonus.id },
      { title: 'Shared' },
    ].map((poll) =>
      prisma.poll.create({
        data: {
          ...poll,
          event_id: DEFAULT_EVENT_ID,
          allow_custom_entries: true,
          options: { create: ['A', 'B', 'C', 'D'].map((label) => ({ label })) },
        },
        include: { options: true },
      }),
    ),
  );
  const goals = await Promise.all(
    [
      { title: 'Bonus couch', target_cents: 100000, channel_id: bonus.id },
      { title: 'Pizza', target_cents: 250000 },
      { title: 'Milestone', target_cents: 500000 },
    ].map((data) => prisma.fundGoal.create({ data: { ...data, event_id: main.event_id } })),
  );
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/pledge', pledgeRouter);
  app.use('/api/rewards', rewardsRouter);
  app.use('/api/polls', pollsRouter);
  app.use('/api/goals', goalsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const imageDir = await mkdtemp(join(tmpdir(), 'seed-physical-'));
  try {
    const bypass = await request(app)
      .post(`/api/rewards/${rewards[2]!.id}/claim`)
      .set('Authorization', `Bearer ${donors[3]!.magic_token}`)
      .send({ channel_id: main.id, claim_data: { name: 'Dave Smith' } });
    expect(bypass.status).toBe(400);
    expect(bypass.body.error).toMatch(/Physical rewards require a cash-funded pledge/);
    expect(await prisma.rewardClaim.count({ where: { reward_id: rewards[2]!.id } })).toBe(0);
    expect(await prisma.donor.findUniqueOrThrow({ where: { id: donors[3]!.id } })).toMatchObject({
      balance_remaining: 20000,
    });
    const source = await readFile(new URL('../../../seed-dev.sh', import.meta.url), 'utf8');
    const shell = `${source.split('\n').find((line) => line.startsWith('mask()'))}\n${source.slice(source.indexOf('# --- Reward claims ---'))}`;
    const result = await exec('bash', ['-ec', shell], {
      env: {
        ...process.env,
        BASE: `http://127.0.0.1:${address.port}`,
        CLIENT: 'http://127.0.0.1:1',
        AUTH: 'Authorization: Bearer key_admin_test-admin-key',
        KEY: 'test-admin-key',
        IMG_DIR: imageDir,
        C_MAIN: main.id,
        C_BONUS: bonus.id,
        ALICE: donors[0]!.magic_token!,
        BOB: donors[1]!.magic_token!,
        CAROL: donors[2]!.magic_token!,
        DAVE: donors[3]!.magic_token!,
        EVE: donors[4]!.magic_token!,
        R_THANKS: rewards[0]!.id,
        R_DISC: rewards[1]!.id,
        R_SHIRT: rewards[2]!.id,
        R_GAME: rewards[3]!.id,
        P1: polls[0]!.id,
        P2: polls[1]!.id,
        P3: polls[2]!.id,
        OPT_CELESTE: polls[0]!.options[0]!.id,
        OPT_HOLLOW: polls[0]!.options[1]!.id,
        OPT_HADES: polls[0]!.options[2]!.id,
        OPT_DISCO: polls[0]!.options[3]!.id,
        OPT_BLIND: polls[1]!.options[0]!.id,
        OPT_DEV: polls[1]!.options[1]!.id,
        OPT_RACE: polls[1]!.options[2]!.id,
        OPT_NODEATH: polls[2]!.options[0]!.id,
        G1: goals[0]!.id,
        G2: goals[1]!.id,
        G3: goals[2]!.id,
      },
    });
    expect(result.stdout).toContain('5 claims created.');
    expect(result.stdout).toContain('6 contributions made.');
    expect(result.stdout).toContain('==> Done. Summary:');
    expect(result.stdout).toContain('Admin panel:');
    const claim = await prisma.rewardClaim.findFirstOrThrow({
      where: { reward_id: rewards[2]!.id },
      include: { donation: { include: { pledge: true } } },
    });
    expect(claim).toMatchObject({
      amount_cents: 2500,
      donation: {
        amount_cents: 2500,
        pledge_amount_cents: 2500,
        wallet_applied_cents: 0,
        wallet_credit_granted_cents: 0,
        pledge: { status: 'FULFILLED', requires_shipping: true },
      },
    });
    expect(
      await prisma.rewardClaim.count({ where: { donor_id: { in: donors.map((d) => d.id) } } }),
    ).toBe(5);
    expect(await prisma.donor.findUniqueOrThrow({ where: { id: donors[3]!.id } })).toMatchObject({
      balance_remaining: 3000,
    });
    expect(await prisma.fundGoal.findUniqueOrThrow({ where: { id: goals[1]!.id } })).toMatchObject({
      current_cents: 5500,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(imageDir, { recursive: true, force: true });
    const donorIds = donors.map((d) => d.id);
    await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pollOption.deleteMany({ where: { custom_entry: { donor_id: { in: donorIds } } } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pendingPledge.deleteMany({ where: { channel_id: main.id } });
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.reward.deleteMany({ where: { id: { in: rewards.map((r) => r.id) } } });
    await prisma.poll.deleteMany({ where: { id: { in: polls.map((p) => p.id) } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: goals.map((g) => g.id) } } });
    await prisma.channel.deleteMany({ where: { id: { in: [main.id, bonus.id] } } });
  }
});
