import crypto from 'crypto';
import prisma from '../lib/prisma.js';

export const WEBHOOK_EVENT_TYPES = [
  'donation.created',
  'donation.moderated',
  'incentive.created',
  'incentive.enabled',
  'incentive.disabled',
  'incentive.value_changed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type WebhookPayloadDonationCreated = {
  id: string;
  type: 'donation.created';
  created_at: string;
  data: {
    donation_id: string;
    external_id: string;
    amount_cents: number;
    channel_id: string | null;
    donor_ref: string;
  };
};

export type WebhookPayloadDonationModerated = {
  id: string;
  type: 'donation.moderated';
  created_at: string;
  data: {
    donation_id: string;
    external_id: string;
    donor_ref: string;
    moderated: boolean;
    moderated_at: string | null;
  };
};

export type WebhookPayloadIncentiveCreated = {
  id: string;
  type: 'incentive.created';
  created_at: string;
  data: {
    incentive_kind: 'REWARD' | 'POLL' | 'GOAL';
    incentive_id: string;
    title: string;
    is_active: boolean;
  } & (
    | { incentive_kind: 'REWARD'; cost_cents: number }
    | { incentive_kind: 'POLL'; ends_at: string | null }
    | { incentive_kind: 'GOAL'; target_cents: number }
  );
};

export type WebhookPayloadIncentiveEnabled = {
  id: string;
  type: 'incentive.enabled';
  created_at: string;
  data: {
    incentive_kind: 'REWARD' | 'POLL' | 'GOAL';
    incentive_id: string;
    title: string;
  };
};

export type WebhookPayloadIncentiveDisabled = {
  id: string;
  type: 'incentive.disabled';
  created_at: string;
  data: {
    incentive_kind: 'REWARD' | 'POLL' | 'GOAL';
    incentive_id: string;
    title: string;
  };
};

export type WebhookPayloadIncentiveValueChanged = {
  id: string;
  type: 'incentive.value_changed';
  created_at: string;
  data:
    | {
        incentive_kind: 'REWARD';
        incentive_id: string;
        title: string;
        changed_fields: string[];
        old_cost_cents: number;
        new_cost_cents: number;
      }
    | {
        incentive_kind: 'POLL';
        incentive_id: string;
        title: string;
        changed_fields: string[];
        old_ends_at: string | null;
        new_ends_at: string | null;
      }
    | {
        incentive_kind: 'GOAL';
        incentive_id: string;
        title: string;
        changed_fields: string[];
        old_target_cents: number;
        new_target_cents: number;
      };
};

export type WebhookPayload =
  | WebhookPayloadDonationCreated
  | WebhookPayloadDonationModerated
  | WebhookPayloadIncentiveCreated
  | WebhookPayloadIncentiveEnabled
  | WebhookPayloadIncentiveDisabled
  | WebhookPayloadIncentiveValueChanged;

function nextSeq(endpointId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.eventDestinationSeq.upsert({
      where: { destination_id: endpointId },
      create: { destination_id: endpointId, seq: 1 },
      update: { seq: { increment: 1 } },
    });
    return row.seq;
  });
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

async function insertDeliveries(
  endpointIds: string[],
  eventType: WebhookEventType,
  payload: object,
): Promise<void> {
  const body = JSON.stringify(payload);
  await Promise.all(
    endpointIds.map(async (endpointId) => {
      const seq = await nextSeq(endpointId);
      await prisma.eventDelivery.create({
        data: {
          destination_id: endpointId,
          seq,
          event_type: eventType,
          payload: body,
          status: 'PENDING',
          next_attempt_at: new Date(),
        },
      });
    }),
  );
}

export async function emitWebhookEvent(
  eventType: WebhookEventType,
  payload:
    | WebhookPayloadDonationCreated
    | WebhookPayloadDonationModerated
    | WebhookPayloadIncentiveCreated
    | WebhookPayloadIncentiveEnabled
    | WebhookPayloadIncentiveDisabled
    | WebhookPayloadIncentiveValueChanged,
): Promise<void> {
  try {
    const endpoints = await prisma.eventDestination.findMany({
      where: {
        is_active: true,
      },
    });

    const subscribed = endpoints.filter((ep) => {
      try {
        const types: string[] = JSON.parse(ep.event_types);
        return types.includes(eventType);
      } catch {
        return false;
      }
    });

    if (subscribed.length === 0) return;

    await insertDeliveries(
      subscribed.map((ep) => ep.id),
      eventType,
      payload,
    );
  } catch (err) {
    console.error('[webhooks] emit error:', err);
  }
}

