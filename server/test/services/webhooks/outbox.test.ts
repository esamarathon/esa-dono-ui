import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Real database, real emit; only the dispatcher is replaced so we can see which
// Destinations are woken without sending anything.
const dispatcher = vi.hoisted(() => ({ wakeDispatcher: vi.fn() }));
vi.mock('../../../services/webhooks/dispatcher.js', () => dispatcher);

import { withWebhooks } from '../../../services/webhooks/outbox.js';
import { buildIncentiveCreatedPayload } from '../../../services/webhooks/delivery.js';

const prisma = new PrismaClient();
const destinationIds: string[] = [];

const build = () =>
  buildIncentiveCreatedPayload({
    incentiveKind: 'GOAL',
    incentiveId: 'goal-1',
    title: 'Outbox test goal',
    isActive: true,
    targetCents: 1000,
  });

async function destination(types: string[]) {
  const d = await prisma.webhookDestination.create({
    data: { url: 'http://127.0.0.1:1/hook', secret: 's', event_types: JSON.stringify(types) },
  });
  destinationIds.push(d.id);
  return d;
}

describe('withWebhooks (transactional outbox)', () => {
  beforeEach(() => dispatcher.wakeDispatcher.mockClear());

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinationIds } } });
    await prisma.webhookDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
    await prisma.$disconnect();
  });

  it('commits the message with the change and wakes only the destinations that received it', async () => {
    const subscribed = await destination(['incentive.created']);
    const other = await destination(['donation.created']);

    await withWebhooks(async (_tx, emit) => {
      await emit('incentive.created', build);
    });

    const rows = await prisma.webhookDelivery.findMany({
      where: { destination_id: { in: [subscribed.id, other.id] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destination_id: subscribed.id, seq: 1, status: 'PENDING' });
    expect(dispatcher.wakeDispatcher).toHaveBeenCalledWith(subscribed.id);
    expect(dispatcher.wakeDispatcher).not.toHaveBeenCalledWith(other.id);
  });

  it('a rollback removes the queued message and wakes nothing', async () => {
    const d = await destination(['incentive.created']);

    await expect(
      withWebhooks(async (_tx, emit) => {
        await emit('incentive.created', build);
        throw new Error('change failed');
      }),
    ).rejects.toThrow('change failed');

    expect(await prisma.webhookDelivery.count({ where: { destination_id: d.id } })).toBe(0);
    expect(await prisma.webhookDestinationSeq.count({ where: { destination_id: d.id } })).toBe(0);
    expect(dispatcher.wakeDispatcher).not.toHaveBeenCalled();
  });

  it('gives concurrent transactions distinct, gap-free seq numbers', async () => {
    const d = await destination(['incentive.created']);

    // Like every real emit site, each transaction writes its change first and
    // then emits, so SQLite serialises the writers and seq follows commit order.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withWebhooks(async (tx, emit) => {
          await tx.webhookDestination.update({
            where: { id: d.id },
            data: { description: `change ${i}` },
          });
          await emit('incentive.created', build);
        }),
      ),
    );

    const rows = await prisma.webhookDelivery.findMany({ where: { destination_id: d.id } });
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(5);
  });
});
