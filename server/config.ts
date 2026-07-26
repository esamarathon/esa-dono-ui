/**
 * Central home for server-side timing/lifetime settings. Values that were
 * previously duplicated as inline magic numbers across multiple files now
 * live here once, so changing them (e.g. loosening the pledge window, or
 * shortening magic-link lifetime) only requires editing this file.
 */

/** How long a donor's magic link / auth token stays valid before expiring. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * How long a pending pledge (smart donation cart) stays open awaiting a
 * matching donation before it's considered expired. Also used as the
 * lookback window for the email-based pledge fallback match.
 */
export const PLEDGE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
