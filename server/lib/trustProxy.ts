/**
 * Express `trust proxy` from `TRUST_PROXY` (#140): how many reverse proxies sit in
 * front of Express. `req.ip`, and so every per-IP rate limit, is the address that
 * many hops back in `X-Forwarded-For`. Too low, and every client shares the proxy's
 * address (one rate-limit bucket for everyone); too high, and a client can spoof
 * its IP with its own `X-Forwarded-For`.
 *
 * - unset: `1` (the nginx frontend container only);
 * - a number: that many hops, e.g. `2` behind Caddy + nginx;
 * - anything else is passed to Express as-is (`loopback`, a CIDR list, `true`, `false`).
 */
export function trustProxySetting(value: string | undefined): number | boolean | string {
  const v = value?.trim();
  if (!v) return 1;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}
