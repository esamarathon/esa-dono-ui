/**
 * Feedback delivery — posts a user feedback submission (free-text + optional
 * screenshot) to a Discord channel via an incoming webhook. Thin, stateless
 * proxy: nothing is persisted server-side, and the webhook URL is never
 * logged.
 */

const DISCORD_TIMEOUT_MS = 10_000;

// Discord field limits (see https://discord.com/developers/docs/resources/webhook).
const CONTENT_MAX = 2000;
const EMBED_DESCRIPTION_MAX = 4096;
const FIELD_VALUE_MAX = 1024;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface FeedbackMetadata {
  url?: string;
  donorId?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  userAgent?: string;
  viewport?: string;
  cartSummary?: string;
}

export interface SendFeedbackParams {
  text: string;
  metadata: FeedbackMetadata;
  screenshot?: { buffer: Buffer; mimetype: string } | null;
}

export function isFeedbackConfigured(): boolean {
  return Boolean(process.env.DISCORD_FEEDBACK_WEBHOOK_URL);
}

/**
 * Posts the feedback to Discord. Throws an Error with a `status` property
 * (503 = not configured, 502 = Discord rejected/unreachable) so the route can
 * translate it directly into an HTTP response.
 */
export async function sendFeedbackToDiscord(params: SendFeedbackParams): Promise<void> {
  const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw Object.assign(new Error('Feedback is not configured'), { status: 503 });
  }

  const { text, metadata, screenshot } = params;

  const fields = [
    { name: 'Page', value: truncate(metadata.url || 'unknown', FIELD_VALUE_MAX), inline: false },
    {
      name: 'Donor',
      value: truncate(metadata.donorId || 'anonymous', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'Channel',
      value: truncate(metadata.channelName || metadata.channelId || 'none', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'User agent',
      value: truncate(metadata.userAgent || 'unknown', FIELD_VALUE_MAX),
      inline: false,
    },
    {
      name: 'Viewport',
      value: truncate(metadata.viewport || 'unknown', FIELD_VALUE_MAX),
      inline: true,
    },
    {
      name: 'Cart',
      value: truncate(metadata.cartSummary || 'empty', FIELD_VALUE_MAX),
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
      new Blob([screenshot.buffer], { type: screenshot.mimetype }),
      `screenshot.${extension}`,
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
