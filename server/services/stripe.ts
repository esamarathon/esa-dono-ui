import Stripe from 'stripe';

/**
 * Stripe service. Wraps the Stripe SDK behind a narrow, stable interface so the
 * rest of the app does not depend on SDK details. Falls back to a degraded (no-op)
 * mode when STRIPE_SECRET_KEY is unset, so local dev and tests run without Stripe.
 */

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export interface CreateCheckoutOptions {
  pledgeToken: string;
  amountCents: number;
  email?: string | null;
  requiresShipping?: boolean;
}

export interface CreateCheckoutResult {
  id: string;
  url: string | null;
}

/**
 * Create a hosted Checkout Session for a pledge.
 * The pledge token is carried in client_reference_id and metadata for
 * deterministic linkage on the completed webhook.
 *
 * When `requiresShipping` is true, Stripe collects a shipping address and adds
 * a shipping charge via the ShippingRate referenced by STRIPE_SHIPPING_RATE_ID.
 * This forces the physical-item cart through Checkout even when wallet balance
 * would otherwise cover the pledge, so a shipping address is always captured.
 */
export async function createCheckoutSession({
  pledgeToken,
  amountCents,
  email,
  requiresShipping = false,
}: CreateCheckoutOptions): Promise<CreateCheckoutResult> {
  const stripe = getStripe();
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  const currency = process.env.STRIPE_CURRENCY || 'usd';
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
  const shippingRateId = process.env.STRIPE_SHIPPING_RATE_ID || '';
  const allowedCountries = (process.env.STRIPE_SHIPPING_ALLOWED_COUNTRIES || 'US')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: { name: 'Donation' },
        },
      },
    ],
    client_reference_id: pledgeToken,
    metadata: { pledge_token: pledgeToken },
    customer_email: email || undefined,
    success_url: `${baseUrl}/pledge/${pledgeToken}`,
    cancel_url: `${baseUrl}/pledge/${pledgeToken}`,
    ...(requiresShipping
      ? {
          shipping_address_collection: { allowed_countries: allowedCountries },
          shipping_options: shippingRateId ? [{ shipping_rate: shippingRateId }] : undefined,
        }
      : {}),
  });

  return { id: session.id, url: session.url };
}

export interface CreateAuctionCheckoutOptions {
  amountCents: number;
  email: string;
  requiresShipping?: boolean;
  expiresAt: Date;
  metadata: Record<string, string>;
}

/**
 * Create a Checkout Session for a single step of an auction's payment
 * cascade. Unlike the donation/pledge flow, there is no pledge_token — the
 * session is linked back to the auction purely via `metadata.auction_id`,
 * read by the webhook on both `checkout.session.completed` (settlement) and
 * `checkout.session.expired` (cascade advance).
 *
 * `requiresShipping` mirrors the pledge flow's PHYSICAL-item handling:
 * Stripe collects the shipping address natively on its own hosted page and
 * charges the configured shipping rate — the address never reaches this
 * application or its database.
 */
export async function createAuctionCheckoutSession({
  amountCents,
  email,
  requiresShipping = false,
  expiresAt,
  metadata,
}: CreateAuctionCheckoutOptions): Promise<CreateCheckoutResult> {
  const stripe = getStripe();
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  const currency = process.env.STRIPE_CURRENCY || 'usd';
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
  const shippingRateId = process.env.STRIPE_SHIPPING_RATE_ID || '';
  const allowedCountries = (process.env.STRIPE_SHIPPING_ALLOWED_COUNTRIES || 'US')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  // Stripe caps Checkout Session expires_at at 24h out and requires at
  // least 30 minutes; clamp defensively in case a caller passes something
  // outside that window.
  const nowSec = Math.floor(Date.now() / 1000);
  const requestedSec = Math.floor(expiresAt.getTime() / 1000);
  const expiresAtSec = Math.min(Math.max(requestedSec, nowSec + 1800), nowSec + 86_400);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: { name: 'Auction winning bid' },
        },
      },
    ],
    metadata,
    customer_email: email,
    expires_at: expiresAtSec,
    success_url: `${baseUrl}/`,
    cancel_url: `${baseUrl}/`,
    ...(requiresShipping
      ? {
          shipping_address_collection: { allowed_countries: allowedCountries },
          shipping_options: shippingRateId ? [{ shipping_rate: shippingRateId }] : undefined,
        }
      : {}),
  });

  return { id: session.id, url: session.url };
}

/**
 * Verify an inbound Stripe webhook signature. Returns the parsed event.
 * When STRIPE_WEBHOOK_SECRET is unset, verification is skipped and the raw body
 * is parsed directly (local/test escape hatch).
 */
export async function verifyWebhook(
  rawBody: Buffer,
  signature: string | string[] | undefined,
): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripe();
  if (secret && stripe) {
    return stripe.webhooks.constructEvent(
      rawBody,
      typeof signature === 'string' ? signature : '',
      secret,
    );
  }
  return JSON.parse(rawBody.toString()) as Stripe.Event;
}

/**
 * True when Stripe is configured (a secret key is present). Used to decide
 * whether a checkout flow can proceed or must degrade.
 */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