export function buildDonationCreatedPayload(opts: {
  donationId: string;
  externalId: string;
  amountCents: number;
  channelId: string | null;
  donorRef: string;
}): WebhookPayloadDonationCreated {
  return {
    id: crypto.randomUUID(),
    type: 'donation.created',
    created_at: new Date().toISOString(),
    data: {
      donation_id: opts.donationId,
      external_id: opts.externalId,
      amount_cents: opts.amountCents,
      channel_id: opts.channelId,
      donor_ref: opts.donorRef,
    },
  };
}

export function buildDonationModeratedPayload(opts: {
  donationId: string;
  externalId: string;
  donorRef: string;
  moderated: boolean;
  moderatedAt: Date | null;
}): WebhookPayloadDonationModerated {
  return {
    id: crypto.randomUUID(),
    type: 'donation.moderated',
    created_at: new Date().toISOString(),
    data: {
      donation_id: opts.donationId,
      external_id: opts.externalId,
      donor_ref: opts.donorRef,
      moderated: opts.moderated,
      moderated_at: opts.moderatedAt?.toISOString() ?? null,
    },
  };
}

export function buildIncentiveCreatedPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  title: string;
  isActive: boolean;
  costCents?: number;
  endsAt?: Date | null;
  targetCents?: number;
}): WebhookPayloadIncentiveCreated {
  const base = {
    incentive_kind: opts.incentiveKind,
    incentive_id: opts.incentiveId,
    title: opts.title,
    is_active: opts.isActive,
  };
  if (opts.incentiveKind === 'REWARD') {
    return {
      id: crypto.randomUUID(),
      type: 'incentive.created',
      created_at: new Date().toISOString(),
      data: { ...base, incentive_kind: 'REWARD', cost_cents: opts.costCents ?? 0 },
    };
  }
  if (opts.incentiveKind === 'POLL') {
    return {
      id: crypto.randomUUID(),
      type: 'incentive.created',
      created_at: new Date().toISOString(),
      data: { ...base, incentive_kind: 'POLL', ends_at: opts.endsAt?.toISOString() ?? null },
    };
  }
  return {
    id: crypto.randomUUID(),
    type: 'incentive.created',
    created_at: new Date().toISOString(),
    data: { ...base, incentive_kind: 'GOAL', target_cents: opts.targetCents ?? 0 },
  };
}

export function buildIncentiveEnabledPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  title: string;
}): WebhookPayloadIncentiveEnabled {
  return {
    id: crypto.randomUUID(),
    type: 'incentive.enabled',
    created_at: new Date().toISOString(),
    data: {
      incentive_kind: opts.incentiveKind,
      incentive_id: opts.incentiveId,
      title: opts.title,
    },
  };
}

export function buildIncentiveDisabledPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  title: string;
}): WebhookPayloadIncentiveDisabled {
  return {
    id: crypto.randomUUID(),
    type: 'incentive.disabled',
    created_at: new Date().toISOString(),
    data: {
      incentive_kind: opts.incentiveKind,
      incentive_id: opts.incentiveId,
      title: opts.title,
    },
  };
}

export function buildIncentiveValueChangedPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  title: string;
  changedFields: string[];
  oldCostCents?: number;
  newCostCents?: number;
  oldEndsAt?: Date | null;
  newEndsAt?: Date | null;
  oldTargetCents?: number;
  newTargetCents?: number;
}): WebhookPayloadIncentiveValueChanged {
  if (opts.incentiveKind === 'REWARD') {
    return {
      id: crypto.randomUUID(),
      type: 'incentive.value_changed',
      created_at: new Date().toISOString(),
      data: {
        incentive_kind: 'REWARD' as const,
        incentive_id: opts.incentiveId,
        title: opts.title,
        changed_fields: opts.changedFields,
        old_cost_cents: opts.oldCostCents ?? 0,
        new_cost_cents: opts.newCostCents ?? 0,
      },
    };
  }
  if (opts.incentiveKind === 'POLL') {
    return {
      id: crypto.randomUUID(),
      type: 'incentive.value_changed',
      created_at: new Date().toISOString(),
      data: {
        incentive_kind: 'POLL' as const,
        incentive_id: opts.incentiveId,
        title: opts.title,
        changed_fields: opts.changedFields,
        old_ends_at: opts.oldEndsAt?.toISOString() ?? null,
        new_ends_at: opts.newEndsAt?.toISOString() ?? null,
      },
    };
  }
  return {
    id: crypto.randomUUID(),
    type: 'incentive.value_changed',
    created_at: new Date().toISOString(),
    data: {
      incentive_kind: 'GOAL' as const,
      incentive_id: opts.incentiveId,
      title: opts.title,
      changed_fields: opts.changedFields,
      old_target_cents: opts.oldTargetCents ?? 0,
      new_target_cents: opts.newTargetCents ?? 0,
    },
  };
}
