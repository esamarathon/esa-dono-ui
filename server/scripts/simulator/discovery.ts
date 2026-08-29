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
  options: { id: string }[];
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    throw new Error(`Discovery GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Build the synthetic-ref catalog from live discovery endpoints. */
export async function discover(baseUrl: string): Promise<Catalog> {
  const [channels, rewards, polls, goals, auctions] = await Promise.all([
    getJson<HasId[]>(baseUrl, '/api/channels'),
    getJson<HasId[]>(baseUrl, '/api/rewards'),
    getJson<PollShape[]>(baseUrl, '/api/polls'),
    getJson<HasId[]>(baseUrl, '/api/goals'),
    getJson<HasId[]>(baseUrl, '/api/auctions'),
  ]);

  const resolve: Record<string, string> = {};
  const cat: Catalog = {
    channels: [],
    rewards: [],
    polls: [],
    goals: [],
    auctions: [],
    resolve,
  };

  channels.forEach((c, i) => {
    const ref = `c${i + 1}`;
    cat.channels.push(ref);
    resolve[ref] = c.id;
  });
  rewards.forEach((r, i) => {
    const ref = `r${i + 1}`;
    cat.rewards.push(ref);
    resolve[ref] = r.id;
  });
  polls.forEach((p, i) => {
    const pollRef = `p${i + 1}`;
    resolve[pollRef] = p.id;
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
  });
  auctions.forEach((a, i) => {
    const ref = `a${i + 1}`;
    cat.auctions.push(ref);
    resolve[ref] = a.id;
  });

  return cat;
}
