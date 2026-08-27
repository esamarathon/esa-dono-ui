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
      result.current.selectChannel('c1');
      result.current.addToCart({ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 });
    });
    let res: unknown;
    await act(async () => {
      res = await result.current.checkout();
    });
    expect(res).toEqual({ total_cents: 1000, donate_url: null });
    expect(mocks.createPledge).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', channel_id: 'c1' }),
    );
    expect(result.current.cart).toHaveLength(0);
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
});
