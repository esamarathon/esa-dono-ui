import prisma from '../../lib/prisma.js';
import {
  emitTiltifyMessage,
  emitWebhookMessage,
  type PayloadFormat,
  type WebhookMessageType,
  type WebhookPayload,
  type WebhookTx,
} from './delivery.js';
import { wakeDispatcher } from './dispatcher.js';
import type { TiltifyMessage } from './tiltifyPayload.js';
import { createDonationPublisher, type DonationPublisher } from './donationPublisher.js';

/** Queues a webhook message in the surrounding transaction. */
export type EmitWebhook = (
  messageType: WebhookMessageType,
  build: () => WebhookPayload,
) => Promise<void>;

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
  fn: (tx: WebhookTx, emit: EmitWebhook, publisher: DonationPublisher) => Promise<T>,
): Promise<T> {
  const woken = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const emit: EmitWebhook = async (messageType, build) => {
      for (const id of await emitWebhookMessage(tx, messageType, build)) woken.add(id);
    };
    // The active TILTIFY Destinations, read once per transaction. With none, the
    // (several-query) builders are skipped.
    let tiltifyTargets: Promise<string[]> | undefined;
    const targets = () =>
      (tiltifyTargets ??= tx.webhookDestination
        .findMany({
          where: { is_active: true, payload_format: 'TILTIFY' satisfies PayloadFormat },
          select: { id: true },
        })
        .then((rows) => rows.map((r) => r.id)));
    const queue = async (messages: TiltifyMessage[]) => {
      const ids = await targets();
      for (const message of messages) await emitTiltifyMessage(tx, ids, message);
      for (const id of ids) if (messages.length > 0) woken.add(id);
    };
    const publisher = createDonationPublisher(
      tx,
      emit,
      async () => (await targets()).length > 0,
      queue,
    );
    return fn(tx, emit, publisher);
  });
  for (const id of woken) wakeDispatcher(id);
  return result;
}
