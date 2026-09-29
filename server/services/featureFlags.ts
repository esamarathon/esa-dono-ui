import prisma from '../lib/prisma.js';

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
