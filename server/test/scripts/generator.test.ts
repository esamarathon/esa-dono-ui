import { describe, expect, it } from 'vitest';
import { generate } from '../../scripts/simulator/generator.js';
import { makeStreams } from '../../scripts/simulator/prng.js';
import type { Catalog, DecisionEntry } from '../../scripts/simulator/types.js';

const catalog: Catalog = {
  channels: ['c1', 'c2'],
  rewards: ['r1', 'r2', 'r3'],
  pledgeableRewards: ['r1', 'r2'],
  rewardCostCents: { r1: 500, r2: 1500, r3: 2000 },
  polls: [
    { pollRef: 'empty', options: [] },
    { pollRef: 'p1', options: ['p1o1', 'p1o2'] },
    { pollRef: 'p2', options: ['p2o1'] },
  ],
  goals: ['g1', 'g2'],
  auctions: [],
  channelOf: { r1: 'c1', r2: 'c2', r3: 'c1', p1: 'c1', p2: 'c2', g1: 'c1' },
  resolve: {},
};
const options = { seed: 'entropy-regression', events: 1000, donors: 20, ratePerSec: 0.5, catalog };

function itemRef(item: NonNullable<DecisionEntry['items']>[number]): string {
  if (item.kind === 'REWARD') return item.rewardRef;
  if (item.kind === 'POLL_VOTE') return item.pollRef;
  return item.goalRef;
}

