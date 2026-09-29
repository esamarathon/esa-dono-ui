import prisma from '../../lib/prisma.js';
import {
  emitTiltifyMessage,
  emitWebhookMessage,
  type WebhookMessageType,
  type WebhookPayload,
  type WebhookTx,
} from './delivery.js';
import { wakeDispatcher } from './dispatcher.js';
import { buildTiltifyDonation, buildTiltifyTotals, type TiltifyMessage } from './tiltifyPayload.js';

/** Queues a webhook message in the surrounding transaction. */
export type EmitWebhook = (
  messageType: WebhookMessageType,
  build: () => WebhookPayload,
) => Promise<void>;

/**
 * Queues Tiltify-shaped messages (PRD-0002 §T) for TILTIFY Destinations in the
 * surrounding transaction. Each builder reads the current state inside the
 * transaction, so call it AFTER the change it describes. Both do nothing when no
 * TILTIFY Destination is active.
 */
export interface EmitTiltify {
  /** The donation as it is now (hidden or not): `<channel-slug>.donation`. No-op when unassigned. */
  donation(donationId: string): Promise<void>;
  /** The totals of a Channel and of its Event: two `<slug>.fact.updated` messages. */
  totals(channelId: string | null): Promise<void>;
}

/**
 * Transactional outbox (PRD-0002 §Q4, §Q7). Runs `fn` in one database transaction
 * with an `emit` bound to it, then — only after commit — wakes the Destinations
 * that received a message, so delivery starts at once instead of on the next
 * safety tick.
 *
 * A rollback removes the queued messages with the rest of the change; a commit
 * can never lose them. Use this at every emit site instead of calling
 * `emitWebhookMessage` directly.
 *
 * Emit after the change it describes. The transaction then already holds
 * SQLite's write lock, so concurrent callers queue behind it. A transaction whose
 * first statement is a read and which writes later can deadlock against another
 * such transaction (both hold a read lock, neither can upgrade) until Prisma's
 * timeout.
 */
export async function withWebhooks<T>(
  fn: (tx: WebhookTx, emit: EmitWebhook, tiltify: EmitTiltify) => Promise<T>,
): Promise<T> {
  const woken = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const emit: EmitWebhook = async (messageType, build) => {
      for (const id of await emitWebhookMessage(tx, messageType, build)) woken.add(id);
    };
    // Skip the (several-query) builders when nothing would receive the result.
    const tiltifyActive = async () =>
      (await tx.webhookDestination.count({
        where: { is_active: true, payload_format: 'TILTIFY' },
      })) > 0;
    const queue = async (messages: TiltifyMessage[]) => {
      for (const message of messages) {
        for (const id of await emitTiltifyMessage(tx, message)) woken.add(id);
      }
    };
    const tiltify: EmitTiltify = {
      async donation(donationId) {
        if (!(await tiltifyActive())) return;
        const message = await buildTiltifyDonation(tx, donationId);
        if (message) await queue([message]);
      },
      async totals(channelId) {
        if (!channelId || !(await tiltifyActive())) return;
        await queue(await buildTiltifyTotals(tx, channelId));
      },
    };
    return fn(tx, emit, tiltify);
  });
  for (const id of woken) wakeDispatcher(id);
  return result;
}
