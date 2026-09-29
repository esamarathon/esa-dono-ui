import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { sendMagicLink } from './email.js';
import { TOKEN_TTL_MS } from '../config.js';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function tokenExpiryDate(): Date {
  return new Date(Date.now() + TOKEN_TTL_MS);
}

/**
 * Rotate a donor's magic token and re-send their magic link by email.
 *
 * Used by the public "request a new token" flow. Returns the donor's email
 * when a link was (re)issued, or null when nothing was done — i.e. no donor
 * exists for the address, or the donor is frozen. Callers use this to return
 * a uniform response so the endpoint cannot be used to enumerate donors.
 *
 * NOTE: this flow does NOT verify the email address — anyone can request a
 * link for any address, and the link is only usable by whoever controls the
 * inbox. Role resolution must therefore never treat a requested link as
 * verified identity (see the `email_verified` distinction for SSO).
 */
export async function requestTokenByEmail(rawEmail: string): Promise<string | null> {
  const email = rawEmail.trim().toLowerCase();
  const donor = await prisma.donor.findUnique({ where: { email } });
  if (!donor || donor.is_frozen) return null;

  const token = generateToken();
  const expiresAt = tokenExpiryDate();
  await prisma.donor.update({
    where: { id: donor.id },
    data: { magic_token: token, token_expires_at: expiresAt },
  });

  sendMagicLink(email, token).catch((err) => console.error('Email error:', err));
  return email;
}
