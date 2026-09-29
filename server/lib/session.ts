import type { Request, Response } from 'express';
import { TOKEN_TTL_MS } from '../config.js';

/**
 * Browser session transport (ADR 0004).
 *
 * The donor magic token is carried in an httpOnly, SameSite=Lax cookie instead
 * of a JS-readable store, so an XSS payload cannot read or exfiltrate it. The
 * cookie value *is* the magic token — no separate session table is needed, and
 * revocation still works exactly as before (rotate/null `Donor.magic_token`,
 * freeze the account, or let the token expire).
 *
 * CSRF: SameSite=Lax means the cookie is NOT sent on cross-site subrequests
 * (fetch/XHR), which is how every state-changing call (POST/PATCH/DELETE) is
 * made, so cross-site forgery of those is blocked. Cross-site top-level GET
 * navigations do carry the cookie, but no GET endpoint mutates state. The API
 * is same-origin with the SPA (nginx proxies /api), so no permissive CORS
 * widens this.
 */

export const SESSION_COOKIE = 'dono_session';

/** Secure cookies in production / behind TLS; relaxed for local http dev. */
function secureCookies(): boolean {
  return (
    process.env.NODE_ENV === 'production' || (process.env.APP_BASE_URL || '').startsWith('https://')
  );
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeMs?: number; expires?: Date } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secureCookies()) parts.push('Secure');
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  else if (opts.maxAgeMs != null) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  return parts.join('; ');
}

function appendSetCookie(res: Response, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie]);
  else res.setHeader('Set-Cookie', [String(prev), cookie]);
}

/** Set the session cookie to the donor's magic token. */
export function setSessionCookie(res: Response, token: string): void {
  appendSetCookie(res, serializeCookie(SESSION_COOKIE, token, { maxAgeMs: TOKEN_TTL_MS }));
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  appendSetCookie(res, serializeCookie(SESSION_COOKIE, '', { expires: new Date(0) }));
}

/** Read the raw session cookie (the donor magic token) from the request. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim()) || undefined;
    }
  }
  return undefined;
}
