import type { WebhookDestination } from '@prisma/client';

const PASSWORD_MASK = '****';

/**
 * Mask the password of an AMQP URL for display. Malformed legacy values return
 * null: an unparseable URL must never leak credentials through a response.
 */
function maskAmqpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.password) url.password = PASSWORD_MASK;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The only API projection of a Destination (#127). The signing secret and the
 * AMQP password never leave the server in this shape; create and rotate-secret
 * disclose the secret once, alongside this shape.
 */
export function toDestinationResponse(destination: WebhookDestination) {
  return {
    id: destination.id,
    url: destination.url,
    has_secret: Boolean(destination.secret),
    has_amqp_url: Boolean(destination.amqp_url),
    is_active: destination.is_active,
    event_types: JSON.parse(destination.event_types),
    verify_ssl: destination.verify_ssl,
    description: destination.description,
    destination_type: destination.destination_type,
    payload_format: destination.payload_format,
    amqp_url: maskAmqpUrl(destination.amqp_url),
    amqp_exchange: destination.amqp_exchange,
    amqp_routing_key: destination.amqp_routing_key,
    created_at: destination.created_at,
    updated_at: destination.updated_at,
  };
}

/**
 * A masked edit changes the address, not the stored password: a submitted
 * password of `****` restores the stored password (or none). The client sends
 * back the masked URL it was shown, so partial updates must not blank the
 * password. Invalid URLs throw for the route to turn into a 400.
 */
export function resolveAmqpUrlUpdate(submitted: string, stored: string | null): string {
  const url = new URL(submitted);
  if (decodeURIComponent(url.password) === PASSWORD_MASK) {
    let storedPassword = '';
    if (stored) {
      try {
        storedPassword = new URL(stored).password;
      } catch {
        // A malformed stored URL has no password worth preserving.
        storedPassword = '';
      }
    }
    url.password = storedPassword;
  }
  return url.toString();
}
