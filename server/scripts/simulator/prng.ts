/**
 * Seeded PRNG and named sub-streams for the platform simulator.
 *
 * Decision record: wayfinder #32.
 *  - Vendored mulberry32 + xmur3 (no dependency, so an upstream bump can never
 *    silently break replay).
 *  - Seed is an integer, or an arbitrary string hashed to a stable 32-bit state.
 *  - Named sub-streams, one per decision dimension, so adding a draw in one
 *    dimension does not perturb the others.
 */

/** xmur3 string hash → seed generator (returns successive 32-bit states). */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG — returns a function yielding floats in [0, 1). */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn an int-or-string seed into a stable 32-bit state. */
export function seedState(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  return xmur3(String(seed))();
}

/** The decision dimensions each with its own derived stream (#32.4, #36 timing). */
export const DIMENSIONS = [
  'donor',
  'amount',
  'incentiveType',
  'incentivePick',
  'voteAmount',
  'timing',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Streams = Record<Dimension, () => number>;

/** Derive one independent mulberry32 stream per dimension from the master seed. */
export function makeStreams(seed: string | number): Streams {
  const master = seedState(seed);
  const derive = (name: string) => mulberry32(xmur3(`${master}:${name}`)());
  return DIMENSIONS.reduce((acc, name) => {
    acc[name] = derive(name);
    return acc;
  }, {} as Streams);
}

// --- Draw helpers ----------------------------------------------------------

/** Inclusive integer in [min, max]. */
export function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Weighted pick from [value, weight] entries. */
export function weighted<T>(rng: () => number, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) {
    if ((r -= w) < 0) return v;
  }
  return entries[entries.length - 1]![0];
}

/**
 * Exponential inter-arrival delay in ms for a mean arrival rate (events/sec).
 * Poisson process: delays are exponentially distributed → realistic bursts,
 * yet reproducible because the draw comes from the seeded `timing` stream (#36).
 */
export function exponentialDelayMs(rng: () => number, ratePerSec: number): number {
  if (ratePerSec <= 0) return 0;
  const u = Math.max(rng(), 1e-9); // avoid log(0)
  return (-Math.log(u) / ratePerSec) * 1000;
}
