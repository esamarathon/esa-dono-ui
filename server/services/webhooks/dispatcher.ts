import type { WebhookDelivery, WebhookDestination } from '@prisma/client';
import http from 'http';
import https from 'https';
import prisma from '../../lib/prisma.js';
import { signPayload } from './delivery.js';

/** Retry delays in seconds, indexed by attempt count after the failure (1-based). */
export const BACKOFF_SECONDS = [5, 15, 60, 180] as const;

/** Safety-net wake interval for destinations missed by an explicit wake. */
export const SAFETY_TICK_MS = 5_000;

/** Retention sweep interval. */
export const RETENTION_SWEEP_MS = 60_000;

/** SUCCESS rows are deleted after this age (PRD-0002 §Q10). */
export const SUCCESS_RETENTION_MS = 2 * 60 * 60 * 1000;

/** FAILED rows are deleted after this age (PRD-0002 §Q10). */
export const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

/** AMQP connection-establishment timeout (TCP connect + handshake). */
const AMQP_CONNECT_TIMEOUT_MS = 10_000;

type DeliveryWithDestination = WebhookDelivery & { destination: WebhookDestination };

/** Result of one delivery attempt; `ok` distinguishes success from endpoint failure. */
type AttemptResult = { ok: boolean; statusCode: number; error?: string };

/** Delay before retry number `attempts` (attempts counted AFTER the failure: 1 = first failure). */
export function backoffSeconds(attempts: number): number {
  if (attempts <= 0) return 5;
  const index = Math.min(attempts, BACKOFF_SECONDS.length) - 1;
  return BACKOFF_SECONDS[index] ?? 180;
}

async function httpPost(
  url: string,
  body: string,
  secret: string,
  verifySsl: boolean,
  deliveryId: string,
  messageType: string,
): Promise<AttemptResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, timestamp, body);

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': messageType,
        'X-Webhook-Delivery': deliveryId,
      },
      ...(isHttps && !verifySsl ? { rejectUnauthorized: false } : {}),
      signal: controller.signal as AbortSignal,
    };

    const req = mod.request(options, (res) => {
      clearTimeout(timeout);
      const statusCode = res.statusCode ?? 0;
      resolve({ ok: statusCode >= 200 && statusCode < 300, statusCode });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, statusCode: 0, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

type AmqpEntry = {
  connection: import('amqplib').ChannelModel;
  channel: import('amqplib').ConfirmChannel;
  /** The TILTIFY exchange was declared on this connection. */
  exchangeAsserted?: boolean;
};

const amqpCache = new Map<string, AmqpEntry>();

/** Publisher-confirm timeout in milliseconds, read at call time so tests can override it. */
function amqpConfirmTimeoutMs(): number {
  return Number(process.env.WEBHOOK_AMQP_CONFIRM_TIMEOUT_MS) || 10_000;
}

/** Add the 30 s heartbeat query parameter unless the URL already sets one. */
function withHeartbeat(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('heartbeat')) parsed.searchParams.set('heartbeat', '30');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Evict the cached AMQP entry when its connection or channel errors or closes. */
function registerAmqpEviction(destinationId: string, entry: AmqpEntry): void {
  const evict = (): void => {
    if (amqpCache.get(destinationId) === entry) amqpCache.delete(destinationId);
  };
  const onError = (err: unknown): void => {
    console.error('[webhookDispatcher] AMQP error:', err);
    evict();
  };
  entry.connection.on('error', onError);
  entry.connection.on('close', evict);
  entry.channel.on('error', onError);
  entry.channel.on('close', evict);
}

async function amqpPublish(
  dest: WebhookDestination,
  deliveryId: string,
  messageId: string,
  messageType: string,
  body: string,
  routingKey: string,
): Promise<AttemptResult> {
  const url = withHeartbeat(dest.amqp_url!);
  const tiltify = dest.payload_format === 'TILTIFY';
  // The Tiltify consumers read the `tiltify` exchange (PRD-0002 §T3).
  const exchange = dest.amqp_exchange || (tiltify ? 'tiltify' : '');

  let cached = amqpCache.get(dest.id);

  try {
    if (!cached) {
      const { connect } = await import('amqplib');
      // Without a connect timeout, an unreachable broker host hangs until the OS
      // TCP timeout (~2 min) while holding this destination's drain.
      const connection = await connect(url, { timeout: AMQP_CONNECT_TIMEOUT_MS });
      const channel = await connection.createConfirmChannel();
      cached = { connection, channel };
      amqpCache.set(dest.id, cached);
      registerAmqpEviction(dest.id, cached);
    }

    const { channel } = cached;

    // TILTIFY consumers declare the exchange as `topic, durable, autoDelete`
    // (PRD-0002 §T3). Declaring it the same way first surfaces a mismatch as
    // PRECONDITION_FAILED (an endpoint failure, retried) instead of publishing into
    // an exchange of the wrong type. Once per connection.
    if (tiltify && !cached.exchangeAsserted) {
      await channel.assertExchange(exchange, 'topic', {
        durable: true,
        autoDelete: true,
      });
      cached.exchangeAsserted = true;
    }

    const headers: Record<string, string> = {
      'x-webhook-event': messageType,
      'x-webhook-delivery': deliveryId,
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), amqpConfirmTimeoutMs());
    });

    try {
      const outcome = await Promise.race([
        new Promise<'confirmed'>((resolve, reject) => {
          channel.publish(
            exchange,
            routingKey,
            Buffer.from(body),
            {
              persistent: true,
              contentType: 'application/json',
              messageId,
              type: messageType,
              headers,
            },
            (err: Error | null) => {
              if (err) reject(err);
              else resolve('confirmed');
            },
          );
        }),
        timeout,
      ]);

      if (outcome === 'timeout') {
        amqpCache.delete(dest.id);
        await cached.connection.close().catch(() => {});
        return { ok: false, statusCode: 0, error: 'AMQP publish confirm timed out' };
      }

      return { ok: true, statusCode: 200 };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // A failed connect/publish/confirm leaves the connection unusable: drop and
    // close it so the next attempt reconnects instead of leaking a socket.
    if (cached && amqpCache.get(dest.id) === cached) amqpCache.delete(dest.id);
    await cached?.connection.close().catch(() => {});
    return { ok: false, statusCode: 0, error: (err as Error).message };
  }
}

