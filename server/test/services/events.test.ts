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

  let eventId: string;
  let activeChannelId: string;
  let otherEventId: string;

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

  async function makeChannel(eventId: string, name: string, is_active = true) {
    const channel = await createTestChannel(prisma, { name, event_id: eventId, is_active });
    createdChannelIds.push(channel.id);
    return channel;
  }

  afterAll(async () => {
    await prisma.event.updateMany({
      where: { primary_channel_id: { in: createdChannelIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.$disconnect();
  });

  it('rejects an unknown event with 404', async () => {
    try {
      await assertCanActivateEvent(prisma, 'does-not-exist');
      expect.fail('expected assertCanActivateEvent to throw');
    } catch (err) {
      expect((err as any).status).toBe(404);
    }
  });

  it('rejects activation when the event has no primary channel (409)', async () => {
    const event = await makeEvent('No Primary');
    await makeChannel(event.id, `No Primary Channel ${rand()}`);
    eventId = event.id;

    try {
      await assertCanActivateEvent(prisma, eventId);
      expect.fail('expected assertCanActivateEvent to throw');
    } catch (err) {
      expect((err as any).status).toBe(409);
    }
  });

  it('rejects activation when the primary belongs to another event (409)', async () => {
    const event = await makeEvent('Wrong Primary');
    eventId = event.id;
    const other = await makeEvent('Other');
    otherEventId = other.id;
    const foreignPrimary = await makeChannel(otherEventId, `Foreign Primary ${rand()}`);
    await prisma.event.update({
      where: { id: eventId },
      data: { primary_channel_id: foreignPrimary.id },
    });

    try {
      await assertCanActivateEvent(prisma, eventId);
      expect.fail('expected assertCanActivateEvent to throw');
    } catch (err) {
      expect((err as any).status).toBe(409);
    }

    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: null } });
  });

  it('rejects activation when the primary channel is inactive (409)', async () => {
    const event = await makeEvent('Inactive Primary');
    eventId = event.id;
    const inactive = await makeChannel(eventId, `Inactive Primary ${rand()}`, false);
    await prisma.event.update({
      where: { id: eventId },
      data: { primary_channel_id: inactive.id },
    });

    try {
      await assertCanActivateEvent(prisma, eventId);
      expect.fail('expected assertCanActivateEvent to throw');
    } catch (err) {
      expect((err as any).status).toBe(409);
    }

    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: null } });
  });

  it('resolves when the primary is an active channel of the event', async () => {
    const event = await makeEvent('Good Primary');
    eventId = event.id;
    const primary = await makeChannel(eventId, `Good Primary ${rand()}`);
    activeChannelId = primary.id;
    await prisma.event.update({
      where: { id: eventId },
      data: { primary_channel_id: primary.id },
    });

    await expect(assertCanActivateEvent(prisma, eventId)).resolves.toBeUndefined();

    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: null } });
    expect(activeChannelId).toBe(primary.id);
  });
});
