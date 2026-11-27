/**
 * Feedback delivery — posts a user feedback submission (free-text + screenshot,
 * with the DOM snapshot attached as a second file) to a Discord channel via an
 * incoming webhook. One of two notification channels: the report row itself is
 * durable (routes/feedback.ts), so this is best-effort by design.
 *
 * Thin and stateless: nothing is persisted here, and the webhook URL is never
 * logged.
 */

import type { FeedbackMetadata } from '@dono/shared';

const DISCORD_TIMEOUT_MS = 10_000;

// Discord field limits (see https://discord.com/developers/docs/resources/webhook).
const CONTENT_MAX = 2000;
const EMBED_DESCRIPTION_MAX = 4096;
const FIELD_VALUE_MAX = 1024;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface SendFeedbackParams {
  text: string;
  metadata: FeedbackMetadata;
  screenshot?: { buffer: Buffer; mimetype: string } | null;
  snapshot?: { buffer: Buffer } | null;
  /** Client errors / failed requests in the report's diagnostics. */
  diagnosticsErrorCount?: number;
  /** Server-side user agent (from the request header), never trusted from the form. */
  userAgent?: string;
}

export function isFeedbackConfigured(): boolean {
  return Boolean(process.env.DISCORD_FEEDBACK_WEBHOOK_URL);
}

/**
 * Posts the feedback to Discord. Throws an Error with a `status` property
 * (503 = not configured, 502 = Discord rejected/unreachable) so callers can
 * distinguish the failure without it ever reaching the sender (the row is
 * already durable when this runs).
 */
export async function sendFeedbackToDiscord(params: SendFeedbackParams): Promise<void> {
  const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw Object.assign(new Error('Feedback is not configured'), { status: 503 });
  }

  const { text, metadata, screenshot, snapshot, userAgent } = params;

  const fields = [
    { name: 'Page', value: truncate(metadata.url || 'unknown', FIELD_VALUE_MAX), inline: false },
    {
      name: 'Donor',
      value: truncate(metadata.donor_id || 'anonymous', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'Channel',
      value: truncate(metadata.channel_name || metadata.channel_id || 'none', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'User agent',
      value: truncate(userAgent || 'unknown', FIELD_VALUE_MAX),
      inline: false,
    },
    {
      name: 'Viewport',
      value: truncate(metadata.viewport || 'unknown', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'Cart',
      value: truncate(metadata.cart_summary || 'empty', FIELD_VALUE_MAX),
      inline: false,
    },
  ];

  const payload = {
    content: truncate('New feedback submitted', CONTENT_MAX),
    embeds: [
      {
        description: truncate(text, EMBED_DESCRIPTION_MAX),
        timestamp: new Date().toISOString(),
        fields,
        ...(screenshot ? { image: { url: 'attachment://screenshot.jpg' } } : {}),
      },
    ],
  };

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  if (screenshot) {
    const extension = screenshot.mimetype === 'image/png' ? 'png' : 'jpg';
    form.append(
      'files[0]',
      new Blob([new Uint8Array(screenshot.buffer)], { type: screenshot.mimetype }),
      `screenshot.${extension}`,
    );
  }
  // The DOM snapshot re-renders in a browser with the real values — the
  // picture's correction when the PNG has a rendering artefact.
  if (snapshot) {
    form.append(
      'files[1]',
      new Blob([new Uint8Array(snapshot.buffer)], { type: 'text/html' }),
      'snapshot.html',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch {
    // Never log the webhook URL or raw error (may embed the URL).
    throw Object.assign(new Error('Failed to reach Discord'), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw Object.assign(new Error('Discord rejected the feedback submission'), { status: 502 });
  }
}
