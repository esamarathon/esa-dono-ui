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

  it('extracts verified shipping once from counted and uncounted receipts and reports separate totals', async () => {
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
          external_id: name === 'wallet' ? `wallet-${randomUUID()}` : `cs_${randomUUID()}-${name}`,
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
      expect(dry.corrected.filter((r) => ids.includes(r.id))).toHaveLength(3);
      expect(
        (await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).total_donated,
      ).toBe(5000);
      const applied = await correctShipping(prisma, stripe, { ...bound, apply: true });
      expect(
        applied.rows
          .filter((r) => ids.includes(r.id))
          .map((r) => r.outcome)
          .sort(),
      ).toEqual(['ALREADY_RECORDED', 'CORRECTED', 'CORRECTED', 'CORRECTED', 'UNKNOWN']);
      expect(applied.corrected.filter((r) => ids.includes(r.id))).toHaveLength(3);
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).toMatchObject({
        total_donated: 4400,
        balance_remaining: 123,
      });
      expect((await financialReport(prisma)).donors.find((r) => r.id === donor.id)).toMatchObject({
        counted_cents: 4600, // Includes the still-unmigrated wallet fixture's 1000.
        received_cents: 4400, // Five cash receipts, excluding genuine wallet-only money.
        total_donated: 4400,
      });
      const again = await correctShipping(prisma, stripe, { ...bound, apply: true });
      expect(again.corrected.filter((r) => ids.includes(r.id))).toEqual([]);
      expect(await prisma.donation.findUniqueOrThrow({ where: { id: ids[2]! } })).toMatchObject({
        amount_cents: 800,
        shipping_cents: 200,
        status: 'REFUNDED',
      });
    } finally {
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });
  it.each([
    ['COMPLETED', 100],
    ['PENDING', 1000],
    ['REFUNDED', 1999],
    ['CHARGEBACK', 2001],
  ])(
    'refuses ambiguous receipt totals for %s in both dry-run and apply (recorded %i)',
    async (status, total) => {
      const donor = await prisma.donor.create({
        data: {
          email: `${randomUUID()}@example.test`,
          total_donated: Number(total),
          balance_remaining: 321,
        },
      });
      try {
        const candidate = await prisma.donation.create({
          data: {
            donor_id: donor.id,
            external_id: `cs_${randomUUID()}`,
            amount_cents: 1000,
            status: String(status),
          },
        });
        for (const [externalId, amount] of [
          [`wallet-${randomUUID()}`, 1000],
          [`wallet-external-${randomUUID()}`, 500],
          [`wallet-${randomUUID()}-wallet`, 500],
        ] as const) {
          await prisma.donation.create({
            data: { donor_id: donor.id, external_id: externalId, amount_cents: amount },
          });
        }
        const adapter: CheckoutAdapter = {
          expire: async () => {
            throw Error('not used');
          },
          retrieve: async (id) => ({
            id,
            status: 'complete',
            payment_status: 'paid',
            amount_total: 1000,
            total_details: { amount_shipping: 200 },
          }),
        };
        const beforeDonor = await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } });
        const beforeRows = await prisma.donation.findMany({
          where: { donor_id: donor.id },
          orderBy: { id: 'asc' },
        });
        expect(
          (await financialReport(prisma)).donors.find((d) => d.id === donor.id)?.received_cents,
        ).toBe(2000);
        for (const apply of [false, true]) {
          const report = await correctShipping(prisma, adapter, {
            before: new Date('2040-01-01'),
            limit: 1000,
            apply,
          });
          expect(report.rows.find((r) => r.id === candidate.id)?.outcome).toBe(
            'DONOR_TOTAL_MANUAL_REVIEW',
          );
          expect(report.corrected.filter((r) => r.id === candidate.id)).toEqual([]);
          expect(await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).toEqual(
            beforeDonor,
          );
          expect(
            await prisma.donation.findMany({
              where: { donor_id: donor.id },
              orderBy: { id: 'asc' },
            }),
          ).toEqual(beforeRows);
        }
      } finally {
        await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
        await prisma.donor.delete({ where: { id: donor.id } });
      }
    },
  );

  it('uses the same exact wallet identifier for reports, receipt exclusion and publication proof', async () => {
    const donor = await prisma.donor.create({ data: { email: `${randomUUID()}@example.test` } });
    const genuine: string[] = [];
    const cash: string[] = [];
    const corrections: Correction[] = [];
    try {
      for (const [externalId, wallet] of [
        [`wallet-${randomUUID()}`, true],
        [`wallet-${randomUUID().toUpperCase()}`, true],
        [`wallet-external-${randomUUID()}`, false],
        ['wallet-012345678-9ab-cdef-0123-456789abcdef', false],
        ['wallet-g1234567-89ab-cdef-0123-456789abcdef', false],
        [`wallet-${randomUUID()}-wallet`, false],
        [`WALLET-${randomUUID()}`, false],
      ] as const) {
        const d = await prisma.donation.create({
          data: { donor_id: donor.id, external_id: externalId, amount_cents: 1000 },
        });
        (wallet ? genuine : cash).push(d.id);
        corrections.push({
          id: d.id,
          external_id: d.external_id,
          before_cents: 1000,
          after_cents: 0,
          shipping_cents: null,
          shipping_recorded_at: null,
          kind: 'wallet',
        });
      }
      const report = await financialReport(prisma);
      expect(
        report.wallet
          .filter((r) => genuine.includes(r.id) || cash.includes(r.id))
          .map((r) => r.id)
          .sort(),
      ).toEqual(genuine.sort());
      expect(report.donors.find((r) => r.id === donor.id)).toMatchObject({
        counted_cents: 7000,
        received_cents: 5000,
      });
      // Simulate the backfill's resulting amount only to test manifest proof. The
      // populated migration suite separately proves it never zeroes these cash rows.
      await prisma.donation.updateMany({
        where: { donor_id: donor.id },
        data: { amount_cents: 0 },
      });
      for (const c of corrections) {
        for (const apply of [false, true]) {
          if (genuine.includes(c.id))
            expect((await publishCorrections(prisma, [c], apply, true)).donation_ids).toEqual([
              c.id,
            ]);
          else
            await expect(publishCorrections(prisma, [c], apply, true)).rejects.toThrow('Unproved');
        }
      }
    } finally {
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

  it.each([
    ['missing', 'UNKNOWN'],
    ['wrong-id', 'UNKNOWN'],
    ['open', 'UNKNOWN'],
    ['unpaid', 'UNKNOWN'],
    ['already-net', 'UNKNOWN'],
    ['missing-shipping', 'UNKNOWN'],
    ['fractional-shipping', 'UNKNOWN'],
    ['negative-shipping', 'UNKNOWN'],
    ['excess-shipping', 'UNKNOWN'],
    ['unknown-status', 'STATUS_MANUAL_REVIEW'],
    ['pooled', 'POOLED_MANUAL_REVIEW'],
  ])(
    'leaves %s facts unresolved without changing any receipt or donor fields',
    async (name, outcome) => {
      const donor = await prisma.donor.create({
        data: {
          email: `${randomUUID()}@example.test`,
          total_donated: name === 'already-net' ? 800 : 1000,
        },
      });
      try {
        const donation = await prisma.donation.create({
          data: {
            donor_id: donor.id,
            external_id: `cs_${randomUUID()}`,
            amount_cents: name === 'already-net' ? 800 : 1000,
            status: name === 'unknown-status' ? 'UNRECOGNIZED' : 'COMPLETED',
            pledge_amount_cents: name === 'pooled' ? 1000 : null,
          },
        });
        const adapter: CheckoutAdapter = {
          expire: async () => {
            throw Error('not used');
          },
          retrieve: async (id) => {
            if (name === 'missing') throw Error('no facts');
            return {
              id: name === 'wrong-id' ? 'cs_other' : id,
              status: name === 'open' ? 'open' : 'complete',
              payment_status: name === 'unpaid' ? 'unpaid' : 'paid',
              amount_total: 1000,
              total_details: {
                amount_shipping:
                  name === 'missing-shipping'
                    ? null
                    : name === 'fractional-shipping'
                      ? 0.5
                      : name === 'negative-shipping'
                        ? -1
                        : name === 'excess-shipping'
                          ? 1001
                          : 200,
              },
            };
          },
        };
        for (const apply of [false, true]) {
          const result = await correctShipping(prisma, adapter, {
            before: new Date('2040-01-01'),
            limit: 1000,
            apply,
          });
          expect(result.rows.find((r) => r.id === donation.id)?.outcome).toBe(outcome);
          expect(result.corrected.filter((r) => r.id === donation.id)).toEqual([]);
          expect(await prisma.donation.findUniqueOrThrow({ where: { id: donation.id } })).toEqual(
            donation,
          );
          expect(await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).toEqual(donor);
        }
      } finally {
        await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
        await prisma.donor.delete({ where: { id: donor.id } });
      }
    },
  );

  it('reports a receipt changed during provider retrieval instead of correcting it', async () => {
    const donor = await prisma.donor.create({
      data: { email: `${randomUUID()}@example.test`, total_donated: 1000 },
    });
    try {
      const donation = await prisma.donation.create({
        data: { donor_id: donor.id, external_id: `cs_${randomUUID()}`, amount_cents: 1000 },
      });
      let status = 'COMPLETED';
      const adapter: CheckoutAdapter = {
        expire: async () => {
          throw Error('not used');
        },
        retrieve: async (id) => {
          status = status === 'COMPLETED' ? 'REFUNDED' : 'COMPLETED';
          await prisma.donation.update({ where: { id: donation.id }, data: { status } });
          return {
            id,
            status: 'complete',
            payment_status: 'paid',
            amount_total: 1000,
            total_details: { amount_shipping: 200 },
          };
        },
      };
      for (const apply of [false, true]) {
        const result = await correctShipping(prisma, adapter, {
          before: new Date('2040-01-01'),
          limit: 1000,
          apply,
        });
        expect(result.rows.find((r) => r.id === donation.id)?.outcome).toBe(
          'CHANGED_MANUAL_REVIEW',
        );
        expect(result.corrected.filter((r) => r.id === donation.id)).toEqual([]);
        expect(await prisma.donation.findUniqueOrThrow({ where: { id: donation.id } })).toEqual({
          ...donation,
          status,
        });
        expect(await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } })).toEqual(donor);
      }
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
