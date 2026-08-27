import { describe, it, expect, vi, afterAll } from 'vitest';
import http from 'http';
import { PrismaClient } from '@prisma/client';
import { processDestination, backoffMinutes } from '../../services/eventDispatcher.js';

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

describe('eventDispatcher', () => {
  const destinationIds: string[] = [];
  const deliveryIds: string[] = [];

  afterAll(async () => {
    await prisma.eventDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
    await prisma.eventDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.eventDestination.deleteMany({ where: { id: { in: destinationIds } } });
    await prisma.$disconnect();
  });

  it('backoffMinutes doubles and caps at the maximum', () => {
    expect(backoffMinutes(0)).toBe(1);
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(2)).toBe(4);
    expect(backoffMinutes(3)).toBe(8);
    expect(backoffMinutes(10)).toBe(60);
  });

  it('processDestination marks a delivery SUCCESS on a 2xx response', async () => {
    let receivedBody = '';
    let receivedSignature: string | undefined;
    const server = http.createServer((req, res) => {
      receivedSignature = req.headers['x-webhook-signature'] as string;
      req.on('data', (chunk) => (receivedBody += chunk));
      req.on('end', () => {
        res.statusCode = 200;
        res.end('ok');
      });
    });
    const port = await listen(server);

    const dest = await prisma.eventDestination.create({
      data: {
        url: `http://127.0.0.1:${port}/hook`,
        secret: 'secret',
        event_types: JSON.stringify(['donation.created']),
      },
    });
    destinationIds.push(dest.id);
    const delivery = await prisma.eventDelivery.create({
      data: {
        destination_id: dest.id,
        seq: 1,
        event_type: 'donation.created',
        payload: JSON.stringify({ id: 'x' }),
        status: 'PENDING',
        next_attempt_at: new Date(),
      },
    });
    deliveryIds.push(delivery.id);

    await processDestination(dest.id);

    const updated = await prisma.eventDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('SUCCESS');
    expect(updated!.last_status_code).toBe(200);
    expect(receivedBody).toBe(JSON.stringify({ id: 'x' }));
    expect(receivedSignature).toMatch(/^t=\d+,v1=[a-f0-9]+$/);

    await close(server);
  });

  it('processDestination marks a delivery FAILED once max attempts are exhausted', async () => {
    const dest = await prisma.eventDestination.create({
      data: {
        url: 'http://127.0.0.1:1/hook', // port 1 is effectively always closed
        secret: 'secret',
        event_types: JSON.stringify(['donation.created']),
      },
    });
    destinationIds.push(dest.id);
    const delivery = await prisma.eventDelivery.create({
      data: {
        destination_id: dest.id,
        seq: 1,
        event_type: 'donation.created',
        payload: JSON.stringify({ id: 'x' }),
        status: 'PENDING',
        attempts: 4,
        next_attempt_at: new Date(),
      },
    });
    deliveryIds.push(delivery.id);

    await processDestination(dest.id);

    const updated = await prisma.eventDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('FAILED');
    expect(updated!.attempts).toBe(5);
  });

  it('processDestination publishes a RABBITMQ delivery', async () => {
    const publish = vi.fn((_ex, _key, _buf, _opts, cb) => cb(null));
    amqpMocks.connect.mockResolvedValue({
      createConfirmChannel: async () => ({ publish }),
    });

    const dest = await prisma.eventDestination.create({
      data: {
        url: '',
        secret: 'secret',
        destination_type: 'RABBITMQ',
        amqp_url: 'amqp://localhost',
        amqp_routing_key: 'my.queue',
        event_types: '[]',
      },
    });
    destinationIds.push(dest.id);
    const delivery = await prisma.eventDelivery.create({
      data: {
        destination_id: dest.id,
        seq: 1,
        event_type: 'donation.created',
        payload: JSON.stringify({ id: 'x' }),
        status: 'PENDING',
        next_attempt_at: new Date(),
      },
    });
    deliveryIds.push(delivery.id);

    await processDestination(dest.id);

    const updated = await prisma.eventDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('SUCCESS');
    expect(publish).toHaveBeenCalled();
  });

  it('processDestination fails a RABBITMQ delivery missing config', async () => {
    const dest = await prisma.eventDestination.create({
      data: {
        url: '',
        secret: 'secret',
        destination_type: 'RABBITMQ',
        amqp_url: null,
        amqp_routing_key: null,
        event_types: '[]',
      },
    });
    destinationIds.push(dest.id);
    const delivery = await prisma.eventDelivery.create({
      data: {
        destination_id: dest.id,
        seq: 1,
        event_type: 'donation.created',
        payload: '{}',
        status: 'PENDING',
        max_attempts: 1,
        next_attempt_at: new Date(),
      },
    });
    deliveryIds.push(delivery.id);

    await processDestination(dest.id);

    const updated = await prisma.eventDelivery.findUnique({ where: { id: delivery.id } });
    expect(updated!.status).toBe('FAILED');
  });
});
