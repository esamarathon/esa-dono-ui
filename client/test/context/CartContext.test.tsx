import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  getRewards: vi.fn(),
  getPolls: vi.fn(),
  getGoals: vi.fn(),
  getChannels: vi.fn(),
  createPledge: vi.fn(),
  track: vi.fn(),
  trackAsync: vi.fn(),
}));

vi.mock('../../src/api/rewards', () => ({ getRewards: mocks.getRewards }));
vi.mock('../../src/api/polls', () => ({ getPolls: mocks.getPolls }));
vi.mock('../../src/api/goals', () => ({ getGoals: mocks.getGoals }));
vi.mock('../../src/api/channels', () => ({ getChannels: mocks.getChannels }));
vi.mock('../../src/api/pledge', () => ({
  createPledge: mocks.createPledge,
  getPledge: vi.fn(),
}));
vi.mock('../../src/lib/tracing', () => ({
  track: mocks.track,
  trackAsync: mocks.trackAsync,
  identifyDonor: vi.fn(),
}));

import { CartProvider, useCart } from '../../src/context/CartContext';
import { INCENTIVES_POLL_MS } from '../../src/config';

const reward = {
  id: 'r1',
  title: 'T-shirt',
  type: 'DIGITAL',
  cost_cents: 1000,
  quantity_total: null,
  quantity_claimed: 0,
  is_active: true,
};

function wrapper({ children }: { children: ReactNode }) {
  return <CartProvider>{children}</CartProvider>;
}

