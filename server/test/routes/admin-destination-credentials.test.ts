import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import adminRouter from '../../routes/admin.js';
import { toDestinationResponse } from '../../services/webhooks/destinationResponse.js';

// Deliveries are not dispatched here; these tests assert response shapes only.
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));

const prisma = createDatabaseClient();
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };
const PASSWORD = 'broker-p%40ssword';
const SECRET = 'private-hmac-secret';
const AMQP_URL = `amqps://broker:${PASSWORD}@mq.example.com:5671/old-vhost?heartbeat=30`;
const MASKED_URL = 'amqps://broker:****@mq.example.com:5671/old-vhost?heartbeat=30';
const ids: string[] = [];
const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

async function createStoredDestination(amqpUrl: string | null = AMQP_URL) {
  const destination = await prisma.webhookDestination.create({
    data: {
      url: '',
      destination_type: 'RABBITMQ',
      amqp_url: amqpUrl,
      amqp_routing_key: 'donations',
      secret: SECRET,
      event_types: '["donation.created"]',
      is_active: false,
    },
  });
  ids.push(destination.id);
  return destination;
}

/** #127: no response body may ever carry stored credentials. */
function expectNoCredentials(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(PASSWORD);
  expect(json).not.toContain(decodeURIComponent(PASSWORD));
  expect(json).not.toContain(SECRET);
  expect(json).not.toContain('"secret":');
}

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: ids } } });
  await prisma.webhookDestinationSeq.deleteMany({ where: { destination_id: { in: ids } } });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Destination credential responses (#127)', () => {
  it('masks create and rotate URLs, disclosing only the signing secret once', async () => {
    const created = await request(app)
      .post('/api/admin/destinations')
      .set(AUTH)
      .send({
        destination_type: 'RABBITMQ',
        amqp_url: AMQP_URL,
        amqp_routing_key: 'donations',
        secret: SECRET,
        event_types: ['donation.created'],
      });
    expect(created.status).toBe(201);
    ids.push(created.body.id);
    expect(created.body).toMatchObject({
      amqp_url: MASKED_URL,
      secret: SECRET,
      has_secret: true,
      has_amqp_url: true,
    });
    expect(JSON.stringify(created.body)).not.toContain(PASSWORD);
    // The write path stores the real values even though the response masks them.
    expect(
      await prisma.webhookDestination.findUnique({ where: { id: created.body.id } }),
    ).toMatchObject({ amqp_url: AMQP_URL, secret: SECRET });

    const rotated = await request(app)
      .post(`/api/admin/destinations/${created.body.id}/rotate-secret`)
      .set(AUTH);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({
      amqp_url: MASKED_URL,
      has_secret: true,
      has_amqp_url: true,
    });
    expect(rotated.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.body.secret).not.toBe(SECRET);
    expect(JSON.stringify(rotated.body)).not.toContain(PASSWORD);
    expect(
      await prisma.webhookDestination.findUnique({ where: { id: created.body.id } }),
    ).toMatchObject({ secret: rotated.body.secret });

    const listed = await request(app).get('/api/admin/destinations').set(AUTH);
    expect(listed.status).toBe(200);
    expectNoCredentials(listed.body);
    expect(JSON.stringify(listed.body)).not.toContain(rotated.body.secret);
  });

  it('omits credentials from every other destination route response, including populated logs', async () => {
    const destination = await createStoredDestination();
    const delivery = await prisma.webhookDelivery.create({
      data: {
        destination_id: destination.id,
        seq: 1,
        message_id: crypto.randomUUID(),
        message_type: 'donation.created',
        payload: '{}',
        status: 'FAILED',
      },
    });
    await prisma.webhookDestinationSeq.create({
      data: { destination_id: destination.id, seq: delivery.seq },
    });
    const base = `/api/admin/destinations/${destination.id}`;
    const responses = [
      await request(app).get('/api/admin/destinations').set(AUTH),
      await request(app).put(base).set(AUTH).send({ description: 'Updated' }),
      await request(app).get(`${base}/deliveries`).set(AUTH),
      await request(app).post(`${base}/test`).set(AUTH),
      await request(app).post(`${base}/deliveries/${delivery.id}/requeue`).set(AUTH),
      await request(app).post(`${base}/requeue-failed`).set(AUTH),
      await request(app).delete(base).set(AUTH),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      expectNoCredentials(response.body);
    }
    expect(responses[1]!.body).toMatchObject({
      amqp_url: MASKED_URL,
      has_secret: true,
      has_amqp_url: true,
    });
    expect(responses[2]!.body.deliveries).toHaveLength(1);
  });

  it('preserves the password on masked edits while changing user, host, port, vhost and query', async () => {
    const destination = await createStoredDestination();
    const submitted = 'amqps://new-user:****@new.example.com:5672/new-vhost?heartbeat=60';
    const response = await request(app)
      .put(`/api/admin/destinations/${destination.id}`)
      .set(AUTH)
      .send({ amqp_url: submitted });
    expect(response.status).toBe(200);
    expectNoCredentials(response.body);
    expect(response.body.amqp_url).toBe(submitted);
    const stored = await prisma.webhookDestination.findUniqueOrThrow({
      where: { id: destination.id },
    });
    expect(stored.amqp_url).toBe(
      `amqps://new-user:${PASSWORD}@new.example.com:5672/new-vhost?heartbeat=60`,
    );
    expect(stored.secret).toBe(SECRET);

    for (const secret of [undefined, '']) {
      const unchanged = await request(app)
        .put(`/api/admin/destinations/${destination.id}`)
        .set(AUTH)
        .send({ secret, description: 'No credentials supplied' });
      expect(unchanged.status).toBe(200);
      expectNoCredentials(unchanged.body);
      expect(
        await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destination.id } }),
      ).toMatchObject({ amqp_url: stored.amqp_url, secret: SECRET });
    }

    const replacement = await request(app)
      .put(`/api/admin/destinations/${destination.id}`)
      .set(AUTH)
      .send({ amqp_url: 'amqp://new-user:replacement@new.example.com/new-vhost' });
    expect(replacement.status).toBe(200);
    expect(replacement.body.amqp_url).toBe('amqp://new-user:****@new.example.com/new-vhost');
    expect(
      await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destination.id } }),
    ).toMatchObject({ amqp_url: 'amqp://new-user:replacement@new.example.com/new-vhost' });
  });

  it.each([null, 'amqp://broker@mq.example.com/old-vhost'])(
    'never stores the mask when the stored URL has no password (%s)',
    async (amqpUrl) => {
      const destination = await createStoredDestination(amqpUrl);
      const response = await request(app)
        .put(`/api/admin/destinations/${destination.id}`)
        .set(AUTH)
        .send({ amqp_url: 'amqp://broker:****@new.example.com/new-vhost' });
      expect(response.status).toBe(200);
      expect(response.body.amqp_url).toBe('amqp://broker@new.example.com/new-vhost');
      expect(
        await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destination.id } }),
      ).toMatchObject({ amqp_url: 'amqp://broker@new.example.com/new-vhost' });
    },
  );

  it('returns safe URL fallbacks and reports absent secrets', async () => {
    const destination = await createStoredDestination();
    for (const amqpUrl of [null, '', `not a URL ${PASSWORD}`, `amqp://broker:${PASSWORD}@`]) {
      const response = toDestinationResponse({ ...destination, amqp_url: amqpUrl, secret: '' });
      expect(response.amqp_url).toBeNull();
      expect(response.has_secret).toBe(false);
      expect(response.has_amqp_url).toBe(amqpUrl !== null && amqpUrl !== '');
      expectNoCredentials(response);
    }
    expect(
      toDestinationResponse({ ...destination, amqp_url: 'amqp://broker@host:5672/vhost?q=1' })
        .amqp_url,
    ).toBe('amqp://broker@host:5672/vhost?q=1');

    await prisma.webhookDestination.update({
      where: { id: destination.id },
      data: { amqp_url: `invalid ${PASSWORD}` },
    });
    const listed = await request(app).get('/api/admin/destinations').set(AUTH);
    expect(listed.status).toBe(200);
    expectNoCredentials(listed.body);
  });

  it.each(['https://broker:password@host/vhost', 'amqp://broker:password@', null, 42])(
    'rejects invalid submitted URLs without echoing them (%s)',
    async (amqpUrl) => {
      const destination = await createStoredDestination();
      const response = await request(app)
        .put(`/api/admin/destinations/${destination.id}`)
        .set(AUTH)
        .send({ amqp_url: amqpUrl });
      expect(response.status).toBe(400);
      expectNoCredentials(response.body);
      expect(JSON.stringify(response.body)).not.toContain('password@');
      expect(
        await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destination.id } }),
      ).toMatchObject({ amqp_url: AMQP_URL });
    },
  );
});
