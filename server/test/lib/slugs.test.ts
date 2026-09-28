import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  SLUG_MAX_LENGTH,
  availableSlugFrom,
  isSlugAvailable,
  slugProblem,
  slugify,
} from '../../lib/slugs.js';
import { createTestChannel, DEFAULT_EVENT_ID } from '../helpers/fixtures.js';

const prisma = new PrismaClient();

describe('slugProblem', () => {
  it('returns null for valid slugs', () => {
    expect(slugProblem('esa-summer-2025')).toBeNull();
    expect(slugProblem('abc')).toBeNull();
    expect(slugProblem('a'.repeat(SLUG_MAX_LENGTH))).toBeNull();
  });

  it('explains why a slug is invalid', () => {
    expect(slugProblem('ab')).toMatch(/3-64 characters/);
    expect(slugProblem('a'.repeat(SLUG_MAX_LENGTH + 1))).toMatch(/3-64 characters/);
    expect(slugProblem('ESA')).toMatch(/lowercase/);
    expect(slugProblem('esa.summer')).toMatch(/lowercase/);
    expect(slugProblem('esa summer')).toMatch(/lowercase/);
    expect(slugProblem('-esa')).toMatch(/lowercase/);
    expect(slugProblem('esa-')).toMatch(/lowercase/);
    expect(slugProblem('esa--x')).toMatch(/lowercase/);
    expect(slugProblem('admin')).toMatch(/reserved/);
  });

  it('rejects non-strings', () => {
    expect(slugProblem(42)).toBe('slug must be a string');
    expect(slugProblem(undefined)).toBe('slug must be a string');
    expect(slugProblem(null)).toBe('slug must be a string');
  });
});

describe('slugify', () => {
  it('lowercases, strips accents and collapses punctuation into hyphens', () => {
    expect(slugify('ESA Summer 2025 – Stream 1')).toBe('esa-summer-2025-stream-1');
    expect(slugify('Café Déjà')).toBe('cafe-deja');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('  !!  ')).toBe('');
  });
});

describe('slug helpers against the database', () => {
  const createdChannelIds: string[] = [];
  const createdEventIds: string[] = [];

  afterAll(async () => {
    // Clear primaries before deleting channels (FK), then channels, then events.
    await prisma.event.updateMany({
      where: { primary_channel_id: { in: createdChannelIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.$disconnect();
  });

  it('availableSlugFrom appends a numeric suffix when the slug is taken', async () => {
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const channel = await createTestChannel(prisma, {
      name: `QA Dup ${rand}`,
      slug: `qa-dup-${rand}`,
      event_id: DEFAULT_EVENT_ID,
    });
    createdChannelIds.push(channel.id);

    const derived = await availableSlugFrom(prisma, `QA Dup ${rand}`, 'channel');
    expect(derived).toBe(`qa-dup-${rand}-2`);
  });

  it('availableSlugFrom falls back when the slugified name is too short', async () => {
    const derived = await availableSlugFrom(prisma, 'A', 'channel');
    expect(slugProblem(derived)).toBeNull();
    expect(derived.startsWith('channel')).toBe(true);
  });

  it('isSlugAvailable is cross-table: an Event slug is taken for a Channel', async () => {
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const slug = `qa-cross-${rand}`;
    const event = await prisma.event.create({ data: { name: `QA Cross ${rand}`, slug } });
    createdEventIds.push(event.id);

    expect(await isSlugAvailable(prisma, slug)).toBe(false);
    expect(await isSlugAvailable(prisma, slug, { eventId: event.id })).toBe(true);
    expect(await isSlugAvailable(prisma, slug, { channelId: 'not-this-owner' })).toBe(false);
  });

  it('isSlugAvailable is cross-table: a Channel slug is taken for an Event', async () => {
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const slug = `qa-cross-ch-${rand}`;
    const channel = await createTestChannel(prisma, {
      name: `QA Cross Channel ${rand}`,
      slug,
      event_id: DEFAULT_EVENT_ID,
    });
    createdChannelIds.push(channel.id);

    expect(await isSlugAvailable(prisma, slug)).toBe(false);
    expect(await isSlugAvailable(prisma, slug, { channelId: channel.id })).toBe(true);
    expect(await isSlugAvailable(prisma, slug, { eventId: 'not-this-owner' })).toBe(false);
  });
});
