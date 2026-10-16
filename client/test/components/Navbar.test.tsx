import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../src/components/Navbar';
import { DraftPledgeProvider as CartProvider } from '../../src/context/DraftPledgeContext';
import type { DonorWallet } from '../../src/types';

vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));
vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/pledge', () => ({ createPledge: vi.fn(), getPledge: vi.fn() }));
vi.mock('../../src/api/featureFlags', () => ({ getFeatureFlags: vi.fn() }));
vi.mock('../../src/lib/tracing', () => ({
  track: vi.fn(),
  trackAsync: vi.fn((_n: string, fn: () => unknown) => fn()),
  identifyDonor: vi.fn(),
}));
vi.mock('../../src/utils/authToken', () => ({
  isSessionActive: () => localStorage.getItem('donor_session_active') === '1',
  endSession: vi.fn().mockResolvedValue(undefined),
}));

import { getDonor } from '../../src/api/donor';
import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getChannels } from '../../src/api/channels';
import { getFeatureFlags } from '../../src/api/featureFlags';

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
    sessionStorage.clear();
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getChannels).mockResolvedValue([]);
    vi.mocked(getFeatureFlags).mockResolvedValue({});
  });

  it('shows a plain login link when no donor token is present', async () => {
    renderNavbar();
    expect(await screen.findByText('login')).toBeDefined();
    expect(screen.queryByText('logged in as')).toBeNull();
  });

  it('labels the primary donation link donate when no draft exists', async () => {
    renderNavbar();
    expect(await screen.findByRole('link', { name: 'donate' })).toHaveAttribute('href', '/donate');
    expect(screen.queryByRole('link', { name: 'contribute' })).not.toBeInTheDocument();
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

  it('offers resume to the saved Channel and step outside donate, with no cart button', async () => {
    localStorage.setItem(
      'donation_draft_v1',
      JSON.stringify({
        id: 'nav-draft',
        updatedAt: Date.now(),
        amountCents: 2500,
        selections: [],
        channelId: 'c1',
        eventSlug: 'marathon',
        path: '/donate/marathon/main',
        comment: '',
        displayName: '',
        lastStep: 'browse',
        tab: 'polls',
        pendingToken: null,
      }),
    );
    vi.mocked(getChannels).mockResolvedValue([
      { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true },
    ]);
    renderNavbar();
    expect(await screen.findByRole('link', { name: 'resume $25.00 donation' })).toHaveAttribute(
      'href',
      '/donate/marathon/main?step=browse&tab=polls&channel=c1',
    );
    expect(screen.queryByRole('button', { name: /cart/i })).not.toBeInTheDocument();
  });

  it('hides the auctions nav link when the auctions feature flag is disabled/absent', async () => {
    renderNavbar();
    await screen.findByText('login');
    expect(screen.queryByText('auctions')).toBeNull();
  });

  it('shows the auctions nav link when the auctions feature flag is enabled', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ auctions: true });
    renderNavbar();
    expect(await screen.findByText('auctions')).toBeDefined();
  });
});
