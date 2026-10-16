import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import moderatorRouter from '../../routes/moderator.js';
import adminRouter from '../../routes/admin.js';
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);
const events: string[] = [],
  donors: string[] = [],
  polls: string[] = [];
const admin = 'Bearer key_admin_test-admin-key';
async function fixture({ role, pledge }: Readonly<{ role: string; pledge: number }>) {
  const token = crypto.randomUUID();
  const staff = await prisma.donor.create({
    data: {
      email: `${token}@staff.example`,
      role,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60000),
    },
  });
  donors.push(staff.id);
  const donor = await prisma.donor.create({
    data: { email: `PRIVATE-${crypto.randomUUID()}@marker.example` },
  });
  donors.push(donor.id);
  const event = await prisma.event.create({
    data: { name: 'Route end', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: event.id },
  });
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: pledge,
      pledge_amount_cents: pledge,
      comment: 'choice',
      channel_id: channel.id,
      event_id: event.id,
    },
  });
  const poll = await prisma.poll.create({
    data: { title: 'Open', options: { create: { label: 'A' } } },
    include: { options: true },
  });
  polls.push(poll.id);
  return { token, staff, donor, event, channel, donation, poll };
}
afterEach(async () => {
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.eventEndAudit.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  events.length = donors.length = polls.length = 0;
});
afterAll(() => prisma.$disconnect());

it.each(['DONOR', 'anonymous'])('%s cannot access any new staff endpoint', async (role) => {
  const f = await fixture({ role: 'DONOR', pledge: 25 });
  const auth = role === 'anonymous' ? {} : { Authorization: `Bearer ${f.token}` };
  const expected = role === 'anonymous' ? 401 : 403;
  const responses = [
    await request(app).get('/api/moderator/unused-pool-money').set(auth),
    await request(app)
      .get(`/api/moderator/donations/${f.donation.id}/unused-pool-money/targets?category=poll`)
      .set(auth),
    await request(app)
      .post(`/api/moderator/donations/${f.donation.id}/unused-pool-money`)
      .set(auth)
      .send({ category: 'poll', target_id: f.poll.options[0]!.id, expected_amount_cents: 25 }),
    await request(app).post('/api/moderator/unused-pool-money/poll/unknown/undo').set(auth),
    await request(app).get(`/api/admin/events/${f.event.id}/end-preview`).set(auth),
    await request(app).get(`/api/admin/events/${f.event.id}/undo-end-preview`).set(auth),
    await request(app)
      .post(`/api/admin/events/${f.event.id}/end`)
      .set(auth)
      .send({ slug: f.event.slug }),
    await request(app)
      .post(`/api/admin/events/${f.event.id}/undo-end`)
      .set(auth)
      .send({ slug: f.event.slug }),
  ];
  expect(responses.map((r) => r.status)).toEqual(Array(8).fill(expected));
});
it('operational key assignments attribute moderator fallback; admin session end/undo is audited', async () => {
  const f = await fixture({ role: 'ADMIN', pledge: 25 });
  const assigned = await request(app)
    .post(`/api/moderator/donations/${f.donation.id}/unused-pool-money`)
    .set('Authorization', admin)
    .send({ category: 'poll', target_id: f.poll.options[0]!.id, expected_amount_cents: 25 });
  expect(assigned.status).toBe(200);
  expect(assigned.body.allocated_by).toBe('moderator');
  const auth = `Bearer ${f.token}`;
  const ended = await request(app)
    .post(`/api/admin/events/${f.event.id}/end`)
    .set('Authorization', auth)
    .send({ slug: f.event.slug });
  expect(ended.status).toBe(200);
  expect(ended.body.ended_by).toBe(f.staff.email);
  const preview = await request(app)
    .get(`/api/admin/events/${f.event.id}/undo-end-preview`)
    .set('Authorization', auth);
  expect(preview.status).toBe(200);
  expect(JSON.stringify(preview.body)).not.toContain(f.donor.email);
  const undone = await request(app)
    .post(`/api/admin/events/${f.event.id}/undo-end`)
    .set('Authorization', auth)
    .send({ slug: f.event.slug });
  expect(undone.status).toBe(200);
  expect(undone.body.end_undone_by).toBe(f.staff.email);
});
it('rejects unsupported categories and stale amounts without leaking donor identity', async () => {
  const f = await fixture({ role: 'MODERATOR', pledge: 25 });
  const response = await request(app)
    .post(`/api/moderator/donations/${f.donation.id}/unused-pool-money`)
    .set('Authorization', admin)
    .send({ category: 'reward', target_id: f.poll.options[0]!.id, expected_amount_cents: 25 });
  expect(response.status).toBe(400);
  const stale = await request(app)
    .post(`/api/moderator/donations/${f.donation.id}/unused-pool-money`)
    .set('Authorization', admin)
    .send({ category: 'poll', target_id: f.poll.options[0]!.id, expected_amount_cents: 24 });
  expect(stale.status).toBe(409);
  expect(JSON.stringify(stale.body)).not.toContain(f.donor.email);
});

