import crypto from 'crypto';
import type { Prisma } from '@prisma/client';

export const WEBHOOK_MESSAGE_TYPES = [
  'donation.created',
  'donation.moderated',
  'donation.hidden',
  'donation.unhidden',
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
    event_id: string | null;
    donor_ref: string;
    /** Public display name, or null. Null while the donation is hidden from the overlay. */
    donor_name: string | null;
    /** Public comment, or null. Null while the donation is hidden from the overlay. */
    donor_comment: string | null;
    hidden_from_overlay: boolean;
  };
};
/** A moderator hid a donation from the overlay, or showed it again (PRD-0002 §N2, §T5–T6). */
export type WebhookPayloadDonationVisibility = {
  id: string;
  type: 'donation.hidden' | 'donation.unhidden';
  created_at: string;
  data: {
    donation_id: string;
    external_id: string;
    channel_id: string | null;
    event_id: string | null;
    donor_ref: string;
    /** On `donation.unhidden` the public name and comment are sent again; null on `donation.hidden`. */
    donor_name: string | null;
    donor_comment: string | null;
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
    /** The Channel the incentive belongs to, or null when shared by every Channel. */
    channel_id: string | null;
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
    /** The Channel the incentive belongs to, or null when shared by every Channel. */
    channel_id: string | null;
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
    /** The Channel the incentive belongs to, or null when shared by every Channel. */
    channel_id: string | null;
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
        channel_id: string | null;
        title: string;
        changed_fields: string[];
        old_cost_cents: number;
        new_cost_cents: number;
      }
    | {
        incentive_kind: 'POLL';
        incentive_id: string;
        channel_id: string | null;
        title: string;
        changed_fields: string[];
        old_ends_at: string | null;
        new_ends_at: string | null;
      }
    | {
        incentive_kind: 'GOAL';
        incentive_id: string;
        channel_id: string | null;
        title: string;
        changed_fields: string[];
        old_target_cents: number;
        new_target_cents: number;
      };
};

export type WebhookPayload =
  | WebhookPayloadDonationCreated
  | WebhookPayloadDonationModerated
  | WebhookPayloadDonationVisibility
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
  // NATIVE Destinations only: TILTIFY ones receive Tiltify-shaped messages
  // (emitTiltifyMessage) and ignore event_types (PRD-0002 §T3).
  const destinations = await tx.webhookDestination.findMany({
    where: { is_active: true, payload_format: 'NATIVE' },
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

/**
 * Queue one Tiltify-shaped message (PRD-0002 §T) for every active TILTIFY
 * Destination, inside the caller's transaction. The routing key is per message
 * (`<slug>.donation`, `<slug>.fact.updated`), not the Destination's. Returns the
 * Destinations that received a row.
 */
export async function emitTiltifyMessage(
  tx: WebhookTx,
  message: { messageType: string; routingKey: string; payload: object },
): Promise<string[]> {
  const destinations = await tx.webhookDestination.findMany({
    where: { is_active: true, payload_format: 'TILTIFY' },
    select: { id: true },
  });
  const messageId = crypto.randomUUID();
  const body = JSON.stringify(message.payload);
  for (const { id } of destinations) {
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
        message_type: message.messageType,
        routing_key: message.routingKey,
        payload: body,
        status: 'PENDING',
        next_attempt_at: new Date(),
      },
    });
  }
  return destinations.map((d) => d.id);
}

/** The Donation fields the native donation messages need. */
export interface DonationForPayload {
  id: string;
  external_id: string;
  amount_cents: number;
  channel_id: string | null;
  event_id: string | null;
  donor_id: string;
  donor_name: string | null;
  comment: string | null;
  hidden_from_overlay: boolean;
}

/**
 * `donation.created` (PRD-0002 §N2). Carries the public display name and comment,
 * never the donor's email. A donation already hidden from the overlay sends them as
 * null, so a moderator's decision holds downstream.
 */
export function buildDonationCreatedPayload(
  donation: DonationForPayload,
): WebhookPayloadDonationCreated {
  const hidden = donation.hidden_from_overlay;
  return {
    id: crypto.randomUUID(),
    type: 'donation.created',
    created_at: new Date().toISOString(),
    data: {
      donation_id: donation.id,
      external_id: donation.external_id,
      amount_cents: donation.amount_cents,
      channel_id: donation.channel_id,
      event_id: donation.event_id,
      donor_ref: donation.donor_id,
      donor_name: hidden ? null : donation.donor_name,
      donor_comment: hidden ? null : donation.comment,
      hidden_from_overlay: hidden,
    },
  };
}

/** `donation.hidden` / `donation.unhidden`, from the donation AFTER the change. */
export function buildDonationVisibilityPayload(
  donation: DonationForPayload,
): WebhookPayloadDonationVisibility {
  const hidden = donation.hidden_from_overlay;
  return {
    id: crypto.randomUUID(),
    type: hidden ? 'donation.hidden' : 'donation.unhidden',
    created_at: new Date().toISOString(),
    data: {
      donation_id: donation.id,
      external_id: donation.external_id,
      channel_id: donation.channel_id,
      event_id: donation.event_id,
      donor_ref: donation.donor_id,
      donor_name: hidden ? null : donation.donor_name,
      donor_comment: hidden ? null : donation.comment,
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
  channelId: string | null;
  title: string;
  isActive: boolean;
  costCents?: number;
  endsAt?: Date | null;
  targetCents?: number;
}): WebhookPayloadIncentiveCreated {
  const base = {
    incentive_kind: opts.incentiveKind,
    incentive_id: opts.incentiveId,
    channel_id: opts.channelId,
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
  channelId: string | null;
  title: string;
}): WebhookPayloadIncentiveEnabled {
  return {
    id: crypto.randomUUID(),
    type: 'incentive.enabled',
    created_at: new Date().toISOString(),
    data: {
      incentive_kind: opts.incentiveKind,
      incentive_id: opts.incentiveId,
      channel_id: opts.channelId,
      title: opts.title,
    },
  };
}

export function buildIncentiveDisabledPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  channelId: string | null;
  title: string;
}): WebhookPayloadIncentiveDisabled {
  return {
    id: crypto.randomUUID(),
    type: 'incentive.disabled',
    created_at: new Date().toISOString(),
    data: {
      incentive_kind: opts.incentiveKind,
      incentive_id: opts.incentiveId,
      channel_id: opts.channelId,
      title: opts.title,
    },
  };
}

export function buildIncentiveValueChangedPayload(opts: {
  incentiveKind: 'REWARD' | 'POLL' | 'GOAL';
  incentiveId: string;
  channelId: string | null;
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
        channel_id: opts.channelId,
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
        channel_id: opts.channelId,
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
      channel_id: opts.channelId,
      title: opts.title,
      changed_fields: opts.changedFields,
      old_target_cents: opts.oldTargetCents ?? 0,
      new_target_cents: opts.newTargetCents ?? 0,
    },
  };
}
