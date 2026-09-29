export const ROLE = {
  USER: 'USER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

const ROLE_RANK: Record<Role, number> = {
  [ROLE.USER]: 0,
  [ROLE.MODERATOR]: 1,
  [ROLE.ADMIN]: 2,
};

function isRole(value: string): value is Role {
  return value === ROLE.USER || value === ROLE.MODERATOR || value === ROLE.ADMIN;
}

/**
 * True for MODERATOR and ADMIN (admin implies moderator access).
 */
export function hasModeratorAccess(role: string | null | undefined): boolean {
  return role === ROLE.MODERATOR || role === ROLE.ADMIN;
}

/**
 * True for ADMIN only.
 */
export function hasAdminAccess(role: string | null | undefined): boolean {
  return role === ROLE.ADMIN;
}

function parseEmailList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolves the *effective* role for a donor at request time.
 *
 * Roles are intentionally NOT granted as a side effect of donating (that
 * would let anyone "buy" admin/moderator access with a self-supplied,
 * unverified email). Instead, `ADMIN_EMAILS`/`MODERATOR_EMAILS` allowlists
 * are re-checked on every authenticated request — but only when the donor's
 * email has been independently verified (via a verified OAuth login such as
 * Google/Discord). An unverified email (e.g. the one self-supplied in Stripe
 * checkout) never earns an allowlist role, because anyone can donate using
 * someone else's address. The donor's persisted `role` (assigned explicitly
 * via the admin API) is otherwise respected.
 *
 * The result never downgrades below the donor's persisted role — env
 * allowlists can only grant, never revoke, relative to what's stored.
 *
 * @param email         the donor's email address
 * @param storedRole    the persisted role on the donor record
 * @param emailVerified whether the email has been verified via OAuth
 */
export function resolveEffectiveRole(
  email: string,
  storedRole: string,
  emailVerified: boolean,
): Role {
  const normalizedEmail = email.trim().toLowerCase();
  const stored = isRole(storedRole) ? storedRole : ROLE.USER;

  let envRole: Role = ROLE.USER;
  if (emailVerified) {
    if (parseEmailList(process.env.ADMIN_EMAILS).includes(normalizedEmail)) {
      envRole = ROLE.ADMIN;
    } else if (parseEmailList(process.env.MODERATOR_EMAILS).includes(normalizedEmail)) {
      envRole = ROLE.MODERATOR;
    }
  }

  return ROLE_RANK[envRole] > ROLE_RANK[stored] ? envRole : stored;
}
