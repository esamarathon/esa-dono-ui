import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getDonor: vi.fn(),
  requestToken: vi.fn(),
  getOAuthProviders: vi.fn(),
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
}));
vi.mock('../../src/api/auth', () => ({ getOAuthProviders: mocks.getOAuthProviders }));
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
