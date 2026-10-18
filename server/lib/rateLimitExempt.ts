import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Client IPs that skip the global API rate limit, from `RATE_LIMIT_EXEMPT_IPS`:
 * a comma-separated list of IPv4/IPv6 addresses and CIDRs. Meant for internal
 * consumers (kollekt, the overlay) that poll the backend directly on the private
 * Docker network. Matched against `req.ip`, so it is only as trustworthy as
 * `TRUST_PROXY` (docs/deployment.md § Client IP and `TRUST_PROXY`).
 *
 * IPv4-mapped IPv6 (`::ffff:172.18.0.5`) is matched as IPv4, in entries and in
 * `req.ip`, because a dual-stack listener reports IPv4 peers in that form.
 * An invalid entry throws, so a typo fails at startup instead of exempting nothing.
 */
export function parseExemptIps(value: string | undefined): (ip: string | undefined) => boolean {
  const entries = (value ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return () => false;

  const list = new BlockList();
  for (const entry of entries) {
    const [rawAddress = '', prefixText, extra] = entry.split('/');
    const address = unmapIPv4(rawAddress);
    const type = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
    if (!type || extra !== undefined) throw invalid(entry);
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    if (!/^\d+$/.test(prefixText)) throw invalid(entry);
    let prefix = Number(prefixText);
    // A mapped CIDR (::ffff:a.b.c.d/n) covers IPv4 addresses only when n >= 96.
    if (address !== rawAddress) {
      if (prefix < 96 || prefix > 128) throw invalid(entry);
      prefix -= 96;
    }
    if (prefix > (type === 'ipv4' ? 32 : 128)) throw invalid(entry);
    list.addSubnet(address, prefix, type);
  }

  return (ip) => {
    if (!ip) return false;
    const address = unmapIPv4(ip);
    if (isIPv4(address)) return list.check(address, 'ipv4');
    if (isIPv6(address)) return list.check(address, 'ipv6');
    return false;
  };
}

function unmapIPv4(address: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return v4 && isIPv4(v4) ? v4 : address;
}

function invalid(entry: string): Error {
  return new Error(
    `RATE_LIMIT_EXEMPT_IPS: invalid entry "${entry}" (use comma-separated IPs or CIDRs, e.g. 172.18.0.5,10.0.0.0/8,fd00::/8)`,
  );
}
