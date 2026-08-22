import type { EventDelivery, EventDestination } from '@prisma/client';
import http from 'http';
import https from 'https';
import prisma from '../lib/prisma.js';
import { signPayload } from './eventDelivery.js';

const TICK_INTERVAL_MS = 15_000;
const BASE_BACKOFF_MIN = 1;
const MAX_BACKOFF_MIN = 60;
const REQUEST_TIMEOUT_MS = 10_000;

type DeliveryResult = { statusCode: number; error?: string };

function backoffMinutes(attempts: number): number {
  return Math.min(BASE_BACKOFF_MIN * Math.pow(2, attempts), MAX_BACKOFF_MIN);
}

function now(): Date {
  return new Date();
}

async function httpPost(
  url: string,
  body: string,
  secret: string,
  verifySsl: boolean,
  deliveryId: string,
  eventType: string,
): Promise<DeliveryResult> {
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
        'X-Webhook-Event': eventType,
        'X-Webhook-Delivery': deliveryId,
      },
      ...(isHttps && !verifySsl ? { rejectUnauthorized: false } : {}),
      signal: controller.signal as AbortSignal,
    };

    const req = mod.request(options, (res) => {
      clearTimeout(timeout);
      resolve({ statusCode: res.statusCode ?? 0 });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ statusCode: 0, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

const amqpCache = new Map<
  string,
  { connection: import('amqplib').ChannelModel; channel: import('amqplib').ConfirmChannel }
>();

async function amqpPublish(
  dest: EventDestination,
  deliveryId: string,
  eventType: string,
  body: string,
): Promise<DeliveryResult> {
  const url = dest.amqp_url!;
  const routingKey = dest.amqp_routing_key ?? '';

  let cached = amqpCache.get(dest.id);

  try {
    if (!cached) {
      const { connect } = await import('amqplib');
      const connection = await connect(url);
      const channel = await connection.createConfirmChannel();
      cached = { connection, channel };
      amqpCache.set(dest.id, cached);
    }

    const { channel } = cached;

    const headers: Record<string, string> = {
      'x-webhook-event': eventType,
      'x-webhook-delivery': deliveryId,
    };

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        dest.amqp_exchange || '',
        routingKey,
        Buffer.from(body),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: deliveryId,
          type: eventType,
          headers,
        },
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    return { statusCode: 200 };
  } catch (err) {
    amqpCache.delete(dest.id);
    return { statusCode: 0, error: (err as Error).message };
  }
}

async function deliver(
  delivery: EventDelivery & { destination: EventDestination },
): Promise<DeliveryResult> {
  if (delivery.destination.destination_type === 'RABBITMQ') {
    if (!delivery.destination.amqp_url || !delivery.destination.amqp_routing_key) {
      return { statusCode: 0, error: 'RabbitMQ destination missing amqp_url or amqp_routing_key' };
    }
    return amqpPublish(delivery.destination, delivery.id, delivery.event_type, delivery.payload);
  }

  return httpPost(
    delivery.destination.url,
    delivery.payload,
    delivery.destination.secret,
    delivery.destination.verify_ssl,
    delivery.id,
    delivery.event_type,
  );
}

async function processDestination(destinationId: string): Promise<void> {
  const head = await prisma.eventDelivery.findFirst({
    where: {
      destination_id: destinationId,
      status: 'PENDING',
      next_attempt_at: { lte: now() },
    },
    orderBy: { seq: 'asc' },
    include: { destination: true },
  });

  if (!head) return;

  const delivery = head as EventDelivery & { destination: EventDestination };
  const result = await deliver(delivery);

  if (result.statusCode >= 200 && result.statusCode < 300) {
    await prisma.eventDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SUCCESS',
        last_status_code: result.statusCode,
        last_error: null,
      },
    });
    return;
  }

  const newAttempts = delivery.attempts + 1;
  if (newAttempts >= delivery.max_attempts) {
    await prisma.eventDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        attempts: newAttempts,
        last_status_code: result.statusCode,
        last_error: result.error ?? null,
      },
    });
    return;
  }

  const backoffMin = backoffMinutes(newAttempts);
  await prisma.eventDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: newAttempts,
      last_status_code: result.statusCode,
      last_error: result.error ?? null,
      next_attempt_at: new Date(Date.now() + backoffMin * 60 * 1000),
    },
  });
}

export function startEventDispatcher(): NodeJS.Timeout {
  if (process.env.NODE_ENV === 'test') return { unref: () => {} } as NodeJS.Timeout;

  return setInterval(async () => {
    try {
      const activeDestinations = await prisma.eventDestination.findMany({
        where: { is_active: true },
        select: { id: true },
      });

      await Promise.all(activeDestinations.map((d) => processDestination(d.id)));
    } catch (err) {
      console.error('[eventDispatcher] tick error:', err);
    }
  }, TICK_INTERVAL_MS);
}
