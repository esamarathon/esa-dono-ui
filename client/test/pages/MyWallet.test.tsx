import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getDonor: vi.fn(),
  requestToken: vi.fn(),
  getOAuthProviders: vi.fn(),
  getFeatureFlags: vi.fn(),
  track: vi.fn(),
  identifyDonor: vi.fn(),
  startSession: vi.fn(),
  endSession: vi.fn(),
  noteSessionEstablished: vi.fn(),
  clearSessionMarker: vi.fn(),
}));

vi.mock('../../src/api/donor', () => ({
  getDonor: mocks.getDonor,
  requestToken: mocks.requestToken,
  getPoolCredits: vi.fn().mockResolvedValue({ wallet_credit_cents: 0, events: [] }),
  getPoolCreditEvent: vi.fn(),
  applyPoolCredits: vi.fn(),
}));
vi.mock('../../src/api/auth', () => ({ getOAuthProviders: mocks.getOAuthProviders }));
vi.mock('../../src/api/featureFlags', () => ({ getFeatureFlags: mocks.getFeatureFlags }));
vi.mock('../../src/lib/tracing', () => ({
  track: mocks.track,
  identifyDonor: mocks.identifyDonor,
}));
vi.mock('../../src/utils/authToken', () => ({
  extractToken: (v: string) => (v || '').trim(),
  startSession: mocks.startSession,
  endSession: mocks.endSession,
  noteSessionEstablished: mocks.noteSessionEstablished,
  clearSessionMarker: mocks.clearSessionMarker,
}));

import MyWallet from '../../src/pages/MyWallet';

const wallet = {
  id: 'd1',
  email: 'alice@example.com',
  balance_remaining: 1000,
  total_donated: 5000,
  role: 'USER',
  donations: [],
  reward_claims: [],
  poll_votes: [],
  fund_contributions: [],
  custom_entries: [],
};

describe('MyWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthProviders.mockResolvedValue({ providers: [] });
    mocks.getFeatureFlags.mockResolvedValue({ auctions: false });
  });

  it('shows the login form when there is no session', async () => {
    mocks.getDonor.mockRejectedValue(new Error('no session'));

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('access your wallet')).toBeInTheDocument();
  });

  it('shows the wallet when a donor is logged in', async () => {
    mocks.getDonor.mockResolvedValue(wallet);

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('my wallet')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('No donations yet.')).toBeInTheDocument();
  });

  it.each([
    { state: 'disabled', flags: { auctions: false } },
    { state: 'missing', flags: {} },
    { state: 'unavailable', flags: new Error('flags unavailable') },
  ])('hides auction empty states when the flag is $state', async ({ flags }) => {
    if (flags instanceof Error) {
      mocks.getFeatureFlags.mockRejectedValue(flags);
    } else {
      mocks.getFeatureFlags.mockResolvedValue(flags);
    }
    mocks.getDonor.mockResolvedValue(wallet);

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('my wallet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'my bids' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'my auction wins' })).not.toBeInTheDocument();
    expect(screen.queryByText('No auction bids yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('No auction wins yet.')).not.toBeInTheDocument();
  });

  it('shows auction empty states when auctions are enabled', async () => {
    mocks.getFeatureFlags.mockResolvedValue({ auctions: true });
    mocks.getDonor.mockResolvedValue(wallet);

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No auction bids yet.')).toBeInTheDocument();
    expect(screen.getByText('No auction wins yet.')).toBeInTheDocument();
  });

  it.each([false, true])('gates existing auction details with auctions=%s', async (enabled) => {
    mocks.getFeatureFlags.mockResolvedValue({ auctions: enabled });
    mocks.getDonor.mockResolvedValue({
      ...wallet,
      bids: [
        {
          id: 'bid1',
          amount_cents: 1000,
          status: 'ACTIVE',
          created_at: '2026-01-01T00:00:00Z',
          auction: { title: 'Signed guitar bid', status: 'OPEN' },
        },
      ],
      auction_offers: [
        {
          id: 'offer1',
          amount_cents: 2000,
          checkout_url: 'https://checkout.example.com/offer1',
          expires_at: '2026-01-02T00:00:00Z',
          auction: { title: 'Signed poster offer' },
        },
      ],
      auction_wins: [
        {
          id: 'win1',
          winning_bid_cents: 3000,
          status: 'FULFILLED',
          created_at: '2026-01-01T00:00:00Z',
          auction: { title: 'Signed game win' },
        },
      ],
    });

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('my wallet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'my bids' }) !== null).toBe(enabled);
    expect(screen.queryByRole('heading', { name: 'my auction wins' }) !== null).toBe(enabled);
    expect(screen.queryByRole('heading', { name: 'pay for your win' }) !== null).toBe(enabled);
    expect(screen.queryByText('Signed guitar bid') !== null).toBe(enabled);
    expect(screen.queryByText('Signed poster offer') !== null).toBe(enabled);
    expect(screen.queryByText('Signed game win') !== null).toBe(enabled);
    expect(screen.queryByRole('link', { name: 'pay now' }) !== null).toBe(enabled);
    expect(screen.getByRole('heading', { name: 'donation history' })).toBeInTheDocument();
  });

  it("shows each donation's channel in the donation history (#53)", async () => {
    mocks.getDonor.mockResolvedValue({
      ...wallet,
      donations: [
        {
          id: 'don1',
          amount_cents: 1000,
          comment: null,
          created_at: '2026-01-01T00:00:00Z',
          channel: { id: 'c1', name: 'Main Marathon' },
        },
        {
          id: 'don2',
          amount_cents: 500,
          comment: null,
          created_at: '2026-01-02T00:00:00Z',
          channel: null,
        },
      ],
    });

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Main Marathon')).toBeInTheDocument();
    expect(screen.getByText('shared')).toBeInTheDocument();
  });

  it('submits a token and starts a session', async () => {
    mocks.getDonor.mockRejectedValue(new Error('no session'));
    mocks.startSession.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByPlaceholderText('https://.../wallet?token=...'), {
      target: { value: 'tok123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'open wallet' }));

    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledWith('tok123'));
  });

  it('rejects an empty token', async () => {
    mocks.getDonor.mockRejectedValue(new Error('no session'));

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'open wallet' }));

    expect(
      await screen.findByText(/Paste the full magic link from your email/),
    ).toBeInTheDocument();
  });

  it('requests a new magic link by email', async () => {
    mocks.getDonor.mockRejectedValue(new Error('no session'));
    mocks.requestToken.mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'send me a new link' }));

    expect(await screen.findByText(/fresh link is on its way/)).toBeInTheDocument();
  });

  it('logs out and clears the donor', async () => {
    mocks.getDonor.mockResolvedValue(wallet);
    mocks.endSession.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'logout' }));

    await waitFor(() => expect(mocks.endSession).toHaveBeenCalled());
  });

  it('shows a validation error for an invalid email address', async () => {
    mocks.getDonor.mockRejectedValue(new Error('no session'));

    render(
      <MemoryRouter>
        <MyWallet />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), {
      target: { value: 'notanemail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'send me a new link' }));

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
  });
});
