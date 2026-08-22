import type { Request } from 'express';

/**
 * Single-header credential transport (ADR 0004).
 *
 * Every credential travels in `Authorization: Bearer <token>`. A namespace
 * prefix lets the server tell credential types apart without a DB probe:
 *
 *   Bearer <hex>              → donor magic token (bare, legacy-friendly)
 *   Bearer donor_<hex>        → donor magic token (explicit)
 *   Bearer key_admin_<key>    → operational admin key  (ADMIN_API_KEY)
 *   Bearer key_mod_<key>      → operational moderator key (MODERATOR_API_KEY)
 *   Bearer key_metrics_<key>  → operational metrics key (METRICS_API_KEY)
 *
 * During the deprecation window the old transports (`?token=` query param and
 * `X-Admin-Key`/`X-Moderator-Key` headers) are still honoured by the callers;
 * this module only concerns the `Authorization` header.
 */

export type Credential =
  | { kind: 'donor'; token: string }
  | { kind: 'admin-key'; key: string }
  | { kind: 'moderator-key'; key: string }
  | { kind: 'metrics-key'; key: string };

const DONOR_PREFIX = 'donor_';
const ADMIN_KEY_PREFIX = 'key_admin_';
const MOD_KEY_PREFIX = 'key_mod_';
const METRICS_KEY_PREFIX = 'key_metrics_';

/** Extract the raw Bearer value from the Authorization header, if present. */
export function bearerValue(req: Request): string | undefined {
  const header = req.headers?.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Parse the Authorization header into a typed credential. Returns null when no
 * Bearer token is present. An unknown/empty prefix falls through to a bare
 * donor token so existing magic tokens (which have no prefix) keep working.
 */
export function parseCredential(req: Request): Credential | null {
  const value = bearerValue(req);
  if (!value) return null;

  if (value.startsWith(ADMIN_KEY_PREFIX)) {
    return { kind: 'admin-key', key: value.slice(ADMIN_KEY_PREFIX.length) };
  }
  if (value.startsWith(MOD_KEY_PREFIX)) {
    return { kind: 'moderator-key', key: value.slice(MOD_KEY_PREFIX.length) };
  }
  if (value.startsWith(METRICS_KEY_PREFIX)) {
    return { kind: 'metrics-key', key: value.slice(METRICS_KEY_PREFIX.length) };
  }
  if (value.startsWith(DONOR_PREFIX)) {
    return { kind: 'donor', token: value.slice(DONOR_PREFIX.length) };
  }
  // Bare token → donor magic token (backward compatible).
  return { kind: 'donor', token: value };
}

/** The donor magic token from the Authorization header, if the credential is a donor token. */
export function bearerDonorToken(req: Request): string | undefined {
  const cred = parseCredential(req);
  return cred?.kind === 'donor' ? cred.token : undefined;
}
