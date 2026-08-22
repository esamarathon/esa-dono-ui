import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DonateFlow from '../../src/pages/DonateFlow';
import { CartProvider, useCart } from '../../src/context/CartContext';

vi.mock('../../src/api/rewards', () => ({
  getRewards: vi.fn(),
}));
vi.mock('../../src/api/polls', () => ({
  getPolls: vi.fn(),
}));
vi.mock('../../src/api/goals', () => ({
  getGoals: vi.fn(),
}));
vi.mock('../../src/api/channels', () => ({
  getChannels: vi.fn(),
}));

import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getChannels } from '../../src/api/channels';

// Exposes the drawer's open/closed state as text so tests can assert
// whether clicking "review & checkout" actually opened it, without needing
// to render the full CartDrawer component.
function DrawerOpenIndicator() {
  const { drawerOpen } = useCart();
  return <div data-testid="drawer-state">{drawerOpen ? 'open' : 'closed'}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CartProvider>
        <DrawerOpenIndicator />
        <DonateFlow />
      </CartProvider>
    </MemoryRouter>,
  );
}

describe('DonateFlow (tabbed browse page)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // An event is required before the incentive tabs render, so tests that
    // aren't specifically about the event picker pre-select one via the
    // same sessionStorage key the CartContext reads its initial state from.
    sessionStorage.setItem(
      'donation_cart_v1',
      JSON.stringify({ cart: [], topUp: '', comment: '', channelId: 'event-1' }),
    );
    vi.mocked(getChannels).mockResolvedValue([
      { id: 'event-1', name: 'Event One', is_active: true },
    ]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
  });

  it('renders the rewards tab when visiting /rewards', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getRewards).mockResolvedValue([
      {
        id: '1',
        title: 'Digital Reward',
        description: 'A digital item',
        type: 'DIGITAL',
        cost_cents: 500,
        quantity_total: null,
        quantity_claimed: 0,
        is_active: true,
      },
      {
        id: '2',
        title: 'Physical Reward',
        description: 'A physical item',
        type: 'PHYSICAL',
        cost_cents: 1000,
        quantity_total: 10,
        quantity_claimed: 3,
        is_active: true,
      },
    ]);

    renderAt('/rewards');

    expect(await screen.findByText('Digital Reward')).toBeDefined();
    expect(screen.getByText('Physical Reward')).toBeDefined();
  });

  it('defaults to the rewards tab when visiting /donate', async () => {
    vi.mocked(getRewards).mockResolvedValue([
      {
        id: '1',
        title: 'Digital Reward',
        description: 'A digital item',
        type: 'DIGITAL',
        cost_cents: 500,
        quantity_total: null,
        quantity_claimed: 0,
        is_active: true,
      },
    ]);

    renderAt('/donate');

    expect(await screen.findByText('Digital Reward')).toBeDefined();
  });

  it('adds a reward to the cart without collecting an address (Stripe collects it)', async () => {
    vi.mocked(getRewards).mockResolvedValue([
      {
        id: '2',
        title: 'Physical Reward',
        description: 'A physical item',
        type: 'PHYSICAL',
        cost_cents: 1000,
        quantity_total: 10,
        quantity_claimed: 3,
        is_active: true,
      },
    ]);

    renderAt('/rewards');

    const addButton = await screen.findByText('add');
    addButton.click();

    expect(await screen.findByText('remove')).toBeDefined();
  });

  it('switches to the polls tab when clicked', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([
      {
        id: 'p1',
        title: 'Favorite game',
        options: [],
        total_votes_cents: 0,
        is_active: true,
        allow_custom_entries: false,
      },
    ]);

    renderAt('/rewards');

    const pollsTabButtons = await screen.findAllByText('polls');
    pollsTabButtons[0]!.click();

    expect(await screen.findByText('Favorite game')).toBeDefined();
  });

  it('cycles forward through categories via "next", wrapping back to rewards', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');

    expect(await screen.findByText(/no rewards available/i)).toBeDefined();

    screen.getByText(/next/i).click();
    expect(await screen.findByText(/no active polls/i)).toBeDefined();

    screen.getByText(/next/i).click();
    expect(await screen.findByText(/no active fund goals/i)).toBeDefined();

    // Wraps back to rewards instead of dead-ending on the last category.
    screen.getByText(/next/i).click();
    expect(await screen.findByText(/no rewards available/i)).toBeDefined();
  });

  it('cycles backward through categories via "previous", wrapping from rewards to goals', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');

    expect(await screen.findByText(/no rewards available/i)).toBeDefined();

    screen.getByText(/previous/i).click();
    expect(await screen.findByText(/no active fund goals/i)).toBeDefined();
  });

  it('always shows "review & checkout" on its own row alongside next/previous', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');

    await screen.findByText(/no rewards available/i);
    expect(screen.getByText(/previous/i)).toBeDefined();
    expect(screen.getByText(/^next/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /review & checkout/i })).toBeDefined();
  });

  it('warns instead of opening the drawer when checking out before every category is reviewed', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');
    await screen.findByText(/no rewards available/i);

    screen.getByRole('button', { name: /review & checkout/i }).click();

    expect(await screen.findByText(/haven't reviewed/i)).toBeDefined();
    expect(screen.getByText(/haven't reviewed.*polls/i)).toBeDefined();
    expect(screen.getByTestId('drawer-state').textContent).toBe('closed');
  });

  it('opens the drawer on a second checkout click, bypassing the warning', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');
    await screen.findByText(/no rewards available/i);

    screen.getByRole('button', { name: /review & checkout/i }).click();
    await screen.findByText(/haven't reviewed/i);

    screen.getByRole('button', { name: /review & checkout/i }).click();

    await waitFor(() => {
      expect(screen.getByTestId('drawer-state').textContent).toBe('open');
    });
  });

  it('opens the drawer directly, with no warning, once every category has been reviewed', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');
    await screen.findByText(/no rewards available/i);
    screen.getByText(/next/i).click();
    await screen.findByText(/no active polls/i);
    screen.getByText(/next/i).click();
    await screen.findByText(/no active fund goals/i);

    screen.getByRole('button', { name: /review & checkout/i }).click();

    expect(screen.queryByText(/haven't reviewed/i)).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('drawer-state').textContent).toBe('open');
    });
  });

  it('marks a tab as visited (checkmark) once its list has been shown', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);

    renderAt('/rewards');

    await screen.findByText(/no rewards available/i);
    expect(await screen.findByTestId('visited-check-rewards')).toBeDefined();
    expect(screen.queryByTestId('visited-check-polls')).toBeNull();

    screen.getByText(/next/i).click();
    await screen.findByText(/no active polls/i);
    expect(await screen.findByTestId('visited-check-polls')).toBeDefined();
  });
});
