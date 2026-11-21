import prisma from '../lib/prisma.js';

/**
 * Every feature flag the code consults, with its seeded description and
 * default state. A missing row reads as disabled, so rows exist purely for
 * visibility in the admin UI (`/admin/feature-flags`). Keep this list in sync
 * with `docs/admin-event-setup.md` § Feature flags and the
 * `isFeatureFlagEnabled()` call sites.
 */
export const DEFAULT_FEATURE_FLAGS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  {
    name: 'feedback',
    description:
      'Floating widget letting visitors send a screenshot + free-text message to the team via Discord.',
  },
  {
    name: 'auctions',
    description:
      'Silent auctions: donor bidding, closing items and winner payment. Not part of the three pledge Pools.',
  },
];

/**
 * Install the default feature flags (called from the seed). Idempotent: a
 * missing flag is created disabled; an existing flag only has its description
 * refreshed, never `is_enabled`, so an operator's toggle survives re-seeding.
 */
export async function ensureDefaultFeatureFlags(
  flags: ReadonlyArray<{ name: string; description: string }> = DEFAULT_FEATURE_FLAGS,
): Promise<void> {
  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { name: flag.name },
      update: { description: flag.description },
      create: { name: flag.name, description: flag.description, is_enabled: false },
    });
  }
}

// Cache feature flags in-memory with a TTL for performance
let cachedFlags: Record<string, boolean> = {};
let cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

async function getCachedFlags(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (now < cacheExpiry && Object.keys(cachedFlags).length > 0) {
    return cachedFlags;
  }

  const flags = await prisma.featureFlag.findMany();
  cachedFlags = Object.fromEntries(flags.map((f) => [f.name, f.is_enabled]));
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedFlags;
}

/**
 * Check if a feature flag is enabled.
 * Returns false if the flag does not exist.
 */
export async function isFeatureFlagEnabled(name: string): Promise<boolean> {
  const flags = await getCachedFlags();
  return flags[name] ?? false;
}

/**
 * Get all feature flags.
 */
export async function getAllFeatureFlags(): Promise<Record<string, boolean>> {
  return getCachedFlags();
}

/**
 * Invalidate the cache (called after mutations).
 */
export function invalidateFlagCache(): void {
  cacheExpiry = 0;
}
