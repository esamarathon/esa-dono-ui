import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { PrismaClient } from '@prisma/client';
import {
  backoffSeconds,
  drainDestination,
  sweepRetention,
} from '../../../services/webhooks/dispatcher.js';

const amqpMocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('amqplib', () => ({ connect: amqpMocks.connect }));

const prisma = new PrismaClient();

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    }),
  );
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('webhook dispatcher', () => {
  const destinationIds: string[] = [];
  const deliveryIds: string[] = [];

  beforeEach(() => {
    amqpMocks.connect.mockReset();
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
    await prisma.webhookDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
    await prisma.$disconnect();
  });

  type DestinationOverrides = {
    url?: string;
    is_active?: boolean;
    destination_type?: string;
    amqp_url?: string | null;
    amqp_exchange?: string;
    amqp_routing_key?: string | null;
  };

  type DeliveryOverrides = {
    payload?: string;
    attempts?: number;
    status?: string;
    next_attempt_at?: Date;
  };

  async function createDestination(data: DestinationOverrides = {}) {
    const dest = await prisma.webhookDestination.create({
      data: {
        url: 'http://127.0.0.1:1/hook',
        secret: 'secret',
        event_types: JSON.stringify(['donation.created']),
        ...data,
      },
    });
    destinationIds.push(dest.id);
    return dest;
  }

  async function createDelivery(destinationId: string, seq: number, data: DeliveryOverrides = {}) {
    const delivery = await prisma.webhookDelivery.create({
      data: {
        destination_id: destinationId,
        seq,
        message_id: crypto.randomUUID(),
        message_type: 'donation.created',
        payload: JSON.stringify({ id: seq }),
        status: 'PENDING',
        next_attempt_at: new Date(),
        ...data,
      },
    });
    deliveryIds.push(delivery.id);
    return delivery;
  }

  /** Start an HTTP server that records bodies and replies with `statusCode`. */
  async function startCaptureServer(statusCode = 200) {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        res.statusCode = statusCode;
        res.end('ok');
      });
    });
    const port = await listen(server);
    return { server, bodies, url: `http://127.0.0.1:${port}/hook` };
  }

  it('backoffSeconds follows the 5/15/60/180 schedule', () => {
    expect([1, 2, 3, 4, 5, 10].map(backoffSeconds)).toEqual([5, 15, 60, 180, 180, 180]);
    expect(backoffSeconds(0)).toBe(5);
  });

  it('drains all due messages in seq order in one call', async () => {
    const capture = await startCaptureServer(200);
    const dest = await createDestination({ url: capture.url });
    const d1 = await createDelivery(dest.id, 1, { payload: JSON.stringify({ id: 1 }) });
    const d2 = await createDelivery(dest.id, 2, { payload: JSON.stringify({ id: 2 }) });
    const d3 = await createDelivery(dest.id, 3, { payload: JSON.stringify({ id: 3 }) });

    await drainDestination(dest.id);

    expect(capture.bodies).toEqual([
      JSON.stringify({ id: 1 }),
      JSON.stringify({ id: 2 }),
      JSON.stringify({ id: 3 }),
    ]);
    const rows = await prisma.webhookDelivery.findMany({
      where: { id: { in: [d1.id, d2.id, d3.id] } },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS']);

    await close(capture.server);
  });

  it('stalls on a head that is not yet due and never touches later rows', async () => {
    const capture = await startCaptureServer(200);
    const dest = await createDestination({ url: capture.url });
    await createDelivery(dest.id, 1, { next_attempt_at: new Date(Date.now() + 60_000) });
    const d2 = await createDelivery(dest.id, 2);

    await drainDestination(dest.id);

    expect(capture.bodies).toEqual([]);
    const updated = await prisma.webhookDelivery.findUnique({ where: { id: d2.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.attempts).toBe(0);

    await close(capture.server);
  });

  it('keeps the head and stops on an endpoint failure (500)', async () => {
    const capture = await startCaptureServer(500);
    const dest = await createDestination({ url: capture.url });
    const d1 = await createDelivery(dest.id, 1);
    const d2 = await createDelivery(dest.id, 2);

    const before = Date.now();
    await drainDestination(dest.id);

    expect(capture.bodies).toHaveLength(1);
    const head = await prisma.webhookDelivery.findUnique({ where: { id: d1.id } });
    expect(head!.status).toBe('PENDING');
    expect(head!.attempts).toBe(1);
    expect(head!.last_status_code).toBe(500);
    const delay = head!.next_attempt_at.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThanOrEqual(6_000);
    const second = await prisma.webhookDelivery.findUnique({ where: { id: d2.id } });
    expect(second!.status).toBe('PENDING');
    expect(second!.attempts).toBe(0);

    await close(capture.server);
  });

  it('treats a 429 as an endpoint failure, not FAILED', async () => {
    const capture = await startCaptureServer(429);
    const dest = await createDestination({ url: capture.url });
    const delivery = await createDelivery(dest.id, 1);

    await drainDestination(dest.id);

    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.attempts).toBe(1);
    expect(updated!.last_status_code).toBe(429);

    await close(capture.server);
  });

  it('never marks a delivery FAILED on repeated endpoint failures', async () => {
    const dest = await createDestination({ url: 'http://127.0.0.1:1/hook' });
    const delivery = await createDelivery(dest.id, 1, { attempts: 10 });

    const before = Date.now();
    await drainDestination(dest.id);

    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.attempts).toBe(11);
    expect(updated!.last_status_code).toBe(0);
    const delay = updated!.next_attempt_at.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(175_000);
    expect(delay).toBeLessThanOrEqual(185_000);
  });

  it('marks a message-class failure FAILED and moves on to the next row', async () => {
    const capture = await startCaptureServer(200);
    const dest = await createDestination({ url: capture.url });
    const d1 = await createDelivery(dest.id, 1, { payload: '' });
    const d2 = await createDelivery(dest.id, 2, { payload: 'not json' });
    const d3 = await createDelivery(dest.id, 3, { payload: JSON.stringify({ id: 3 }) });

    await drainDestination(dest.id);

    const first = await prisma.webhookDelivery.findUnique({ where: { id: d1.id } });
    const second = await prisma.webhookDelivery.findUnique({ where: { id: d2.id } });
    const third = await prisma.webhookDelivery.findUnique({ where: { id: d3.id } });
    expect(first!.status).toBe('FAILED');
    expect(first!.last_error).toBeTruthy();
    expect(first!.last_status_code).toBeNull();
    expect(second!.status).toBe('FAILED');
    expect(second!.last_error).toBeTruthy();
    expect(third!.status).toBe('SUCCESS');
    expect(capture.bodies).toEqual([JSON.stringify({ id: 3 })]);

    await close(capture.server);
  });

  it('single-flight sends a row once for two concurrent drains', async () => {
    const capture = await startCaptureServer(200);
    const dest = await createDestination({ url: capture.url });
    const delivery = await createDelivery(dest.id, 1);

    await Promise.all([drainDestination(dest.id), drainDestination(dest.id)]);

    expect(capture.bodies).toHaveLength(1);
    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('SUCCESS');

    await close(capture.server);
  });

  it('does not lose a wake that arrives during an in-flight drain', async () => {
    const bodies: string[] = [];

    let seq2Promise: Promise<unknown> | null = null;
    let destId = '';
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        if (bodies.length === 1) {
          seq2Promise = prisma.webhookDelivery
            .create({
              data: {
                destination_id: destId,
                seq: 2,
                message_id: crypto.randomUUID(),
                message_type: 'donation.created',
                payload: JSON.stringify({ id: 2 }),
                status: 'PENDING',
                next_attempt_at: new Date(),
              },
            })
            .then((row) => {
              deliveryIds.push(row.id);
              drainDestination(destId).catch(() => {});
            });
          void seq2Promise.then(() => {
            res.statusCode = 200;
            res.end('ok');
          });
          return;
        }
        res.statusCode = 200;
        res.end('ok');
      });
    });
    const port = await listen(server);

    const dest = await createDestination({ url: `http://127.0.0.1:${port}/hook` });
    destId = dest.id;
    await createDelivery(dest.id, 1, { payload: JSON.stringify({ id: 1 }) });

    await drainDestination(dest.id);

    expect(bodies).toEqual([JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 })]);
    const rows = await prisma.webhookDelivery.findMany({
      where: { destination_id: dest.id },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['SUCCESS', 'SUCCESS']);

    await close(server);
  });

  it('does not send to an inactive destination', async () => {
    const capture = await startCaptureServer(200);
    const dest = await createDestination({ url: capture.url, is_active: false });
    const delivery = await createDelivery(dest.id, 1);

    await drainDestination(dest.id);

    expect(capture.bodies).toEqual([]);
    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.attempts).toBe(0);

    await close(capture.server);
  });

  it('publishes RABBITMQ deliveries with the message id and heartbeat', async () => {
    const publish = vi.fn(
      (_exchange: string, _key: string, _buf: Buffer, _opts: object, cb: (err: null) => void) =>
        cb(null),
    );
    amqpMocks.connect.mockResolvedValue({
      on: vi.fn(),
      createConfirmChannel: async () => ({ on: vi.fn(), publish }),
    });

    const dest = await createDestination({
      url: '',
      destination_type: 'RABBITMQ',
      amqp_url: 'amqp://localhost',
      amqp_exchange: 'tiltify',
      amqp_routing_key: 'my.queue',
    });
    const delivery = await createDelivery(dest.id, 1, { payload: JSON.stringify({ id: 1 }) });

    await drainDestination(dest.id);

    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('SUCCESS');
    expect(amqpMocks.connect).toHaveBeenCalledTimes(1);
    expect(amqpMocks.connect.mock.calls[0]?.[0]).toContain('heartbeat=30');
    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls.at(0);
    expect(call).toBeDefined();
    const [exchange, routingKey, buffer, options] = call!;
    expect(exchange).toBe('tiltify');
    expect(routingKey).toBe('my.queue');
    expect(buffer.toString()).toBe(JSON.stringify({ id: 1 }));
    expect(options).toMatchObject({
      persistent: true,
      messageId: delivery.message_id,
      type: 'donation.created',
      headers: {
        'x-webhook-event': 'donation.created',
        'x-webhook-delivery': delivery.id,
      },
    });
  });

  it('treats a RABBITMQ destination missing config as an endpoint failure', async () => {
    const dest = await createDestination({
      url: '',
      destination_type: 'RABBITMQ',
      amqp_url: 'amqp://localhost',
      amqp_routing_key: null,
    });
    const delivery = await createDelivery(dest.id, 1);

    await drainDestination(dest.id);

    const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.attempts).toBe(1);
    expect(updated!.last_error).toMatch(/amqp_routing_key/);
    expect(amqpMocks.connect).not.toHaveBeenCalled();
  });

  it('fails the attempt when the AMQP publish confirm times out', async () => {
    process.env.WEBHOOK_AMQP_CONFIRM_TIMEOUT_MS = '50';
    try {
      const publish = vi.fn(); // never calls its callback
      const closeConnection = vi.fn().mockResolvedValue(undefined);
      amqpMocks.connect.mockResolvedValue({
        on: vi.fn(),
        close: closeConnection,
        createConfirmChannel: async () => ({ on: vi.fn(), publish }),
      });

      const dest = await createDestination({
        url: '',
        destination_type: 'RABBITMQ',
        amqp_url: 'amqp://localhost',
        amqp_routing_key: 'my.queue',
      });
      const delivery = await createDelivery(dest.id, 1);

      await drainDestination(dest.id);

      const updated = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
      expect(updated!.status).toBe('PENDING');
      expect(updated!.attempts).toBe(1);
      expect(updated!.last_error).toBe('AMQP publish confirm timed out');
      expect(closeConnection).toHaveBeenCalled();
    } finally {
      delete process.env.WEBHOOK_AMQP_CONFIRM_TIMEOUT_MS;
    }
  });

  it('sweeps SUCCESS and FAILED rows past retention but never PENDING', async () => {
    const dest = await createDestination({ url: 'http://127.0.0.1:1/hook' });
    const success = await createDelivery(dest.id, 1, { status: 'SUCCESS' });
    const failed = await createDelivery(dest.id, 2, { status: 'FAILED' });
    const pending = await createDelivery(dest.id, 3, { status: 'PENDING' });

    await sweepRetention(new Date(Date.now() + 3 * 3600_000));

    const afterThreeHours = await prisma.webhookDelivery.findMany({
      where: { id: { in: [success.id, failed.id, pending.id] } },
      select: { id: true },
    });
    const remainingIds = afterThreeHours.map((r) => r.id);
    expect(remainingIds).not.toContain(success.id);
    expect(remainingIds).toContain(failed.id);
    expect(remainingIds).toContain(pending.id);

    await sweepRetention(new Date(Date.now() + 25 * 3600_000));

    const afterDay = await prisma.webhookDelivery.findMany({
      where: { id: { in: [failed.id, pending.id] } },
      select: { id: true },
    });
    const remainingAfterDay = afterDay.map((r) => r.id);
    expect(remainingAfterDay).not.toContain(failed.id);
    expect(remainingAfterDay).toContain(pending.id);
  });
});
