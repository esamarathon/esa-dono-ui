import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { planPledge } from '@dono/shared';
import pledgeRouter from '../../routes/pledge.js';
import { createTestChannel } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));
const donors: string[] = [];
const channels: string[] = [];
const drafts: string[] = [];
const legacy: string[] = [];
function app() {
  const app = express();
  app.use(express.json());
  app.use('/api/pledge', pledgeRouter);
  return app;
}
afterEach(async () => {
  await prisma.pendingPledge.deleteMany({
    where: { OR: [{ draft_id: { in: drafts } }, { id: { in: legacy } }] },
  });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  donors.length = channels.length = drafts.length = legacy.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('pledge HTTP contract on SQLite', () => {
  it.each([{ items: [] }, { pledge_amount_cents: 1000, top_up_cents: 0, items: [] }])(
    'rejects the obsolete donate contract',
    async (body) => {
      const res = await request(app()).post('/api/pledge').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('The donate page was updated. Reload to continue.');
    },
  );

  it('resolves authentication before planning, reports corrections without hold, then returns confirmed funding on retry', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: {
        email: `${crypto.randomUUID()}@example.com`,
        balance_remaining: 975,
        magic_token: crypto.randomUUID(),
        token_expires_at: new Date(Date.now() + 60000),
      },
    });
    donors.push(donor.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const input = {
      draft_id,
      pledge_amount_cents: 1000,
      items: [],
      channel_id: channel.id,
      display_name: ' Reader ',
      comment: ' Hello ',
      plan: planPledge({ pledge_amount_cents: 1000, available_wallet_cents: null, selections: [] }),
    };
    const changed = await request(app())
      .post('/api/pledge')
      .set('Authorization', `Bearer ${donor.magic_token}`)
      .send(input);
    expect(changed.status).toBe(409);
    expect(changed.body.plan).toMatchObject({ wallet_applied_cents: 950, new_money_cents: 50 });
    expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(0);
    const res = await request(app())
      .post('/api/pledge')
      .set('Authorization', `Bearer ${donor.magic_token}`)
      .send({ ...input, plan: changed.body.plan });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      format: 'POOLED',
      pledge_amount_cents: 1000,
      wallet_applied_cents: 950,
      new_money_cents: 50,
      has_checkout: false,
    });
    expect(res.body).not.toHaveProperty('total_cents');
    expect(res.body).not.toHaveProperty('top_up_cents');
    expect(res.body).not.toHaveProperty('wallet_discount_cents');
    const retry = await request(app())
      .post('/api/pledge')
      .set('Authorization', `Bearer ${donor.magic_token}`)
      .send(input);
    expect(retry.body).toEqual(res.body);
    const read = await request(app()).get(`/api/pledge/${res.body.pledge_token}`);
    expect(read.body.plan).toEqual(changed.body.plan);
    expect(JSON.stringify(read.body)).not.toContain(donor.magic_token!);
    expect(JSON.stringify(read.body)).not.toContain(donor.email);
  });

  it.each(['email-only', 'expired', 'frozen', 'invalid'] as const)(
    'never uses %s as authority to hold credit',
    async (auth) => {
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const donor = await prisma.donor.create({
        data: {
          email: `${crypto.randomUUID()}@example.com`,
          balance_remaining: 1000,
          magic_token: crypto.randomUUID(),
          token_expires_at: new Date(auth === 'expired' ? 0 : Date.now() + 60000),
          is_frozen: auth === 'frozen',
        },
      });
      donors.push(donor.id);
      const draft_id = crypto.randomUUID();
      drafts.push(draft_id);
      let req = request(app()).post('/api/pledge');
      if (auth !== 'email-only')
        req = req.set('Authorization', `Bearer ${auth === 'invalid' ? 'bad' : donor.magic_token}`);
      const res = await req.send({
        email: donor.email,
        draft_id,
        pledge_amount_cents: 1000,
        items: [],
        channel_id: channel.id,
        plan: planPledge({
          pledge_amount_cents: 1000,
          available_wallet_cents: null,
          selections: [],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.wallet_applied_cents).toBe(0);
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 1000,
        balance_held_cents: 0,
      });
    },
  );

  it('returns historical pledges with an explicit LEGACY discriminant, read-only and without session secrets', async () => {
    const pledge = await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        expires_at: new Date(),
        total_cents: 1000,
        top_up_cents: 500,
        donor_email: 'private-marker@example.com',
        items: { create: [{ kind: 'REWARD', target_id: 'r1', amount_cents: 500 }] },
      },
    });
    legacy.push(pledge.id);
    const res = await request(app()).get(`/api/pledge/${pledge.pledge_token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      format: 'LEGACY',
      total_cents: 1000,
      top_up_cents: 500,
      items: [{ kind: 'REWARD' }],
    });
    expect(res.body).not.toHaveProperty('plan');
    expect(res.body).not.toHaveProperty('pledge_amount_cents');
    expect(JSON.stringify(res.body)).not.toContain('private-marker');
  });
  it('returns 404 for an unknown token', async () => {
    expect((await request(app()).get('/api/pledge/missing')).status).toBe(404);
  });
});