describe('CartContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getRewards.mockResolvedValue([reward]);
    mocks.getPolls.mockResolvedValue([]);
    mocks.getGoals.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([{ id: 'c1', name: 'Main', is_active: true }]);
    mocks.trackAsync.mockImplementation((_name: string, fn: () => unknown) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads incentive data on mount', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rewards).toHaveLength(1);
    expect(result.current.channels).toHaveLength(1);
  });

  it('adds and removes items from the cart', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    expect(result.current.cart).toHaveLength(1);
    expect(result.current.cartTotal).toBe(1000);

    act(() => {
      result.current.removeFromCart('REWARD', 'r1');
    });
    expect(result.current.cart).toHaveLength(0);
  });

  it('updates an existing cart item instead of duplicating it', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 2000 });
    });
    expect(result.current.cart).toHaveLength(1);
    expect(result.current.cart[0]!.amount_cents).toBe(2000);
  });

  it('selects a channel directly when cart is empty', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectChannel('c1'));
    expect(result.current.selectedChannelId).toBe('c1');
  });

  it('holds a channel switch when cart has conflicting items', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, channel_id: 'c1' }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectChannel('c1'));
    act(() => result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }));
    act(() => result.current.selectChannel('c2'));
    expect(result.current.pendingChannelId).toBe('c2');
  });

  it('confirms a channel switch and clears conflicting items', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, channel_id: 'c1' }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectChannel('c1'));
    act(() => result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }));
    act(() => result.current.selectChannel('c2'));
    act(() => result.current.confirmChannelSwitch());
    expect(result.current.selectedChannelId).toBe('c2');
    expect(result.current.cart).toHaveLength(0);
  });

  it('cancels a pending channel switch', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, channel_id: 'c1' }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectChannel('c1'));
    act(() => result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }));
    act(() => result.current.selectChannel('c2'));
    act(() => result.current.cancelChannelSwitch());
    expect(result.current.pendingChannelId).toBeNull();
    expect(result.current.selectedChannelId).toBe('c1');
  });

  it('checkout requires an email', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: unknown;
    await act(async () => {
      res = await result.current.checkout();
    });
    expect(res).toBeNull();
    expect(result.current.checkoutError).toMatch(/email/);
  });

  it('checkout requires a channel to be selected', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setEmail('a@b.com'));
    let res: unknown;
    await act(async () => {
      res = await result.current.checkout();
    });
    expect(res).toBeNull();
    expect(result.current.checkoutError).toMatch(/channel/i);
  });

  it('checkout requires a non-empty cart', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setEmail('a@b.com');
      result.current.selectChannel('c1');
    });
    let res: unknown;
    await act(async () => {
      res = await result.current.checkout();
    });
    expect(res).toBeNull();
    expect(result.current.checkoutError).toMatch(/incentive|donation/i);
  });

  it('checkout calls createPledge with the cart contents', async () => {
    mocks.createPledge.mockResolvedValue({ total_cents: 1000, donate_url: null });
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setEmail('a@b.com');
      result.current.setDisplayName('Jane Donor');
      result.current.selectChannel('c1');
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    let res: unknown;
    await act(async () => {
      res = await result.current.checkout();
    });
    expect(res).toEqual({ total_cents: 1000, donate_url: null });
    expect(mocks.createPledge).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'a@b.com',
        display_name: 'Jane Donor',
        channel_id: 'c1',
      }),
    );
    expect(result.current.cart).toHaveLength(0);
  });

  it('incrementRewardQuantity increases quantity and recomputes amount_cents from live cost_cents (#50)', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    act(() => {
      result.current.incrementRewardQuantity('r1');
    });
    expect(result.current.cart[0]!.quantity).toBe(2);
    expect(result.current.cart[0]!.amount_cents).toBe(2000);
  });

  it('decrementRewardQuantity decreases quantity, removing the item once it reaches zero (#50)', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
      result.current.incrementRewardQuantity('r1');
    });
    expect(result.current.cart[0]!.quantity).toBe(2);

    act(() => {
      result.current.decrementRewardQuantity('r1');
    });
    expect(result.current.cart[0]!.quantity).toBe(1);
    expect(result.current.cart[0]!.amount_cents).toBe(1000);

    act(() => {
      result.current.decrementRewardQuantity('r1');
    });
    expect(result.current.cart).toHaveLength(0);
  });

  it("incrementRewardQuantity refuses to exceed the reward's remaining stock (#50)", async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, quantity_total: 2, quantity_claimed: 0 }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
      result.current.incrementRewardQuantity('r1');
    });
    expect(result.current.cart[0]!.quantity).toBe(2);

    act(() => {
      result.current.incrementRewardQuantity('r1');
    });
    expect(result.current.cart[0]!.quantity).toBe(2);
  });

  it("checkout forwards each item's quantity to createPledge (#50)", async () => {
    mocks.createPledge.mockResolvedValue({ total_cents: 2000, donate_url: null });
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setEmail('a@b.com');
      result.current.selectChannel('c1');
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
      result.current.incrementRewardQuantity('r1');
    });
    await act(async () => {
      await result.current.checkout();
    });
    expect(mocks.createPledge).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ target_id: 'r1', quantity: 2 })],
      }),
    );
  });

  it('drawer open/close/toggle', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.drawerOpen).toBe(false);
    act(() => result.current.openDrawer());
    expect(result.current.drawerOpen).toBe(true);
    act(() => result.current.toggleDrawer());
    expect(result.current.drawerOpen).toBe(false);
  });

  it('markVisited and hasVisited track incentive tabs', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasVisited('rewards')).toBe(false);
    act(() => result.current.markVisited('rewards'));
    expect(result.current.hasVisited('rewards')).toBe(true);
  });

  it('revalidateCart reports sold-out rewards', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, quantity_total: 5, quantity_claimed: 5 }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    let issues: unknown;
    await act(async () => {
      issues = await result.current.revalidateCart();
    });
    expect((issues as Array<{ reason: string }>)[0]?.reason).toMatch(/Sold out/);
  });

  it('prefillFromLink adds a reward, selects its channel, and opens the drawer', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, channel_id: 'c1' }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let warning: unknown;
    act(() => {
      warning = result.current.prefillFromLink(new URLSearchParams('reward=r1'));
    });
    expect(warning).toBeNull();
    expect(result.current.cart).toHaveLength(1);
    expect(result.current.cart[0]).toMatchObject({
      kind: 'REWARD',
      target_id: 'r1',
      amount_cents: 1000,
    });
    expect(result.current.selectedChannelId).toBe('c1');
    expect(result.current.drawerOpen).toBe(true);
  });

  it('prefillFromLink adds a poll vote with a custom amount', async () => {
    mocks.getPolls.mockResolvedValue([
      {
        id: 'p1',
        title: 'Pick a game',
        options: [{ id: 'o1', label: 'Mario', votes_cents: 0 }],
        total_votes_cents: 0,
        is_active: true,
      },
    ]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let warning: unknown;
    act(() => {
      warning = result.current.prefillFromLink(new URLSearchParams('poll=p1&option=o1&amount=5'));
    });
    expect(warning).toBeNull();
    expect(result.current.cart[0]).toMatchObject({
      kind: 'POLL_VOTE',
      target_id: 'o1',
      poll_id: 'p1',
      amount_cents: 500,
    });
  });

  it('prefillFromLink adds a goal with the default amount', async () => {
    mocks.getGoals.mockResolvedValue([
      { id: 'g1', title: 'New PC', current_cents: 0, target_cents: 10000, is_active: true },
    ]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let warning: unknown;
    act(() => {
      warning = result.current.prefillFromLink(new URLSearchParams('goal=g1'));
    });
    expect(warning).toBeNull();
    expect(result.current.cart[0]).toMatchObject({
      kind: 'GOAL',
      target_id: 'g1',
      amount_cents: 500,
    });
  });

  it('prefillFromLink warns on a sold-out reward and does not add it', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, quantity_total: 5, quantity_claimed: 5 }]);
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let warning: unknown;
    act(() => {
      warning = result.current.prefillFromLink(new URLSearchParams('reward=r1'));
    });
    expect(warning).toMatch(/sold out/i);
    expect(result.current.cart).toHaveLength(0);
  });

  it('prefillFromLink warns on an unknown target', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let warning: unknown;
    act(() => {
      warning = result.current.prefillFromLink(new URLSearchParams('reward=missing'));
    });
    expect(warning).toMatch(/no longer available/i);
    expect(result.current.cart).toHaveLength(0);
  });

  it('prefillFromLink only applies once per target', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.prefillFromLink(new URLSearchParams('reward=r1'));
    });
    act(() => {
      result.current.prefillFromLink(new URLSearchParams('reward=r1'));
    });
    expect(result.current.cart).toHaveLength(1);
  });

  it('poll refresh keeps a cart reward visible and flags it stale when it leaves the payload', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCart(), { wrapper });
    // Flush the initial fetch (mocked promise resolves on a microtask).
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });

    // The reward is dropped from the fresh payload on the next poll.
    mocks.getRewards.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCENTIVES_POLL_MS);
    });

    expect(result.current.staleRewardIds.has('r1')).toBe(true);
    // It stays visible (not removed) despite being absent from the payload.
    expect(result.current.rewards.map((r) => r.id)).toContain('r1');

    // Once removed from the cart, it drops off on the next refresh.
    act(() => result.current.removeFromCart('REWARD', 'r1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCENTIVES_POLL_MS);
    });
    expect(result.current.rewards.map((r) => r.id)).not.toContain('r1');
    expect(result.current.staleRewardIds.has('r1')).toBe(false);
    vi.useRealTimers();
  });

  it('poll refresh updates values in place and keeps a stale poll option flagged', async () => {
    const pollObj = {
      id: 'p1',
      title: 'Pick a game',
      options: [{ id: 'o1', label: 'Mario', votes_cents: 0 }],
      total_votes_cents: 0,
      is_active: true,
    };
    mocks.getPolls.mockResolvedValue([pollObj]);
    vi.useFakeTimers();
    const { result } = renderHook(() => useCart(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.addToCart({
        kind: 'POLL_VOTE',
        target_id: 'o1',
        poll_id: 'p1',
        amount_cents: 500,
      });
    });

    // Option o1 is gone from the fresh poll; a new option o2 appears.
    mocks.getPolls.mockResolvedValue([
      {
        id: 'p1',
        title: 'Pick a game',
        options: [{ id: 'o2', label: 'Zelda', votes_cents: 0 }],
        total_votes_cents: 0,
        is_active: true,
      },
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCENTIVES_POLL_MS);
    });

    // Protected stale option o1 stays, new option o2 is appended, poll not stale.
    const poll = result.current.polls[0]!;
    expect(poll.options.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(result.current.stalePollIds.has('p1')).toBe(false);
    expect(result.current.staleOptionIds.has('o1')).toBe(true);
    vi.useRealTimers();
  });

  it('poll refresh drops a non-cart incentive that leaves the payload', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCart(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.rewards).toHaveLength(1);

    // Reward r1 was never added to the cart, so it should drop off.
    mocks.getRewards.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCENTIVES_POLL_MS);
    });
    expect(result.current.rewards).toHaveLength(0);
    expect(result.current.staleRewardIds.size).toBe(0);
    vi.useRealTimers();
  });
});
