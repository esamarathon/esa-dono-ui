import prisma from '../../lib/prisma.js';
import {
  emitWebhookMessage,
  type WebhookMessageType,
  type WebhookPayload,
  type WebhookTx,
} from './delivery.js';
import { wakeDispatcher } from './dispatcher.js';

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
  fn: (tx: WebhookTx, emit: EmitWebhook) => Promise<T>,
): Promise<T> {
  const woken = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const emit: EmitWebhook = async (messageType, build) => {
      for (const id of await emitWebhookMessage(tx, messageType, build)) woken.add(id);
    };
    return fn(tx, emit);
  });
  for (const id of woken) wakeDispatcher(id);
  return result;
}
