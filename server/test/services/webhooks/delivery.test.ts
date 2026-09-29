import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../../../lib/prisma.js', () => ({
  default: {
    webhookDestination: {
      findMany: vi.fn(),
    },
    webhookDestinationSeq: {
      upsert: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn(),
    },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        webhookDestinationSeq: {
          upsert: vi.fn().mockResolvedValue({ destination_id: 'ep-1', seq: 1 }),
        },
        webhookDelivery: { create: vi.fn().mockResolvedValue({}) },
      }),
    ),
  },
}));

import prisma from '../../../lib/prisma.js';
import {
  signPayload,
  buildDonationCreatedPayload,
  buildDonationVisibilityPayload,
  buildDonationModeratedPayload,
  buildIncentiveCreatedPayload,
  buildIncentiveEnabledPayload,
  buildIncentiveDisabledPayload,
  buildIncentiveValueChangedPayload,
  emitWebhookMessage,
  isWebhookMessageType,
  WEBHOOK_MESSAGE_TYPES,
} from '../../../services/webhooks/delivery.js';

// PRD-0002 §N2: the public display name and comment may go downstream; the
// donor's email and the moderator's identity may not.
const FORBIDDEN_KEYS = ['email', 'donor_email', 'moderated_by'];

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

describe('isWebhookMessageType', () => {
  it('accepts every known message type', () => {
    expect(WEBHOOK_MESSAGE_TYPES.every(isWebhookMessageType)).toBe(true);
  });

  it('rejects unknown values and non-strings', () => {
    expect(isWebhookMessageType('donation.bogus')).toBe(false);
    expect(isWebhookMessageType('ping')).toBe(false);
    expect(isWebhookMessageType(42)).toBe(false);
  });
});

const DONATION = {
  id: 'dn-1',
  external_id: 'ext-1',
  amount_cents: 1000,
  channel_id: null,
  event_id: null,
  donor_id: 'donor-ref-1',
  donor_name: 'Public Name',
  comment: 'Public comment',
  hidden_from_overlay: false,
};

describe('PII allowlist — donation.created payload', () => {
  it('contains no forbidden keys', () => {
    const payload = buildDonationCreatedPayload(DONATION);
    const violations = findForbiddenKeys(payload);
    expect(violations).toHaveLength(0);
  });

  it('excludes email and moderator identity, keeps the public display data', () => {
    const payload = buildDonationCreatedPayload(DONATION);
    const keys = JSON.stringify(payload);
    FORBIDDEN_KEYS.forEach((k) => {
      expect(keys).not.toContain(k);
    });
    expect(payload.data).toMatchObject({
      donor_name: 'Public Name',
      donor_comment: 'Public comment',
      event_id: null,
      hidden_from_overlay: false,
    });
  });

  it('sends null name and comment for a donation already hidden from the overlay', () => {
    const payload = buildDonationCreatedPayload({ ...DONATION, hidden_from_overlay: true });
    expect(payload.data).toMatchObject({
      donor_name: null,
      donor_comment: null,
      hidden_from_overlay: true,
    });
  });
});

describe('donation.hidden / donation.unhidden payload', () => {
  it('is donation.hidden with no name or comment when hidden', () => {
    const payload = buildDonationVisibilityPayload({ ...DONATION, hidden_from_overlay: true });
    expect(payload.type).toBe('donation.hidden');
    expect(payload.data).toMatchObject({
      donation_id: 'dn-1',
      donor_name: null,
      donor_comment: null,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('is donation.unhidden with the public name and comment when shown', () => {
    const payload = buildDonationVisibilityPayload(DONATION);
    expect(payload.type).toBe('donation.unhidden');
    expect(payload.data).toMatchObject({
      donor_name: 'Public Name',
      donor_comment: 'Public comment',
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
  it('carries the incentive channel_id (PRD-0002 §N2)', () => {
    const payload = buildIncentiveEnabledPayload({
      incentiveKind: 'POLL',
      incentiveId: 'p-1',
      channelId: 'ch-1',
      title: 'Poll',
    });
    expect(payload.data.channel_id).toBe('ch-1');
  });

  it('incentive.created (REWARD) has no forbidden keys', () => {
    const payload = buildIncentiveCreatedPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      channelId: null,
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
      channelId: null,
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
      channelId: null,
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
      channelId: null,
      title: 'Test',
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.disabled has no forbidden keys', () => {
    const payload = buildIncentiveDisabledPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      channelId: null,
      title: 'Test',
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });

  it('incentive.value_changed (REWARD) has no forbidden keys', () => {
    const payload = buildIncentiveValueChangedPayload({
      incentiveKind: 'REWARD',
      incentiveId: 'r-1',
      channelId: null,
      title: 'Test',
      changedFields: ['cost_cents'],
      oldCostCents: 500,
      newCostCents: 600,
    });
    expect(findForbiddenKeys(payload)).toHaveLength(0);
  });
});

describe('emitWebhookMessage', () => {
  // The mocked prisma client stands in for the caller's transaction client.
  const tx = prisma as unknown as Parameters<typeof emitWebhookMessage>[0];
  const build = () => buildDonationCreatedPayload(DONATION);
  const ep = (id: string, types: string[]) => ({
    id,
    event_types: JSON.stringify(types),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhookDestinationSeq.upsert).mockResolvedValue({
      destination_id: 'ep-1',
      seq: 7,
    });
    vi.mocked(prisma.webhookDelivery.create).mockResolvedValue({} as any);
  });

  it('does nothing when no endpoints are registered', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([]);
    await expect(emitWebhookMessage(tx, 'donation.created', build)).resolves.toEqual([]);
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('creates delivery rows for subscribed endpoints only, and returns their ids', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([
      ep('ep-1', ['donation.created']),
      ep('ep-2', ['incentive.created']),
    ] as any);

    const ids = await emitWebhookMessage(tx, 'donation.created', build);

    expect(ids).toEqual(['ep-1']);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        destination_id: 'ep-1',
        seq: 7,
        message_type: 'donation.created',
        status: 'PENDING',
        last_error: null,
      }),
    });
  });

  it('uses the payload id as the message id, shared by every destination row', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([
      ep('ep-1', ['donation.created']),
      ep('ep-2', ['donation.created']),
    ] as any);
    const payload = build();

    await emitWebhookMessage(tx, 'donation.created', () => payload);

    const rows = vi.mocked(prisma.webhookDelivery.create).mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => r.message_id)).toEqual([payload.id, payload.id]);
    expect(rows.map((r) => r.payload)).toEqual([JSON.stringify(payload), JSON.stringify(payload)]);
  });

  it('writes FAILED rows instead of throwing when the payload cannot be built', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([
      ep('ep-1', ['donation.created']),
    ] as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      emitWebhookMessage(tx, 'donation.created', () => {
        throw new Error('no slug');
      }),
    ).resolves.toEqual(['ep-1']);

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'FAILED',
        payload: '',
        last_error: 'payload build failed: no slug',
      }),
    });
  });

  it('only queries active NATIVE destinations (TILTIFY ones get Tiltify messages, §T3)', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([]);
    await emitWebhookMessage(tx, 'donation.created', build);
    expect(prisma.webhookDestination.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true, payload_format: 'NATIVE' } }),
    );
  });
});
