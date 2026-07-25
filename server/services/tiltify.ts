interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache: Record<string, CachedToken> = {};

async function getAccessToken(scope = 'public'): Promise<string> {
  const cacheKey = scope;
  const cached = tokenCache[cacheKey];
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }
  const res = await fetch('https://v5api.tiltify.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.TILTIFY_CLIENT_ID,
      client_secret: process.env.TILTIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope,
    }),
  });
  if (!res.ok) throw new Error(`Tiltify OAuth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

export { getAccessToken };

export async function getCampaign() {
  const token = await getAccessToken();
  const res = await fetch(
    `https://v5api.tiltify.com/api/public/campaigns/${process.env.TILTIFY_CAMPAIGN_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Tiltify campaign fetch failed: ${res.status}`);
  const data = (await res.json()) as { data?: unknown };
  return data.data ?? data;
}