describe('simulator decision generation', () => {
  it('is deterministic for identical inputs, with different streams for different seeds', () => {
    const first = generate(options);
    expect(generate(options)).toEqual(first);
    expect(generate({ ...options, seed: 'another-seed' })).not.toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('keeps each donor first action a donation, but generates donations throughout the run', () => {
    const seen = new Set<string>();
    const log = generate(options);
    for (const entry of log) {
      if (!seen.has(entry.actor.donorRef)) expect(entry.action).toBe('DONATE');
      seen.add(entry.actor.donorRef);
    }
    expect(log.filter((e) => e.action === 'DONATE').length).toBeGreaterThan(seen.size);
    expect(log.slice(-100).some((e) => e.action === 'DONATE')).toBe(true);
  });

  it('allows disabling repeat donations or making every event a donation', () => {
    const never = generate({ ...options, repeatDonationChance: 0 });
    expect(never.filter((e) => e.action === 'DONATE')).toHaveLength(
      new Set(never.map((e) => e.actor.donorRef)).size,
    );
    const always = generate({ ...options, repeatDonationChance: 1 });
    expect(always.every((e) => e.action === 'DONATE')).toBe(true);
  });

  it('never selects an empty poll for voting', () => {
    const log = generate(options);
    const votes = log.filter((e) => e.action === 'VOTE_POLL');
    expect(votes.length).toBeGreaterThan(0);
    for (const entry of votes) {
      expect(entry.targetRef?.pollRef).not.toBe('empty');
      expect(entry.targetRef?.optionRef).toBeTruthy();
    }
  });

  it('generates channel-compatible mixed carts with 1–4 items and per-unit reward amounts', () => {
    const carts = generate(options).filter((e) => e.action === 'PLEDGE_CHECKOUT');
    expect(new Set(carts.map((e) => e.items?.length))).toEqual(new Set([1, 2, 3, 4]));
    expect(carts.some((e) => new Set(e.items?.map((i) => i.kind)).size > 1)).toBe(true);
    expect(carts.some((e) => e.items?.some((i) => i.kind === 'REWARD' && i.quantity > 1))).toBe(
      true,
    );
    for (const entry of carts) {
      expect(catalog.channels).toContain(entry.targetRef?.channelRef);
      for (const item of entry.items ?? []) {
        const channel = catalog.channelOf[itemRef(item)];
        expect(channel === undefined || channel === entry.targetRef?.channelRef).toBe(true);
        expect(Number.isInteger(item.amountCents)).toBe(true);
        if (item.kind === 'REWARD') {
          expect(catalog.pledgeableRewards).toContain(item.rewardRef);
          expect(item.amountCents).toBe(catalog.rewardCostCents[item.rewardRef]);
          expect(item.quantity).toBeGreaterThanOrEqual(1);
          expect(item.quantity).toBeLessThanOrEqual(3);
        } else {
          expect(item.amountCents).toBeGreaterThanOrEqual(100);
        }
      }
    }
  });

  it('mixes round and cent-level amounts, quantities, names, and optional comments', () => {
    const log = generate(options);
    for (const action of ['DONATE', 'VOTE_POLL', 'CONTRIBUTE_GOAL']) {
      const amounts = log
        .filter((e) => e.action === action)
        .map((e) => Number(e.params.amountCents));
      expect(amounts.some((n) => n % 100 === 0)).toBe(true);
      expect(amounts.some((n) => n % 100 !== 0)).toBe(true);
      expect(amounts.every((n) => Number.isInteger(n) && n >= 100)).toBe(true);
    }
    expect(log.some((e) => e.action === 'CLAIM_REWARD' && Number(e.params.quantity) > 1)).toBe(
      true,
    );
    const donations = log.filter((e) => e.action === 'DONATE');
    expect(donations.some((e) => !e.params.comment)).toBe(true);
    expect(
      donations.some((e) => typeof e.params.comment === 'string' && e.params.comment.length > 80),
    ).toBe(true);
    expect(new Set(donations.map((e) => e.params.displayName)).size).toBeGreaterThan(5);
    const names = new Map<string, unknown>();
    for (const e of donations) {
      if (names.has(e.actor.donorRef))
        expect(e.params.displayName).toBe(names.get(e.actor.donorRef));
      names.set(e.actor.donorRef, e.params.displayName);
    }
  });

  it('assigns stable donor profiles and varies traffic without changing other decisions', () => {
    const phased = generate(options);
    const steady = generate({ ...options, traffic: 'steady' });
    expect(new Set(phased.map((e) => e.actor.profile))).toEqual(
      new Set(['casual', 'regular', 'collector', 'voter']),
    );
    expect(new Set(phased.map((e) => e.trafficPhase))).toEqual(
      new Set(['quiet', 'normal', 'busy']),
    );
    expect(steady.every((e) => e.trafficPhase === 'normal')).toBe(true);
    const withoutTiming = ({ delayMs: _delay, trafficPhase: _phase, ...entry }: DecisionEntry) =>
      entry;
    expect(phased.map(withoutTiming)).toEqual(steady.map(withoutTiming));
    expect(phased.map((e) => e.delayMs)).not.toEqual(steady.map((e) => e.delayMs));
    expect(phased.every((e) => Number.isInteger(e.delayMs) && e.delayMs >= 0)).toBe(true);
    const faster = generate({ ...options, ratePerSec: 1 });
    for (let i = 0; i < phased.length; i++) {
      expect(Math.abs(phased[i]!.delayMs - 2 * faster[i]!.delayMs)).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to donations when only empty polls or physical pledge rewards exist', () => {
    const empty: Catalog = {
      ...catalog,
      rewards: [],
      pledgeableRewards: [],
      polls: [{ pollRef: 'empty', options: [] }],
      goals: [],
    };
    expect(generate({ ...options, catalog: empty }).every((e) => e.action === 'DONATE')).toBe(true);
    const physicalOnly: Catalog = { ...empty, rewards: ['r3'] };
    const log = generate({ ...options, catalog: physicalOnly });
    expect(log.some((e) => e.action === 'CLAIM_REWARD')).toBe(true);
    expect(log.some((e) => e.action === 'PLEDGE_CHECKOUT')).toBe(false);
  });

  it('uses profile-specific activity levels and spend preferences', () => {
    const log = generate({ ...options, events: 10000 });
    const groups = new Map<
      string,
      { donors: Set<string>; visits: number; votes: number; spends: number }
    >();
    for (const entry of log) {
      const profile = entry.actor.profile!;
      const group = groups.get(profile) ?? {
        donors: new Set<string>(),
        visits: 0,
        votes: 0,
        spends: 0,
      };
      group.donors.add(entry.actor.donorRef);
      group.visits++;
      if (entry.action !== 'DONATE') group.spends++;
      if (entry.action === 'VOTE_POLL') group.votes++;
      groups.set(profile, group);
    }
    const regular = groups.get('regular')!;
    const casual = groups.get('casual')!;
    expect(regular.visits / regular.donors.size).toBeGreaterThan(
      (2 * casual.visits) / casual.donors.size,
    );
    const voter = groups.get('voter')!;
    const collector = groups.get('collector')!;
    expect(voter.votes / voter.spends).toBeGreaterThan((2 * collector.votes) / collector.spends);
  });

  it('preserves cart and reference invariants across multiple seeds and sparse channel catalogs', () => {
    const sparse: Catalog = {
      ...catalog,
      channelOf: { ...catalog.channelOf, r2: null, p2: 'unavailable', g1: 'unavailable' },
    };
    for (let seed = 0; seed < 25; seed++) {
      const log = generate({ ...options, seed, events: 200, catalog: sparse });
      for (const entry of log) {
        for (const ref of Object.values(entry.targetRef ?? {})) expect(ref).toBeTruthy();
        for (const item of entry.items ?? []) {
          const ref = itemRef(item);
          const channel = sparse.channelOf[ref];
          expect(channel === undefined || channel === entry.targetRef?.channelRef).toBe(true);
          if (item.kind === 'POLL_VOTE') expect(item.optionRef).toBeTruthy();
        }
      }
    }
  });

  it('keeps timing draws independent of other random dimensions', () => {
    const a = makeStreams('independent');
    const b = makeStreams('independent');
    for (let i = 0; i < 50; i++) a.amount();
    expect(Array.from({ length: 10 }, () => a.timing())).toEqual(
      Array.from({ length: 10 }, () => b.timing()),
    );
  });

  it('validates inputs instead of generating undefined donor/channel refs', () => {
    expect(() => generate({ ...options, donors: 0 })).toThrow(/donors/);
    expect(() => generate({ ...options, events: -1 })).toThrow(/events/);
    expect(() => generate({ ...options, ratePerSec: NaN })).toThrow(/rate/);
    expect(() => generate({ ...options, repeatDonationChance: 1.1 })).toThrow(/repeat/);
    expect(() => generate({ ...options, catalog: { ...catalog, channels: [] } })).toThrow(
      /channel/,
    );
    expect(generate({ ...options, events: 0 })).toEqual([]);
    expect(generate({ ...options, ratePerSec: 0 }).every((e) => e.delayMs === 0)).toBe(true);
  });
});
