import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CartDrawer from '../../src/components/CartDrawer';
import { CartProvider, useCart } from '../../src/context/CartContext';
import type { CartItem } from '../../src/types';

vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));
vi.mock('../../src/api/pledge', () => ({ createPledge: vi.fn(), getPledge: vi.fn() }));
vi.mock('../../src/lib/tracing', () => ({
  track: vi.fn(),
  trackAsync: vi.fn((_n: string, fn: () => unknown) => fn()),
  identifyDonor: vi.fn(),
}));

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

  it('shows cart items and allows removing them', async () => {
    renderDrawer([{ kind: 'REWARD', target_id: 'r1', amount_cents: 1000, label: 'T-shirt' }]);

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();

    // The per-item remove button uses &times; (×) not the word "remove"
    const removeBtns = screen.getAllByRole('button', { name: '×' });
    fireEvent.click(removeBtns[removeBtns.length - 1]!);

    await waitFor(() => expect(screen.queryByText('T-shirt')).toBeNull());
  });

  it('allows entering email and comment', async () => {
    renderDrawer([]);

    const emailInput = await screen.findByPlaceholderText('you@example.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    expect(emailInput).toHaveValue('test@example.com');
  });

  it('shows a checkout error on missing email', async () => {
    renderDrawer([{ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }]);
    fireEvent.click(await screen.findByRole('button', { name: /^contribute/i }));
    expect(await screen.findByText(/email/i)).toBeInTheDocument();
  });

  it('shows the nudge panel when unvisited categories exist', async () => {
    vi.mocked(getPolls).mockResolvedValue([
      { id: 'p1', title: 'Poll', options: [], total_votes_cents: 0, is_active: true },
    ]);
    vi.mocked(getChannels).mockResolvedValue([{ id: 'c1', name: 'Main', is_active: true }]);
    // Pre-seed a poll vote + channel so the cart is non-empty and checkout is enabled
    sessionStorage.setItem(
      'donation_cart_v1',
      JSON.stringify({
        cart: [
          { kind: 'POLL_VOTE', target_id: 'o1', poll_id: 'p1', amount_cents: 100, label: 'A' },
        ],
        topUp: '',
        comment: '',
        channelId: 'c1',
      }),
    );

    renderDrawer([]);

    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^contribute/i }));

    expect(await screen.findByRole('button', { name: 'skip anyway' })).toBeInTheDocument();
  });

  it('shows the issues panel when cart items are no longer available', async () => {
    // Pre-seed cart with a REWARD item + channel, but mock getRewards to return empty
    // so revalidateCart reports the item as unavailable
    sessionStorage.setItem(
      'donation_cart_v1',
      JSON.stringify({
        cart: [{ kind: 'REWARD', target_id: 'r1', amount_cents: 1000, label: 'T-shirt' }],
        topUp: '',
        comment: '',
        channelId: 'c1',
      }),
    );
    vi.mocked(getChannels).mockResolvedValue([{ id: 'c1', name: 'Main', is_active: true }]);
    // getRewards returns empty → reward not found → issue

    renderDrawer([]);

    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^contribute/i }));

    expect(
      await screen.findByText('Some items in your cart are no longer available:'),
    ).toBeInTheDocument();
  });

  it('allows entering a comment', async () => {
    renderDrawer([]);

    const commentArea = await screen.findByPlaceholderText(
      'Leave a message with your contribution',
    );
    fireEvent.change(commentArea, { target: { value: 'great work!' } });
    expect(commentArea).toHaveValue('great work!');
  });
});
