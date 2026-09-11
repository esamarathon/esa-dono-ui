import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { discover } from '../../scripts/simulator/discovery.js';

function getUrlString(url: string | URL | Request): string {
  if (typeof url === 'string') return url;
  if (url instanceof Request) return url.url;
  return url.toString();
}

describe('Simulator Discovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should discover all enabled endpoints', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const urlStr = getUrlString(url);
      if (urlStr.includes('/api/channels'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'c1' }, { id: 'c2' }])));
      if (urlStr.includes('/api/rewards'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'r1', type: 'DIGITAL', cost_cents: 100 }])),
        );
      if (urlStr.includes('/api/polls'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'p1', options: [{ id: 'o1' }] }])),
        );
      if (urlStr.includes('/api/goals'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'g1' }])));
      if (urlStr.includes('/api/auctions'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'a1' }])));
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    const catalog = await discover('http://localhost:3001');

    expect(catalog.channels).toEqual(['c1', 'c2']);
    expect(catalog.rewards).toEqual(['r1']);
    expect(catalog.polls).toHaveLength(1);
    expect(catalog.goals).toEqual(['g1']);
    expect(catalog.auctions).toEqual(['a1']);
  });

  it('should handle 403 (feature-gated) auctions endpoint gracefully', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const urlStr = getUrlString(url);
      if (urlStr.includes('/api/channels'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'c1' }])));
      if (urlStr.includes('/api/rewards'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'r1', type: 'DIGITAL', cost_cents: 100 }])),
        );
      if (urlStr.includes('/api/polls'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'p1', options: [{ id: 'o1' }] }])),
        );
      if (urlStr.includes('/api/goals'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'g1' }])));
      if (urlStr.includes('/api/auctions'))
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Auctions are not enabled' }), { status: 403 }),
        );
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    const catalog = await discover('http://localhost:3001');

    expect(catalog.channels).toEqual(['c1']);
    expect(catalog.rewards).toEqual(['r1']);
    expect(catalog.polls).toHaveLength(1);
    expect(catalog.goals).toEqual(['g1']);
    // Auctions should be empty when the endpoint returns 403
    expect(catalog.auctions).toEqual([]);
  });

  it('should handle 404 (missing) auctions endpoint gracefully', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const urlStr = getUrlString(url);
      if (urlStr.includes('/api/channels'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'c1' }])));
      if (urlStr.includes('/api/rewards'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'r1', type: 'DIGITAL', cost_cents: 100 }])),
        );
      if (urlStr.includes('/api/polls'))
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 'p1', options: [{ id: 'o1' }] }])),
        );
      if (urlStr.includes('/api/goals'))
        return Promise.resolve(new Response(JSON.stringify([{ id: 'g1' }])));
      if (urlStr.includes('/api/auctions'))
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }),
        );
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    const catalog = await discover('http://localhost:3001');

    expect(catalog.channels).toEqual(['c1']);
    expect(catalog.auctions).toEqual([]);
  });

  it('should fail if a required endpoint returns an error', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const urlStr = getUrlString(url);
      if (urlStr.includes('/api/channels'))
        return Promise.resolve(new Response(JSON.stringify({}), { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    await expect(discover('http://localhost:3001')).rejects.toThrow(
      'Discovery GET /api/channels failed: 500',
    );
  });
});
