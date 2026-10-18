import type { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';

/**
 * The migration's default Event. `test/global-setup.ts` migrates every test
 * database, so the row exists; `ensureDefaultEvent` recreates it if a test
 * deleted it.
 */
export const DEFAULT_EVENT_ID = '00000000-0000-4000-8000-000000000001';

/** Historical cart fixture: POST /pledge no longer creates this shape. */
export async function createLegacyPledge(input: {
  email?: string;
  display_name?: string;
  comment?: string;
  channel_id: string;
  top_up_cents?: number;
  items: Array<{
    kind: string;
    target_id: string;
    amount_cents?: number;
    quantity?: number;
    poll_id?: string;
    data?: unknown;
  }>;
}) {
  let total = input.top_up_cents ?? 0;
  for (const item of input.items) {
    total +=
      item.kind === 'REWARD'
        ? (await prisma.reward.findUniqueOrThrow({ where: { id: item.target_id } })).cost_cents *
          (item.quantity ?? 1)
        : (item.amount_cents ?? 0);
  }
  return prisma.pendingPledge.create({
    data: {
      format: 'LEGACY',
      pledge_token: crypto.randomUUID(),
      expires_at: new Date(Date.now() + 7200000),
      donor_email: input.email,
      comment: input.comment,
      display_name: input.display_name,
      channel_id: input.channel_id,
      total_cents: total,
      top_up_cents: input.top_up_cents ?? 0,
      items: {
        create: input.items.map((item) => ({
          ...item,
          amount_cents: item.amount_cents ?? 0,
          data: item.data ? JSON.stringify(item.data) : null,
        })),
      },
    },
  });
}

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
