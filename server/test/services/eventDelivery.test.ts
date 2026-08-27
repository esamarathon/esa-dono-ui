import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    eventDestination: {
      findMany: vi.fn(),
    },
    eventDestinationSeq: {
      upsert: vi.fn(),
    },
    eventDelivery: {
      create: vi.fn(),
    },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        eventDestinationSeq: {
          upsert: vi.fn().mockResolvedValue({ destination_id: 'ep-1', seq: 1 }),
        },
        eventDelivery: { create: vi.fn().mockResolvedValue({}) },
      }),
    ),
  },
}));

import prisma from '../../lib/prisma.js';
import {
  signPayload,
  buildDonationCreatedPayload,
  buildDonationModeratedPayload,
  buildIncentiveCreatedPayload,
  buildIncentiveEnabledPayload,
  buildIncentiveDisabledPayload,
  buildIncentiveValueChangedPayload,
  emitWebhookEvent,
} from '../../services/eventDelivery.js';

const FORBIDDEN_KEYS = ['email', 'donor_name', 'donor_email', 'comment', 'moderated_by'];

function findForbiddenKeys(obj: unknown, path: string[] = []): string[] {
  if (Array.isArray(obj)) {
    return obj.flatMap((item, i) => findForbiddenKeys(item, [...path, String(i)]));
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
      const forbidden = FORBIDDEN_KEYS.includes(k) ? [[...path, k].join('.')] : [];
      return [...forbidden, ...findForbiddenKeys(v, [...path, k])];
    });
  }
  return [];
}

describe('signPayload', () => {
  it('produces Stripe-style t=<ts>,v1=<sig> format', () => {
    const secret = 'test-secret';
    const timestamp = 1699999999;
    const body = '{"type":"donation.created"}';
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const result = signPayload(secret, timestamp, body);
    expect(result).toBe(`t=${timestamp},v1=${sig}`);
  });
});

describe('PII allowlist — donation.created payload', () => {
  it('contains no forbidden keys', () => {
    const payload = buildDonationCreatedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      amountCents: 1000,
      channelId: null,
      donorRef: 'donor-ref-1',
    });
    const violations = findForbiddenKeys(payload);
    expect(violations).toHaveLength(0);
  });

  it('excludes donor_name, email, and comment', () => {
    const payload = buildDonationCreatedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      amountCents: 1000,
      channelId: null,
      donorRef: 'donor-ref-1',
    });
    const keys = JSON.stringify(payload);
    FORBIDDEN_KEYS.forEach((k) => {
      expect(keys).not.toContain(k);
    });
  });
});

describe('PII allowlist — donation.moderated payload', () => {
  it('contains no forbidden keys', () => {
    const payload = buildDonationModeratedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      donorRef: 'donor-ref-1',
      moderated: true,
      moderatedAt: new Date(),
    });
    const violations = findForbiddenKeys(payload);
    expect(violations).toHaveLength(0);
  });

  it('excludes moderated_by', () => {
    const payload = buildDonationModeratedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      donorRef: 'donor-ref-1',
      moderated: true,
      moderatedAt: new Date(),
    });
    const keys = JSON.stringify(payload);
    expect(keys).not.toContain('moderated_by');
  });
});

describe('PII allowlist — incentive payloads', () => {
  it('incentive.created (REWARD) has no forbidden keys', () => {
    const payload = buildIncentiveCreatedPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      title: 'Test Reward',
      isActive: true,
      costCents: 500,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.created (POLL) has no forbidden keys', () => {
    const payload = buildIncentiveCreatedPayload({
      incentiveKind: 'POLL',
      incentiveId: 'p-1',
      title: 'Test Poll',
      isActive: true,
      endsAt: null,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.created (GOAL) has no forbidden keys', () => {
    const payload = buildIncentiveCreatedPayload({
      incentiveKind: 'GOAL',
      incentiveId: 'g-1',
      title: 'Test Goal',
      isActive: true,
      targetCents: 10000,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.enabled has no forbidden keys', () => {
    const payload = buildIncentiveEnabledPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      title: 'Test',
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.disabled has no forbidden keys', () => {
    const payload = buildIncentiveDisabledPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      title: 'Test',
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.value_changed (REWARD) has no forbidden keys', () => {
    const payload = buildIncentiveValueChangedPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      title: 'Test',
      changedFields: ['cost_cents'],
      oldCostCents: 500,
      newCostCents: 600,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });
});

describe('emitWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no endpoints are registered', async () => {
    vi.mocked(prisma.eventDestination.findMany).mockResolvedValue([]);
    const payload = buildDonationCreatedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      amountCents: 1000,
      channelId: null,
      donorRef: 'donor-ref-1',
    });
    await emitWebhookEvent('donation.created', payload);
    expect(prisma.eventDelivery.create).not.toHaveBeenCalled();
  });

  it('creates delivery rows for subscribed endpoints only', async () => {
    const ep1 = {
      id: 'ep-1',
      url: 'https://a.com/hook',
      secret: 's1',
      event_types: JSON.stringify(['donation.created']),
      is_active: true,
    };
    const ep2 = {
      id: 'ep-2',
      url: 'https://b.com/hook',
      secret: 's2',
      event_types: JSON.stringify(['incentive.created']),
      is_active: true,
    };
    vi.mocked(prisma.eventDestination.findMany).mockResolvedValue([ep1, ep2 as any]);
    vi.mocked(prisma.eventDestinationSeq.upsert).mockResolvedValue({
      destination_id: 'ep-1',
      seq: 1,
    });
    vi.mocked(prisma.eventDelivery.create).mockResolvedValue({} as any);

    const payload = buildDonationCreatedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      amountCents: 1000,
      channelId: null,
      donorRef: 'donor-ref-1',
    });
    await emitWebhookEvent('donation.created', payload);

    expect(prisma.eventDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.eventDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        destination_id: 'ep-1',
        event_type: 'donation.created',
        status: 'PENDING',
      }),
    });
  });

  it('ignores inactive endpoints', async () => {
    const findManyMock = vi.mocked(prisma.eventDestination.findMany);
    findManyMock.mockResolvedValueOnce([]);

    const payload = buildDonationCreatedPayload({
      donationId: 'dn-1',
      externalId: 'ext-1',
      amountCents: 1000,
      channelId: null,
      donorRef: 'donor-ref-1',
    });
    await emitWebhookEvent('donation.created', payload);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { is_active: true },
      }),
    );
    expect(prisma.eventDelivery.create).not.toHaveBeenCalled();
  });
});
