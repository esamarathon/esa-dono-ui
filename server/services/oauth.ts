export type OAuthProviderId = 'google' | 'discord' | 'twitch';

export interface OAuthUser {
  email: string;
  emailVerified: boolean;
}

const CONFIG_ENV: Record<OAuthProviderId, { id: string; secret: string }> = {
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  discord: { id: 'DISCORD_CLIENT_ID', secret: 'DISCORD_CLIENT_SECRET' },
  twitch: { id: 'TWITCH_CLIENT_ID', secret: 'TWITCH_CLIENT_SECRET' },
};

export function isOAuthProvider(value: string): value is OAuthProviderId {
  return value === 'google' || value === 'discord' || value === 'twitch';
}

export function appBaseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:5173';
}

export function getOAuthConfig(provider: OAuthProviderId): {
  clientId: string;
  clientSecret: string;
} | null {
  const env = CONFIG_ENV[provider];
  const clientId = process.env[env.id];
  const clientSecret = process.env[env.secret];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Providers with both client id and secret configured. */
export function enabledProviders(): OAuthProviderId[] {
  return (Object.keys(CONFIG_ENV) as OAuthProviderId[]).filter((p) => getOAuthConfig(p) !== null);
}

export function redirectUri(provider: OAuthProviderId): string {
  return `${appBaseUrl()}/api/auth/${provider}/callback`;
}

export function buildAuthorizeUrl(provider: OAuthProviderId, state: string): string {
  const config = getOAuthConfig(provider);
  if (!config) {
    throw Object.assign(new Error(`${provider} sign-in is not configured`), { status: 503 });
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    state,
  });

  if (provider === 'google') {
    params.set('scope', 'openid email profile');
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  if (provider === 'discord') {
    params.set('scope', 'identify email');
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }
  params.set('scope', 'user:read:email');
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}

async function exchangeToken(provider: OAuthProviderId, code: string): Promise<string> {
  const config = getOAuthConfig(provider);
  if (!config) {
    throw Object.assign(new Error(`${provider} sign-in is not configured`), { status: 503 });
  }

  const tokenUrl =
    provider === 'google'
      ? 'https://oauth2.googleapis.com/token'
      : provider === 'discord'
        ? 'https://discord.com/api/oauth2/token'
        : 'https://id.twitch.tv/oauth2/token';

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(provider),
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Token exchange failed for ${provider}`), { status: 502 });
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw Object.assign(new Error(`No access token returned by ${provider}`), { status: 502 });
  }
  return data.access_token;
}

/**
 * Exchange an authorization code for the user's email and verification status.
 *
 * Google and Discord assert the email is verified; Twitch does not expose an
 * email-verification flag, so its result is always treated as unverified.
 */
export async function exchangeCodeForUser(
  provider: OAuthProviderId,
  code: string,
): Promise<OAuthUser> {
  const accessToken = await exchangeToken(provider, code);

  if (provider === 'google') {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw Object.assign(new Error('Failed to fetch Google user info'), { status: 502 });
    }
    const u = (await res.json()) as { email?: string; email_verified?: boolean };
    if (!u.email) {
      throw Object.assign(new Error('Google did not return an email address'), { status: 502 });
    }
    return { email: u.email, emailVerified: u.email_verified === true };
  }

  if (provider === 'discord') {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw Object.assign(new Error('Failed to fetch Discord user info'), { status: 502 });
    }
    const u = (await res.json()) as { email?: string; verified?: boolean };
    if (!u.email) {
      throw Object.assign(new Error('Discord did not return an email address'), { status: 502 });
    }
    return { email: u.email, emailVerified: u.verified === true };
  }

  const config = getOAuthConfig('twitch');
  if (!config) {
    throw Object.assign(new Error('twitch sign-in is not configured'), { status: 503 });
  }
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': config.clientId },
  });
  if (!res.ok) {
    throw Object.assign(new Error('Failed to fetch Twitch user info'), { status: 502 });
  }
  const data = (await res.json()) as { data?: Array<{ email?: string }> };
  const email = data?.data?.[0]?.email;
  if (!email) {
    throw Object.assign(new Error('Twitch did not return an email address'), { status: 502 });
  }
  // Twitch no longer exposes an email verification flag — always unverified.
  return { email, emailVerified: false };
}
