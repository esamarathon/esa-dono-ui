import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { register } from '../../lib/metrics.js';
import {
  refreshBusinessMetrics,
  stopMetricsRefresh,
  startMetricsRefresh,
} from '../../services/metrics.js';

const donors: string[] = [],
  events: string[] = [],
  destinations: string[] = [];
const value = async (name: string, labels: Record<string, string> = {}) => {
  const metrics = await register.getMetricsAsJSON();
  return metrics
    .find((m) => m.name === name)
    ?.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
};
async function fixture() {
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@example.com` },
  });
  donors.push(donor.id);
  const event = await prisma.event.create({ data: { name: 'Metrics', slug: crypto.randomUUID() } });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: 'Metrics channel', slug: crypto.randomUUID(), event_id: event.id },
  });
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      event_id: event.id,
      channel_id: channel.id,
      amount_cents: 12345,
      external_id: crypto.randomUUID(),
    },
  });
  return { donor, event, channel, donation };
}
beforeEach(() => {
  register.resetMetrics();
  stopMetricsRefresh();
});
afterEach(async () => {
  stopMetricsRefresh();
  vi.restoreAllMocks();
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  donors.length = events.length = destinations.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('refreshBusinessMetrics', () => {
  it('populates DB gauges, retaining distinct unlabelled totals and slug breakdowns', async () => {
    // Other suites can retain donor accounts in the per-run database.
    await refreshBusinessMetrics();
    const donorsBefore = (await value('dono_donors_total'))!;
    const f = await fixture();
    await prisma.donation.create({
      data: {
        donor_id: f.donor.id,
        amount_cents: 300,
        status: 'REFUNDED',
        external_id: crypto.randomUUID(),
      },
    });
    await prisma.donation.create({
      data: {
        donor_id: f.donor.id,
        amount_cents: 900,
        status: 'CHARGEBACK',
        external_id: crypto.randomUUID(),
      },
    });
    await refreshBusinessMetrics();
    expect(await value('dono_donors_total')).toBe(donorsBefore + 1);
    expect(await value('dono_donated_cents_total')).toBe(12645);
    expect(await value('dono_donations_total')).toBe(3);
    expect(await value('dono_donations_unassigned')).toBe(2);
    expect(
      await value('dono_donated_cents_by_channel', {
        event: f.event.slug,
        channel: f.channel.slug,
      }),
    ).toBe(12345);
    expect(await value('dono_donated_cents_by_channel', { event: '', channel: '' })).toBe(300);
    expect(await value('dono_donations_by_channel', { event: '', channel: '' })).toBe(2);
    for (const name of ['dono_donated_cents_total', 'dono_donations_total']) {
      const gauge = (await register.getMetricsAsJSON()).find((m) => m.name === name);
      expect(gauge?.values).toHaveLength(1);
      expect(gauge?.values[0]?.labels).toEqual({});
    }
  });

  it('drops stale money and Pool series when routing changes between refreshes', async () => {
    const f = await fixture();
    await prisma.donation.update({
      where: { id: f.donation.id },
      data: { pledge_amount_cents: 12345 },
    });
    await refreshBusinessMetrics();
    expect(
      await value('dono_pool_unused_cents_by_channel', {
        channel: f.channel.slug,
        category: 'poll',
      }),
    ).toBe(12345);
    await prisma.donation.update({
      where: { id: f.donation.id },
      data: { channel_id: null, event_id: null },
    });
    await refreshBusinessMetrics();
    for (const name of [
      'dono_donated_cents_by_channel',
      'dono_donations_by_channel',
      'dono_pool_unused_cents_by_channel',
      'dono_pool_credit_cents_by_channel',
    ])
      expect(await value(name, { channel: f.channel.slug })).toBeUndefined();
    expect(await value('dono_donated_cents_by_channel', { event: '', channel: '' })).toBe(12345);
  });

  it('a scrape serves the cached value until refresh, without a database transaction', async () => {
    const f = await fixture();
    await refreshBusinessMetrics();
    await prisma.donation.update({ where: { id: f.donation.id }, data: { amount_cents: 1 } });
    const transaction = vi.spyOn(prisma, '$transaction');
    expect(await register.metrics()).toContain('dono_donated_cents_total 12345');
    expect(transaction).not.toHaveBeenCalled();
    await refreshBusinessMetrics();
    expect(await value('dono_donated_cents_total')).toBe(1);
  });

  it('keeps the previous snapshot and success time, increments the error counter and does not throw on DB failure', async () => {
    await fixture();
    await refreshBusinessMetrics();
    const timestamp = await value('dono_metrics_last_refresh_timestamp_seconds');
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('db down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(refreshBusinessMetrics()).resolves.toBeUndefined();
    expect(await value('dono_metrics_refresh_errors_total')).toBe(1);
    expect(await value('dono_donated_cents_total')).toBe(12345);
    expect(await value('dono_metrics_last_refresh_timestamp_seconds')).toBe(timestamp);
    expect(log).toHaveBeenCalled();
  });

  it('publishes legacy and new Wallet adjustment types, resetting absent types to zero', async () => {
    const f = await fixture();
    for (const type of ['REFUND', 'WALLET_REFUND', 'FAILED_PAYMENT_REFUND'])
      await prisma.balanceAdjustment.create({
        data: {
          donor_id: f.donor.id,
          type,
          amount_cents: 100,
          balance_after_cents: 100,
          created_by: 'staff',
        },
      });
    await refreshBusinessMetrics();
    for (const type of ['REFUND', 'WALLET_REFUND', 'FAILED_PAYMENT_REFUND'])
      expect(await value('dono_balance_adjustments_total', { type })).toBe(1);
    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: f.donor.id } });
    await refreshBusinessMetrics();
    expect(await value('dono_balance_adjustments_total', { type: 'FAILED_PAYMENT_REFUND' })).toBe(
      0,
    );
  });

  it('sets per-destination webhook queue gauges and clears deleted destination series', async () => {
    const d1 = await prisma.webhookDestination.create({
      data: { url: 'https://example.com', secret: 's', is_active: true },
    });
    const d2 = await prisma.webhookDestination.create({
      data: { url: '', secret: 's', destination_type: 'RABBITMQ', is_active: false },
    });
    destinations.push(d1.id, d2.id);
    const now = Date.now(),
      successAt = new Date('2026-01-01T00:00:00Z');
    for (const [seq, status] of ['PENDING', 'PENDING', 'PENDING', 'FAILED', 'SUCCESS'].entries())
      await prisma.webhookDelivery.create({
        data: {
          destination_id: d1.id,
          seq,
          message_type: 'donation.created',
          payload: '{}',
          status,
          created_at: new Date(now - 120000),
          updated_at: successAt,
        },
      });
    await refreshBusinessMetrics();
    const labels = { destination_id: d1.id };
    expect(await value('dono_webhook_queue_depth', labels)).toBe(3);
    expect(
      await value('dono_webhook_queue_oldest_pending_age_seconds', labels),
    ).toBeGreaterThanOrEqual(120);
    expect(await value('dono_webhook_queue_oldest_pending_age_seconds', labels)).toBeLessThan(125);
    expect(await value('dono_webhook_queue_failed', labels)).toBe(1);
    expect(await value('dono_webhook_destination_last_success_timestamp_seconds', labels)).toBe(
      successAt.getTime() / 1000,
    );
    expect(await value('dono_webhook_destination_active', labels)).toBe(1);
    for (const name of [
      'dono_webhook_queue_depth',
      'dono_webhook_queue_oldest_pending_age_seconds',
      'dono_webhook_queue_failed',
      'dono_webhook_destination_last_success_timestamp_seconds',
      'dono_webhook_destination_active',
    ])
      expect(await value(name, { destination_id: d2.id })).toBe(0);
    await prisma.webhookDestination.delete({ where: { id: d2.id } });
    await refreshBusinessMetrics();
    expect(await value('dono_webhook_queue_depth', { destination_id: d2.id })).toBeUndefined();
  });
});

describe('startMetricsRefresh / stopMetricsRefresh', () => {
  it('starts and stops the background loop idempotently', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const transaction = vi.spyOn(prisma, '$transaction');
    startMetricsRefresh(100000);
    startMetricsRefresh(100000);
    stopMetricsRefresh();
    stopMetricsRefresh();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    // Drain the immediate asynchronous refresh before disconnecting the test DB.
    await Promise.all(transaction.mock.results.map((r) => r.value));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
