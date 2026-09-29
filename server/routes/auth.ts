import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { authLimit } from '../middleware/rateLimit.js';
import prisma from '../lib/prisma.js';
import { requestTokenByEmail, generateToken, tokenExpiryDate } from '../services/auth.js';
import { setSessionCookie, clearSessionCookie } from '../lib/session.js';
import {
  isOAuthProvider,
  enabledProviders,
  buildAuthorizeUrl,
  exchangeCodeForUser,
  appBaseUrl,
} from '../services/oauth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_COOKIE = 'oauth_state';

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function redirectToWallet(res: Response, error?: string): void {
  const base = `${appBaseUrl()}/wallet`;
  res.redirect(error ? `${base}?error=${encodeURIComponent(error)}` : base);
}

/**
 * Validate a donor magic token for login. Returns the donor when the token is
 * valid, unexpired, and the account is not frozen; otherwise a reason string.
 */
async function resolveLoginToken(
  token: string,
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const donor = await prisma.donor.findUnique({ where: { magic_token: token } });
  if (!donor) return { ok: false, reason: 'Invalid or expired link.' };
  if (donor.token_expires_at && new Date() > donor.token_expires_at) {
    return { ok: false, reason: 'This link has expired. Request a fresh one.' };
  }
  if (donor.is_frozen) return { ok: false, reason: 'This account is frozen.' };
  return { ok: true, email: donor.email };
}

/**
 * POST /api/auth/request-token
 * Body: { email }
 *
 * Rotates the donor's magic token (invalidating any prior link) and emails a
 * fresh magic link. Responds uniformly for existing and unknown emails so the
 * endpoint cannot be used to enumerate donors. Rate-limited by IP.
 */
router.post('/request-token', authLimit, async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  try {
    await requestTokenByEmail(email);
  } catch (err) {
    console.error('request-token error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  res.json({ success: true });
});

/**
 * POST /api/auth/session
 * Body: { token }
 *
 * Exchanges a donor magic token (from a pasted magic link) for an httpOnly
 * session cookie, so the token never lives in JS-readable storage. Used by the
 * manual "paste your link" login path.
 */
router.post('/session', async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ error: 'A token is required' });

  const result = await resolveLoginToken(token);
  if (!result.ok) return res.status(401).json({ error: result.reason });

  setSessionCookie(res, token);
  res.json({ success: true, email: result.email });
});

/**
 * POST /api/auth/session/logout
 * Clears the session cookie. The magic token itself is not rotated (the same
 * link can be used to sign back in); use request-token to rotate it.
 */
router.post('/session/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

/**
 * GET /api/auth/magic?token=...
 * Magic-link landing target. Validates the token server-side, sets the session
 * cookie, and 302s to the wallet — so the token never reaches the SPA or the
 * browser URL/history.
 */
router.get('/magic', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return redirectToWallet(res, 'Missing sign-in link.');

  const result = await resolveLoginToken(token);
  if (!result.ok) return redirectToWallet(res, result.reason);

  setSessionCookie(res, token);
  redirectToWallet(res);
});

/**
 * GET /api/auth/providers
 * Lists the OAuth providers that are configured (client id + secret present).
 * The client uses this to decide which "sign in with X" buttons to render.
 */
router.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: enabledProviders() });
});

/**
 * GET /api/auth/:provider
 * Begins an OAuth login. Redirects the browser to the provider's authorize
 * URL, stashing a CSRF `state` in an HttpOnly SameSite=Lax cookie that the
 * callback will compare against.
 */
router.get('/:provider', (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!provider || !isOAuthProvider(provider)) {
    return res.status(404).json({ error: 'Unknown sign-in provider' });
  }

  let authorizeUrl: string;
  try {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    authorizeUrl = buildAuthorizeUrl(provider, state);
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    if (status === 503) return res.status(503).json({ error: (err as Error).message });
    throw err;
  }

  res.redirect(authorizeUrl);
});

/**
 * GET /api/auth/:provider/callback
 * OAuth redirect target. Verifies `state` against the cookie, exchanges the
 * authorization code for a verified email, upserts the donor (creating an
 * empty one on first sign-in), issues a fresh magic token, and redirects the
 * browser to the wallet with that token.
 */
router.get('/:provider/callback', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!provider || !isOAuthProvider(provider)) {
    return res.status(404).json({ error: 'Unknown sign-in provider' });
  }

  const cookieState = getCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, { path: '/' });

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';

  if (!state || !cookieState || state !== cookieState) {
    return redirectToWallet(res, 'Sign-in attempt expired or invalid. Please try again.');
  }
  if (!code) {
    return redirectToWallet(res, 'Sign-in was cancelled.');
  }

  try {
    const user = await exchangeCodeForUser(provider, code);
    const email = user.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return redirectToWallet(res, 'Sign-in provider did not return a valid email address.');
    }

    const token = generateToken();
    const expiresAt = tokenExpiryDate();

    const donor = await prisma.donor.upsert({
      where: { email },
      update: {
        magic_token: token,
        token_expires_at: expiresAt,
        // Only a verified provider (Google/Discord) may flip this on. Twitch
        // has no verification flag, so use undefined to leave any prior
        // verified status untouched rather than downgrade it.
        email_verified: user.emailVerified ? true : undefined,
      },
      create: {
        email,
        magic_token: token,
        token_expires_at: expiresAt,
        email_verified: user.emailVerified,
      },
    });

    if (donor.is_frozen) {
      return redirectToWallet(res, 'This account is frozen.');
    }

    // Set the session cookie server-side and redirect without the token in the
    // URL — it never reaches the SPA or browser history (ADR 0004).
    setSessionCookie(res, token);
    redirectToWallet(res);
  } catch (err) {
    console.error('OAuth callback error:', err);
    redirectToWallet(res, 'Sign-in failed. Please try again.');
  }
});

export default router;
