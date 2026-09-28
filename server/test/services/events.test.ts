import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { assertCanActivateEvent } from '../../services/events.js';
import { createTestChannel } from '../helpers/fixtures.js';

const prisma = new PrismaClient();

function rand() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

describe('assertCanActivateEvent', () => {
  const createdChannelIds: string[] = [];
  const createdEventIds: string[] = [];

  async function makeEvent(name: string) {
    const event = await prisma.event.create({
      data: {
        name: `${name} ${rand()}`,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rand()}`,
      },
    });
    createdEventIds.push(event.id);
    return event;
  }

  async function makeChannel(eventId: string, is_active = true) {
    const channel = await createTestChannel(prisma, { event_id: eventId, is_active });
    createdChannelIds.push(channel.id);
    return channel;
  }

  async function setPrimary(eventId: string, channelId: string) {
    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: channelId } });
  }

  afterAll(async () => {
    await prisma.event.updateMany({
      where: { id: { in: createdEventIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.$disconnect();
  });

  it('rejects an unknown event with 404', async () => {
    await expect(assertCanActivateEvent(prisma, 'does-not-exist')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects activation when the event has no primary channel (409)', async () => {
    const event = await makeEvent('No Primary');
    await makeChannel(event.id);

    await expect(assertCanActivateEvent(prisma, event.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/primary channel/),
    });
  });

  it('rejects activation when the primary belongs to another event (409)', async () => {
    const event = await makeEvent('Wrong Primary');
    const other = await makeEvent('Other');
    await setPrimary(event.id, (await makeChannel(other.id)).id);

    await expect(assertCanActivateEvent(prisma, event.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/belong to this event/),
    });
  });

  it('rejects activation when the primary channel is inactive (409)', async () => {
    const event = await makeEvent('Inactive Primary');
    await setPrimary(event.id, (await makeChannel(event.id, false)).id);

    await expect(assertCanActivateEvent(prisma, event.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/must be active/),
    });
  });

  it('resolves when the primary is an active channel of the event', async () => {
    const event = await makeEvent('Good Primary');
    await setPrimary(event.id, (await makeChannel(event.id)).id);

    await expect(assertCanActivateEvent(prisma, event.id)).resolves.toBeUndefined();
  });
});
