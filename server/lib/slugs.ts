import type { Prisma } from '@prisma/client';

/**
 * Slugs name an Event or a Channel in URLs (`/donate/<event>/<channel>`) and in
 * AMQP routing keys (`<slug>.donation`). PRD-0002 §S6, ADR-0008.
 *
 * Lowercase letters and digits in hyphen-separated groups. No dot: it is the AMQP
 * topic separator, and kollekt binds `*.donation`, where `*` is exactly one word.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 64;

/**
 * Top-level client routes and server paths, so a slug can never shadow a page or
 * an endpoint if slugs are later used at the root of a URL.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'auctions',
  'docs',
  'donate',
  'goals',
  'health',
  'help',
  'metrics',
  'moderate',
  'pledge',
  'polls',
  'rewards',
  'traces',
  'uploads',
  'wallet',
]);

/** Why `slug` is not a valid slug, or null if it is. Does not check uniqueness. */
export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string') return 'slug must be a string';
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return `slug must be ${SLUG_MIN_LENGTH}-${SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'slug may contain only lowercase letters, digits and single hyphens between them';
  }
  if (RESERVED_SLUGS.has(slug)) return `slug "${slug}" is reserved`;
  return null;
}

/**
 * Best-effort slug from a display name ("ESA Summer 2025 – Stream 1" →
 * "esa-summer-2025-stream-1"). The result may still be too short or reserved;
 * `availableSlugFrom` makes it usable.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

type SlugDb = Pick<Prisma.TransactionClient, 'event' | 'channel'>;
type SlugOwner = { eventId?: string; channelId?: string };

/** True if no Event or Channel other than `owner` uses `slug`. */
export async function isSlugAvailable(
  db: SlugDb,
  slug: string,
  owner: SlugOwner = {},
): Promise<boolean> {
  const [event, channel] = await Promise.all([
    db.event.findUnique({ where: { slug }, select: { id: true } }),
    db.channel.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  return (!event || event.id === owner.eventId) && (!channel || channel.id === owner.channelId);
}

/**
 * A valid, unused slug derived from `name`: the slugified name, or with `-2`, `-3`…
 * appended. Falls back to `fallbackPrefix` when the name has too few usable
 * characters or is reserved.
 */
export async function availableSlugFrom(
  db: SlugDb,
  name: string,
  fallbackPrefix: string,
): Promise<string> {
  let base = slugify(name);
  if (slugProblem(base)) base = slugify(`${fallbackPrefix}-${base}`);
  base = base.slice(0, SLUG_MAX_LENGTH - 4).replace(/-+$/, '');
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!slugProblem(candidate) && (await isSlugAvailable(db, candidate))) return candidate;
  }
}

/** An Error carrying an HTTP `status`, the convention routes already use (see services/pledge.ts). */
export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Throws 400 for an invalid slug, 409 for one already used by another Event or Channel. */
export async function assertUsableSlug(
  db: SlugDb,
  slug: unknown,
  owner: SlugOwner = {},
): Promise<string> {
  const problem = slugProblem(slug);
  if (problem) throw httpError(400, problem);
  if (!(await isSlugAvailable(db, slug as string, owner))) {
    throw httpError(409, `slug "${slug as string}" is already used by another event or channel`);
  }
  return slug as string;
}
