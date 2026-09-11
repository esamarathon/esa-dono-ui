/**
 * Discovery: read the public GET endpoints (#33) and build a synthetic-ref
 * catalog of currently-open incentives (#34). Synthetic refs (`r1`, `p2o3`, …)
 * decouple the reproducible decision log from server ids, so a log generated
 * once replays against a freshly reset demo DB where ids differ.
 */
import type { Catalog } from './types.js';

interface HasId {
  id: string;
}
interface PollShape {
  id: string;
  channel_id?: string | null;
  options: { id: string }[];
}
interface RewardShape {
  id: string;
  type: string;
  cost_cents: number;
  channel_id?: string | null;
}
interface GoalShape {
  id: string;
  channel_id?: string | null;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    throw new Error(`Discovery GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Try to fetch a resource, returning an empty array if the endpoint is
 * feature-gated (403) or missing. Used for optional discovery endpoints
 * like /api/auctions which may be disabled via feature flags.
 */
async function getJsonOptional<T extends { id: string }>(
  baseUrl: string,
  path: string,
): Promise<T[]> {
  try {
    return await getJson<T[]>(baseUrl, path);
  } catch (err) {
    const status = Number((err as Error).message.match(/failed: (\d+)/)?.[1] ?? NaN);
    // Return empty array if the endpoint is feature-gated (403) or not found (404)
    if (status === 403 || status === 404) {
      return [];
    }
    throw err;
  }
}

/** Build the synthetic-ref catalog from live discovery endpoints. */
export async function discover(baseUrl: string): Promise<Catalog> {
  const [channels, rewards, polls, goals, auctions] = await Promise.all([
    getJson<HasId[]>(baseUrl, '/api/channels'),
    getJson<RewardShape[]>(baseUrl, '/api/rewards'),
    getJson<PollShape[]>(baseUrl, '/api/polls'),
    getJson<GoalShape[]>(baseUrl, '/api/goals'),
    getJsonOptional<HasId>(baseUrl, '/api/auctions'),
  ]);

  const resolve: Record<string, string> = {};
  const channelOf: Record<string, string | undefined> = {};
  const cat: Catalog = {
    channels: [],
    rewards: [],
    polls: [],
    goals: [],
    auctions: [],
    resolve,
    channelOf,
    pledgeableRewards: [],
    rewardCostCents: {},
  };

  channels.forEach((c, i) => {
    const ref = `c${i + 1}`;
    cat.channels.push(ref);
    resolve[ref] = c.id;
  });
  // Real channel id -> synthetic channelRef, so an incentive tied to a
  // specific channel can be paired with that same channelRef (#58).
  const channelIdToRef = new Map(cat.channels.map((ref) => [resolve[ref], ref]));

  rewards.forEach((r, i) => {
    const ref = `r${i + 1}`;
    cat.rewards.push(ref);
    resolve[ref] = r.id;
    channelOf[ref] = r.channel_id ? channelIdToRef.get(r.channel_id) : undefined;
    cat.rewardCostCents[ref] = r.cost_cents;
    if (r.type !== 'PHYSICAL') cat.pledgeableRewards.push(ref);
  });
  polls.forEach((p, i) => {
    const pollRef = `p${i + 1}`;
    resolve[pollRef] = p.id;
    channelOf[pollRef] = p.channel_id ? channelIdToRef.get(p.channel_id) : undefined;
    const options = p.options.map((o, j) => {
      const optRef = `${pollRef}o${j + 1}`;
      resolve[optRef] = o.id;
      return optRef;
    });
    cat.polls.push({ pollRef, options });
  });
  goals.forEach((g, i) => {
    const ref = `g${i + 1}`;
    cat.goals.push(ref);
    resolve[ref] = g.id;
    channelOf[ref] = g.channel_id ? channelIdToRef.get(g.channel_id) : undefined;
  });
  auctions.forEach((a, i) => {
    const ref = `a${i + 1}`;
    cat.auctions.push(ref);
    resolve[ref] = a.id;
  });

  return cat;
}