it('moderator list/picker/assign/undo are safe and session attribution is not the donor email', async () => {
  const f = await fixture({ role: 'MODERATOR', pledge: 25 });
  const auth = `Bearer ${f.token}`;
  const list = await request(app)
    .get('/api/moderator/unused-pool-money')
    .set('Authorization', auth);
  expect(list.status).toBe(200);
  expect(list.body.find((row: { id: string }) => row.id === f.donation.id)).toMatchObject({
    unused_cents: { poll: 25, goal: 25 },
  });
  const picker = await request(app)
    .get(`/api/moderator/donations/${f.donation.id}/unused-pool-money/targets?category=poll`)
    .set('Authorization', auth);
  expect(picker.status).toBe(200);
  expect(picker.body.targets).toContainEqual(
    expect.objectContaining({ id: f.poll.options[0]!.id, before_cents: 0, after_cents: 25 }),
  );
  const assigned = await request(app)
    .post(`/api/moderator/donations/${f.donation.id}/unused-pool-money`)
    .set('Authorization', auth)
    .send({ category: 'poll', target_id: f.poll.options[0]!.id, expected_amount_cents: 25 });
  expect(assigned.status).toBe(200);
  expect(assigned.body.allocated_by).toBe(f.staff.email);
  const undone = await request(app)
    .post(`/api/moderator/unused-pool-money/poll/${assigned.body.id}/undo`)
    .set('Authorization', auth)
    .send({});
  expect(undone.status).toBe(200);
  for (const response of [list, picker, assigned, undone])
    expect(JSON.stringify(response.body)).not.toContain(f.donor.email);
});
it('only admin can preview/end/undo; shared moderator identity exposes ended state but cannot reactivate', async () => {
  const f = await fixture({ role: 'MODERATOR', pledge: 25 });
  for (const path of ['end', 'undo-end']) {
    expect(
      (
        await request(app)
          .post(`/api/admin/events/${f.event.id}/${path}`)
          .set('Authorization', `Bearer ${f.token}`)
          .send({ slug: f.event.slug })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/api/admin/events/${f.event.id}/${path}-preview`)
          .set('Authorization', `Bearer ${f.token}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/moderator/events/${f.event.id}/${path}`)
          .set('Authorization', `Bearer ${f.token}`)
          .send({ slug: f.event.slug })
      ).status,
    ).toBe(404);
  }
  const preview = await request(app)
    .get(`/api/admin/events/${f.event.id}/end-preview`)
    .set('Authorization', admin);
  expect(preview.status).toBe(200);
  expect(preview.body.can_apply).toBe(true);
  expect(
    (
      await request(app)
        .post(`/api/admin/events/${f.event.id}/end`)
        .set('Authorization', admin)
        .send({ slug: 'wrong' })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(`/api/admin/events/${f.event.id}/end`)
        .set('Authorization', admin)
        .send({ slug: f.event.slug })
    ).status,
  ).toBe(200);
  const listed = await request(app)
    .get('/api/moderator/events')
    .set('Authorization', `Bearer ${f.token}`);
  expect(listed.body.find((row: { id: string }) => row.id === f.event.id).ended_at).toBeTruthy();
  const hidden = await request(app)
    .get('/api/moderator/unused-pool-money')
    .set('Authorization', admin);
  expect(hidden.body.some((row: { id: string }) => row.id === f.donation.id)).toBe(false);
  const shown = await request(app)
    .get(`/api/moderator/unused-pool-money?show_ended=true&channel_id=${f.channel.id}`)
    .set('Authorization', admin);
  expect(shown.body.map((row: { id: string }) => row.id)).toEqual([f.donation.id]);
  expect(
    (
      await request(app)
        .put(`/api/moderator/events/${f.event.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ is_active: true })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(app)
        .post(`/api/admin/events/${f.event.id}/undo-end`)
        .set('Authorization', admin)
        .send({ slug: f.event.slug })
    ).status,
  ).toBe(200);
});
