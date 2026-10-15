import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { captureCheckpoint, checkRollback } from '../../scripts/rollback-check.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  drainCheckouts,
  correctShipping,
  financialReport,
  publishCorrections,
  type Correction,
  type CheckoutAdapter,
} from '../../scripts/transition.js';

vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
afterAll(() => prisma.$disconnect());

describe('transition tools on real SQLite with an external Checkout adapter', () => {
  it('supports the actual predeploy schema, bounds pages and rechecks uncertain expiry on retry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'old-drain-'));
    const db = new PrismaClient({ datasourceUrl: `file:${dir}/old.db` });
    let retrieved = 0;
    const adapter: CheckoutAdapter = {
      expire: async () => {
        throw Error('lost expiry response');
      },
      retrieve: async (id) => {
        retrieved++;
        if (retrieved === 2) throw Error('retrieval uncertain too');
        return { id, status: retrieved > 2 ? 'expired' : 'open', payment_status: 'unpaid' };
      },
    };
    try {
      await db.$executeRawUnsafe(
        'CREATE TABLE PendingPledge(id TEXT, status TEXT, checkout_session_id TEXT, created_at DATETIME)',
      );
      await db.$executeRawUnsafe(
        "INSERT INTO PendingPledge VALUES ('a','OPEN','cs_a',1000),('b','OPEN','cs_b',1000),('c','FULFILLED','cs_c',1000),('d','OPEN','cs_d',9999999999999)",
      );
      const bound = { before: new Date('2030-01-01'), limit: 1, apply: true };
      expect(await drainCheckouts(db, adapter, bound)).toMatchObject({
        rows: [{ id: 'a', outcome: 'UNKNOWN' }],
        next_after: 'a',
      });
      expect(await drainCheckouts(db, adapter, bound)).toMatchObject({
        rows: [{ id: 'a', outcome: 'EXPIRED' }],
        next_after: 'a',
      });
      expect(await drainCheckouts(db, adapter, { ...bound, after: 'a' })).toMatchObject({
        rows: [{ id: 'b', outcome: 'EXPIRED' }],
        next_after: null,
      });
      expect(
        await db.$queryRawUnsafe("SELECT count(*) as count FROM PendingPledge WHERE status='OPEN'"),
      ).toEqual([{ count: 3n }]);
    } finally {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('permits restore only with a continuous freeze, reviewed migrations and an unchanged full checkpoint', async () => {
    const donor = await prisma.donor.create({ data: { email: `${randomUUID()}@example.test` } });
    try {
      const checkpoint = await captureCheckpoint(prisma, new Date('2020-01-01'));
      expect((await checkRollback(prisma, checkpoint, false, false)).decision).toBe('FIX_FORWARD');
      expect((await checkRollback(prisma, checkpoint, true, true)).decision).toBe(
        'SAFE_TO_RESTORE',
      );
      // A timestamp-less edit is invisible to created_at-only counts, but NOT to this guard.
      await prisma.$executeRaw`UPDATE Donor SET balance_remaining = 100 WHERE id = ${donor.id}`;
      expect((await checkRollback(prisma, checkpoint, true, true)).decision).toBe('FIX_FORWARD');
      const changed = await captureCheckpoint(prisma, new Date('2020-01-01'));
      await prisma.donor.delete({ where: { id: donor.id } });
      expect((await checkRollback(prisma, changed, true, true)).decision).toBe('FIX_FORWARD');
    } finally {
      await prisma.donor.deleteMany({ where: { id: donor.id } });
    }
  });

  it('requires binding acknowledgement and publishes exactly the corrected ids with totals once', async () => {
    const event = await prisma.event.create({ data: { name: 'Transition', slug: randomUUID() } });
    const donor = await prisma.donor.create({ data: { email: `${randomUUID()}@example.test` } });
    const channels = await Promise.all(
      [0, 1].map(() =>
        prisma.channel.create({
          data: { name: randomUUID(), slug: randomUUID(), event_id: event.id },
        }),
      ),
    );
    const destinations = await Promise.all(
      ['TILTIFY', 'NATIVE', 'NATIVE'].map((payload_format, i) =>
        prisma.webhookDestination.create({
          data: {
            url: 'http://127.0.0.1:1',
            secret: 'test',
            payload_format,
            event_types: i === 1 ? '["donation.updated"]' : '[]',
          },
        }),
      ),
    );
    const corrected: Correction[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await prisma.donation.create({
        data: {
          donor_id: donor.id,
          external_id: `cs_${randomUUID()}`,
          amount_cents: 800,
          channel_id: channels[i % 2]!.id,
          event_id: event.id,
          shipping_cents: 200,
          shipping_recorded_at: new Date(),
        },
      });
      if (i < 2)
        corrected.push({
          id: d.id,
          external_id: d.external_id,
          before_cents: 1000,
          after_cents: 800,
          shipping_cents: 200,
          shipping_recorded_at: d.shipping_recorded_at!.toISOString(),
          kind: 'shipping',
        });
    }
    try {
      await expect(publishCorrections(prisma, corrected, true, false)).rejects.toThrow('binding');
      await publishCorrections(prisma, corrected, false, true);
      expect(
        await prisma.webhookDelivery.count({
          where: { destination_id: { in: destinations.map((d) => d.id) } },
        }),
      ).toBe(0);
      await publishCorrections(prisma, [...corrected, corrected[0]!], true, true);
      const tilt = await prisma.webhookDelivery.findMany({
        where: { destination_id: destinations[0]!.id },
        orderBy: { seq: 'asc' },
      });
      expect(tilt).toHaveLength(5); // two donations, two Channel totals, ONE Event total
      expect(
        tilt
          .filter((d) => d.routing_key?.endsWith('.donation'))
          .map((d) => JSON.parse(d.payload).id)
          .sort(),
      ).toEqual(corrected.map((d) => d.id).sort());
      expect(
        await prisma.webhookDelivery.count({
          where: { destination_id: destinations[1]!.id, message_type: 'donation.updated' },
        }),
      ).toBe(2);
      expect(
        await prisma.webhookDelivery.count({ where: { destination_id: destinations[2]!.id } }),
      ).toBe(0);
    } finally {
      await prisma.webhookDelivery.deleteMany({
        where: { destination_id: { in: destinations.map((d) => d.id) } },
      });
      await prisma.webhookDestinationSeq.deleteMany({
        where: { destination_id: { in: destinations.map((d) => d.id) } },
      });
      await prisma.webhookDestination.deleteMany({
        where: { id: { in: destinations.map((d) => d.id) } },
      });
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
      await prisma.channel.deleteMany({ where: { event_id: event.id } });
      await prisma.event.delete({ where: { id: event.id } });
    }
  });

  it('extracts historical shipping once, corrects only known nonterminal money and reports totals', async () => {
    const donor = await prisma.donor.create({
      data: { email: `${randomUUID()}@example.test`, total_donated: 5000, balance_remaining: 123 },
    });
    const ids: string[] = [];
    for (const [name, status, shipping] of [
      ['counted', 'COMPLETED', null],
      ['pending', 'PENDING', null],
      ['terminal', 'REFUNDED', null],
      ['missing', 'COMPLETED', null],
      ['already', 'COMPLETED', 0],
      ['wallet', 'COMPLETED', null],
    ] as const) {
      const d = await prisma.donation.create({
        data: {
          donor_id: donor.id,
          external_id: `${name === 'wallet' ? 'wallet-' : 'cs_'}${randomUUID()}-${name}`,
          amount_cents: 1000,
          status,
          shipping_cents: shipping,
        },
      });
      ids.push(d.id);
    }
    // Released SQLite defaults stored text dates; Prisma writes integer milliseconds.
    await prisma.$executeRaw`UPDATE Donation SET created_at = '2020-01-01 00:00:00' WHERE id = ${ids[0]!}`;
    const stripe: CheckoutAdapter = {
      expire: async () => {
        throw Error('not used');
      },
      retrieve: async (id) => {
        if (id.endsWith('missing')) throw Error('not found');
        return {
          id,
          status: 'complete',
          payment_status: 'paid',
          amount_total: 1000,
          total_details: { amount_shipping: 200 },
        };
      },
    };
    const bound = { before: new Date('2040-01-01'), limit: 1000, apply: false };
    try {
      const dry = await correctShipping(prisma, stripe, bound);
      expect(dry.corrected.filter((r) => ids.includes(r.id))).toHaveLength(2);
      expect(
        (await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).total_donated,
      ).toBe(5000);
      const applied = await correctShipping(prisma, stripe, { ...bound, apply: true });
      expect(
        applied.rows
          .filter((r) => ids.includes(r.id))
          .map((r) => r.outcome)
          .sort(),
      ).toEqual([
        'ALREADY_RECORDED',
        'CORRECTED',
        'CORRECTED',
        'TERMINAL_MANUAL_REVIEW',
        'UNKNOWN',
      ]);
      expect(applied.corrected.filter((r) => ids.includes(r.id))).toHaveLength(2);
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).toMatchObject({
        total_donated: 4800,
        balance_remaining: 123,
      });
      expect((await financialReport(prisma)).donors.find((r) => r.id === donor.id)).toMatchObject({
        counted_cents: 4800,
        total_donated: 4800,
      });
      const again = await correctShipping(prisma, stripe, { ...bound, apply: true });
      expect(again.corrected.filter((r) => ids.includes(r.id))).toEqual([]);
      expect(await prisma.donation.findUniqueOrThrow({ where: { id: ids[2]! } })).toMatchObject({
        amount_cents: 1000,
        shipping_cents: null,
      });
    } finally {
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });
  it('rolls shipping and donor totals back together on a late database failure', async () => {
    const donor = await prisma.donor.create({
      data: { email: `${randomUUID()}@example.test`, total_donated: 2000 },
    });
    const prefix = randomUUID();
    try {
      for (const suffix of ['a', 'b'])
        await prisma.donation.create({
          data: {
            id: `${prefix}-${suffix}`,
            donor_id: donor.id,
            external_id: `cs_${prefix}-${suffix}`,
            amount_cents: 1000,
          },
        });
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER fail_transition_shipping BEFORE UPDATE ON Donation WHEN NEW.id = '${prefix}-b' BEGIN SELECT RAISE(ABORT,'late fixture failure'); END`,
      );
      const stripe: CheckoutAdapter = {
        expire: async () => {
          throw Error('not used');
        },
        retrieve: async (id) => ({
          id,
          status: 'complete',
          payment_status: 'paid',
          amount_total: 1000,
          total_details: { amount_shipping: 100 },
        }),
      };
      await expect(
        correctShipping(prisma, stripe, {
          before: new Date('2040-01-01'),
          limit: 1000,
          apply: true,
        }),
      ).rejects.toThrow();
      expect(
        await prisma.donation.findMany({
          where: { donor_id: donor.id },
          select: { amount_cents: true, shipping_cents: true },
        }),
      ).toEqual([
        { amount_cents: 1000, shipping_cents: null },
        { amount_cents: 1000, shipping_cents: null },
      ]);
      expect(
        (await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).total_donated,
      ).toBe(2000);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_transition_shipping');
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

  it('drains only bounded old OPEN sessions and retains uncertain or processing facts', async () => {
    const prefix = randomUUID();
    const ids: string[] = [];
    for (const state of ['open', 'expired', 'paid', 'unpaid', 'unknown', 'missing', 'terminal']) {
      const p = await prisma.pendingPledge.create({
        data: {
          pledge_token: `${prefix}-${state}`,
          checkout_session_id: state === 'missing' ? null : `${prefix}-${state}`,
          status: state === 'terminal' ? 'FULFILLED' : 'OPEN',
          expires_at: new Date('2030-01-01'),
        },
      });
      ids.push(p.id);
    }
    const expired = new Set<string>();
    const expire = vi.fn(async (id: string) => {
      expired.add(id);
      return { id, status: 'expired', payment_status: 'unpaid' };
    });
    const adapter: CheckoutAdapter = {
      expire,
      retrieve: async (id) => {
        if (id.endsWith('unknown')) throw Error('private transport error');
        return {
          id,
          status:
            expired.has(id) || id.endsWith('expired')
              ? 'expired'
              : id.endsWith('open')
                ? 'open'
                : 'complete',
          payment_status: id.endsWith('paid') && !id.endsWith('unpaid') ? 'paid' : 'unpaid',
        };
      },
    };
    try {
      const report = await drainCheckouts(prisma, adapter, {
        before: new Date('2040-01-01'),
        limit: 100,
        apply: false,
      });
      expect(
        report.rows
          .filter((r) => ids.includes(r.id))
          .map((r) => r.outcome)
          .sort(),
      ).toEqual(['COMPLETE_UNPAID', 'EXPIRED', 'PAID', 'UNKNOWN', 'UNKNOWN', 'WOULD_EXPIRE']);
      expect(expire).not.toHaveBeenCalled();
      const applied = await drainCheckouts(prisma, adapter, {
        before: new Date('2040-01-01'),
        limit: 100,
        apply: true,
      });
      expect(applied.rows.find((r) => r.session_id === `${prefix}-open`)?.outcome).toBe('EXPIRED');
      expect(expire).toHaveBeenCalledWith(`${prefix}-open`);
      expect(await prisma.pendingPledge.count({ where: { id: { in: ids }, status: 'OPEN' } })).toBe(
        6,
      );
    } finally {
      await prisma.pendingPledge.deleteMany({ where: { id: { in: ids } } });
    }
  });
});
