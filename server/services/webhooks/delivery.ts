import crypto from 'crypto';
import type { Prisma } from '@prisma/client';

export const WEBHOOK_MESSAGE_TYPES = [
  'donation.created',
  'donation.moderated',
  'incentive.created',
  'incentive.enabled',
  'incentive.disabled',
  'incentive.value_changed',
] as const;

export type WebhookMessageType = (typeof WEBHOOK_MESSAGE_TYPES)[number];

export function isWebhookMessageType(value: unknown): value is WebhookMessageType {
  return (WEBHOOK_MESSAGE_TYPES as readonly unknown[]).includes(value);
}

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

export function signPayload(secret: string, timestamp: number, body: string): string {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/** A Prisma client or interactive-transaction client. Emits must use the caller's `tx`. */
export type WebhookTx = Prisma.TransactionClient;

/**
 * Queue one webhook message for every active Destination subscribed to
 * `messageType`, inside the caller's transaction (PRD-0002 §Q7): the delivery rows
 * and their per-Destination `seq` commit or roll back with the change that caused
 * them, so `seq` follows commit order.
 *
 * `build` produces the payload. If it throws, the rows are still written, as
 * FAILED with an empty payload and the error in `last_error`, instead of throwing
 * into (and rolling back) the caller's transaction (§Q2). Database errors do
 * propagate: they are part of the transaction.
 *
 * Returns the ids of the Destinations that received a row, so the caller can wake
 * them after commit. Prefer `withWebhooks()` from `./outbox.js`, which does that.
 */
export async function emitWebhookMessage(
  tx: WebhookTx,
  messageType: WebhookMessageType,
  build: () => WebhookPayload,
): Promise<string[]> {
  const destinations = await tx.webhookDestination.findMany({
    where: { is_active: true },
    select: { id: true, event_types: true },
  });
  const subscribed = destinations.filter((d) => {
    try {
      return (JSON.parse(d.event_types) as unknown[]).includes(messageType);
    } catch {
      return false;
    }
  });
  if (subscribed.length === 0) return [];

  let body = '';
  let messageId: string = crypto.randomUUID();
  let buildError: string | null = null;
  try {
    const payload = build();
    body = JSON.stringify(payload);
    messageId = payload.id;
  } catch (err) {
    buildError = `payload build failed: ${(err as Error).message}`;
    console.error(`[webhooks] ${messageType} ${buildError}`);
  }

  for (const { id } of subscribed) {
    const { seq } = await tx.webhookDestinationSeq.upsert({
      where: { destination_id: id },
      create: { destination_id: id, seq: 1 },
      update: { seq: { increment: 1 } },
    });
    await tx.webhookDelivery.create({
      data: {
        destination_id: id,
        seq,
        message_id: messageId,
        message_type: messageType,
        payload: body,
        status: buildError ? 'FAILED' : 'PENDING',
        last_error: buildError,
        next_attempt_at: new Date(),
      },
    });
  }
  return subscribed.map((d) => d.id);
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
