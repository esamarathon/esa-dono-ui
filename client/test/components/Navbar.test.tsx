import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../src/components/Navbar';
import { CartProvider } from '../../src/context/CartContext';
import type { DonorWallet } from '../../src/types';

vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));
vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));

import { getDonor } from '../../src/api/donor';
import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getChannels } from '../../src/api/channels';

function renderNavbar() {
  return render(
    <MemoryRouter>
      <CartProvider>
        <Navbar />
      </CartProvider>
    </MemoryRouter>,
  );
}

function donor(overrides: Partial<DonorWallet> = {}): DonorWallet {
  return {
    id: '1',
    email: 'donor@example.com',
    balance_remaining: 500,
    total_donated: 1000,
    role: 'USER',
    donations: [],
    reward_claims: [],
    poll_votes: [],
    fund_contributions: [],
    custom_entries: [],
    ...overrides,
  };
}

describe('Navbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getChannels).mockResolvedValue([]);
  });

  it('shows a plain login link when no donor token is present', async () => {
    renderNavbar();
    expect(await screen.findByText('login')).toBeDefined();
    expect(screen.queryByText('logged in as')).toBeNull();
  });

  it('combines wallet/logout into a user dropdown for a plain USER donor, hiding moderate/admin', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getDonor).mockResolvedValue(donor({ role: 'USER' }));

    renderNavbar();

    await waitFor(() => expect(screen.queryByText('login')).toBeNull());
    expect(screen.queryByText('wallet')).toBeNull(); // collapsed until opened

    const trigger = screen.getByText(/donor@example.com/);
    fireEvent.click(trigger);

    expect(await screen.findByText('wallet')).toBeDefined();
    expect(screen.getByText('logout')).toBeDefined();
    expect(screen.queryByText('moderate')).toBeNull();
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('shows moderate but not admin for a MODERATOR donor', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getDonor).mockResolvedValue(donor({ role: 'MODERATOR' }));

    renderNavbar();

    const trigger = await screen.findByText(/donor@example.com/);
    fireEvent.click(trigger);

    expect(await screen.findByText('moderate')).toBeDefined();
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('shows both moderate and admin for an ADMIN donor', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getDonor).mockResolvedValue(donor({ role: 'ADMIN' }));

    renderNavbar();

    const trigger = await screen.findByText(/donor@example.com/);
    fireEvent.click(trigger);

    expect(await screen.findByText('moderate')).toBeDefined();
    expect(await screen.findByText('admin')).toBeDefined();
  });
});
