import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CartDrawer from '../../src/components/CartDrawer';
import { CartProvider, useCart } from '../../src/context/CartContext';
import type { CartItem } from '../../src/types';

vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));

import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getChannels } from '../../src/api/channels';

// Opens the drawer and (optionally) seeds the cart with enough items to
// force the body to overflow, mirroring the "checkout button pushed
// offscreen" bug report.
function DrawerOpener({ items = [] }: { items?: CartItem[] }) {
  const { openDrawer, addToCart } = useCart();
  return (
    <button
      data-testid="open-drawer"
      onClick={() => {
        items.forEach(addToCart);
        openDrawer();
      }}
    >
      open
    </button>
  );
}

function renderDrawer(items: CartItem[] = []) {
  const utils = render(
    <CartProvider>
      <DrawerOpener items={items} />
      <CartDrawer />
    </CartProvider>,
  );
  screen.getByTestId('open-drawer').click();
  return utils;
}

function manyPollVotes(count: number): CartItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'POLL_VOTE' as const,
    target_id: `option-${i}`,
    poll_id: `poll-${i}`,
    amount_cents: 100,
    label: `Option ${i}`,
  }));
}

describe('CartDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getChannels).mockResolvedValue([]);
  });

  it('does not render when the drawer is closed', () => {
    render(
      <CartProvider>
        <CartDrawer />
      </CartProvider>,
    );
    expect(screen.queryByRole('dialog', { name: /cart/i })).toBeNull();
  });

  it('shows the checkout button in a footer separate from the scrollable body, even with a long cart', async () => {
    renderDrawer(manyPollVotes(30));

    const checkoutButton = await screen.findByRole('button', { name: /^contribute/i });
    expect(checkoutButton).toBeDefined();

    // The button must live in a footer container that is NOT the scrollable
    // body — otherwise a long enough cart pushes it out of view (the bug
    // this test guards against). Walk up to the drawer panel and confirm
    // the button's immediate wrapper is a sibling of the scrollable region,
    // not nested inside it.
    const scrollableBody = document.querySelector('.overflow-y-auto');
    expect(scrollableBody).not.toBeNull();
    expect(scrollableBody!.contains(checkoutButton)).toBe(false);
  });

  it('shows the checkout button even with an empty cart', async () => {
    renderDrawer([]);
    expect(await screen.findByRole('button', { name: /^contribute/i })).toBeDefined();
  });
});