async function deliver(delivery: DeliveryWithDestination): Promise<AttemptResult> {
  if (delivery.destination.destination_type === 'RABBITMQ') {
    // A TILTIFY message carries its own routing key; a NATIVE one uses the Destination's.
    const routingKey = delivery.routing_key ?? delivery.destination.amqp_routing_key;
    if (!delivery.destination.amqp_url || !routingKey) {
      return {
        ok: false,
        statusCode: 0,
        error: 'RabbitMQ destination missing amqp_url or amqp_routing_key',
      };
    }
    return amqpPublish(
      delivery.destination,
      delivery.id,
      delivery.message_id,
      delivery.message_type,
      delivery.payload,
      routingKey,
    );
  }

  return httpPost(
    delivery.destination.url,
    delivery.payload,
    delivery.destination.secret,
    delivery.destination.verify_ssl,
    delivery.id,
    delivery.message_type,
  );
}

/** Detect a message-class failure without contacting the endpoint (PRD-0002 §Q2). */
function messageFailureReason(payload: string): string | null {
  if (payload === '') return 'payload is empty (never built)';
  try {
    JSON.parse(payload);
    return null;
  } catch {
    return 'payload is not valid JSON';
  }
}

/** Send due heads for one destination in `seq` order until the queue stalls or empties. */
async function drainOnce(destinationId: string): Promise<void> {
  for (;;) {
    const head = await prisma.webhookDelivery.findFirst({
      where: { destination_id: destinationId, status: 'PENDING' },
      orderBy: { seq: 'asc' },
      include: { destination: true },
    });

    if (!head) return;

    const delivery: DeliveryWithDestination = head;
    if (!delivery.destination.is_active) return;
    if (delivery.next_attempt_at.getTime() > Date.now()) return;

    const reason = messageFailureReason(delivery.payload);
    if (reason) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          attempts: delivery.attempts + 1,
          last_status_code: null,
          last_error: reason,
        },
      });
      continue;
    }

    const result = await deliver(delivery);
    if (result.ok) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SUCCESS',
          attempts: delivery.attempts + 1,
          last_status_code: result.statusCode,
          last_error: null,
        },
      });
      continue;
    }

    const attempts = delivery.attempts + 1;
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PENDING',
        attempts,
        last_status_code: result.statusCode,
        last_error: result.error ?? null,
        next_attempt_at: new Date(Date.now() + backoffSeconds(attempts) * 1000),
      },
    });
    return;
  }
}

const inflight = new Map<string, Promise<void>>();
const rerun = new Set<string>();

/** Drain one destination, single-flight; a wake during a drain schedules one more pass. */
export function drainDestination(destinationId: string): Promise<void> {
  const existing = inflight.get(destinationId);
  if (existing) {
    rerun.add(destinationId);
    return existing;
  }

  const p = (async () => {
    try {
      do {
        rerun.delete(destinationId);
        await drainOnce(destinationId);
      } while (rerun.has(destinationId));
    } finally {
      inflight.delete(destinationId);
    }
  })();

  inflight.set(destinationId, p);
  return p;
}

function logDrainError(err: unknown): void {
  console.error('[webhookDispatcher] drain error:', err);
}

/** Wake one destination, or every active destination, without awaiting or throwing. */
export function wakeDispatcher(destinationId?: string): void {
  if (destinationId) {
    drainDestination(destinationId).catch(logDrainError);
    return;
  }

  prisma.webhookDestination
    .findMany({ where: { is_active: true }, select: { id: true } })
    .then((destinations) => {
      for (const destination of destinations) wakeDispatcher(destination.id);
    })
    .catch(logDrainError);
}

/** Delete delivered rows past retention. `PENDING` rows are never deleted. */
export async function sweepRetention(
  now = new Date(),
): Promise<{ success: number; failed: number }> {
  const success = await prisma.webhookDelivery.deleteMany({
    where: {
      status: 'SUCCESS',
      updated_at: { lt: new Date(now.getTime() - SUCCESS_RETENTION_MS) },
    },
  });
  const failed = await prisma.webhookDelivery.deleteMany({
    where: {
      status: 'FAILED',
      updated_at: { lt: new Date(now.getTime() - FAILED_RETENTION_MS) },
    },
  });
  return { success: success.count, failed: failed.count };
}

/** Start the safety-net wake interval and the retention sweep; returns a stop handle. */
export function startWebhookDispatcher(): { stop(): void } {
  if (process.env.NODE_ENV === 'test') return { stop() {} };

  wakeDispatcher();

  const safety = setInterval(() => wakeDispatcher(), SAFETY_TICK_MS);
  safety.unref();

  const retention = setInterval(() => {
    sweepRetention().catch((err) => console.error('[webhookDispatcher] retention error:', err));
  }, RETENTION_SWEEP_MS);
  retention.unref();

  return {
    stop(): void {
      clearInterval(safety);
      clearInterval(retention);
    },
  };
}
