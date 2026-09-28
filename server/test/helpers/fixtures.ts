import type { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

/**
 * The migration's default Event. CI and the container test build their database
 * with `prisma db push`, which does not run migrations, so the row may be absent:
 * `ensureDefaultEvent` creates it when needed.
 */
export const DEFAULT_EVENT_ID = '00000000-0000-4000-8000-000000000001';

export async function ensureDefaultEvent(prisma: PrismaClient) {
  return prisma.event.upsert({
    where: { id: DEFAULT_EVENT_ID },
    update: {},
    create: { id: DEFAULT_EVENT_ID, name: 'Default Event', slug: 'default-event' },
  });
}

/**
 * Create a Channel with a unique name and slug on the default Event, so tests
 * that only care about a channel's identity do not collide on the unique
 * `slug` (or fail to satisfy the required `event_id`).
 */
export async function createTestChannel(
  prisma: PrismaClient,
  data: { name?: string; is_active?: boolean; event_id?: string; slug?: string } = {},
) {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  if (!data.event_id) await ensureDefaultEvent(prisma);
  return prisma.channel.create({
    data: {
      name: data.name ?? `Test Channel ${suffix}`,
      slug: data.slug ?? `test-${suffix}`,
      event_id: data.event_id ?? DEFAULT_EVENT_ID,
      ...(data.is_active === undefined ? {} : { is_active: data.is_active }),
    },
  });
}
