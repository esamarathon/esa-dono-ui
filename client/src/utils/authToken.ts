import client from '../api/client';

/**
 * Donor auth is held in an httpOnly session cookie the browser sends
 * automatically (ADR 0004). JS can neither read nor set the credential, so an
 * XSS payload cannot steal it. We keep a non-secret "session active" marker in
 * localStorage purely for UI state (which nav links to show); it carries no
 * credential value.
 */

const SESSION_FLAG = 'donor_session_active';

/** Extract a magic token from a pasted full magic link or a bare token value. */
export function extractToken(input: string | null | undefined): string {
  const value = (input || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    return url.searchParams.get('token') || value;
  } catch {
    return value;
  }
}

export function isSessionActive(): boolean {
  return localStorage.getItem(SESSION_FLAG) === '1';
}

function markSessionActive(): void {
  localStorage.setItem(SESSION_FLAG, '1');
  window.dispatchEvent(new Event('donor-token-changed'));
}

function markSessionInactive(): void {
  localStorage.removeItem(SESSION_FLAG);
  window.dispatchEvent(new Event('donor-token-changed'));
}

/**
 * Exchange a magic token (from a pasted link) for an httpOnly session cookie.
 * On success the credential lives only in the cookie; we just flip the marker.
 */
export async function startSession(token: string): Promise<void> {
  await client.post('/auth/session', { token });
  markSessionActive();
}

/** Log out: clear the server session cookie and the local marker. */
export async function endSession(): Promise<void> {
  try {
    await client.post('/auth/session/logout');
  } finally {
    markSessionInactive();
  }
}

/** Flip the local marker on when a session was established server-side (OAuth/magic-link redirect). */
export function noteSessionEstablished(): void {
  markSessionActive();
}

/** Clear only the local marker (e.g. after a 401 revealed the cookie is gone). */
export function clearSessionMarker(): void {
  markSessionInactive();
}
