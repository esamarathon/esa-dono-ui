import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getPledge: vi.fn(),
  isSessionActive: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../src/api/pledge', () => ({ getPledge: mocks.getPledge }));
vi.mock('../../src/utils/authToken', () => ({ isSessionActive: mocks.isSessionActive }));
vi.mock('../../src/lib/tracing', () => ({ track: mocks.track }));

import PledgeReturn from '../../src/pages/PledgeReturn';

const fulfilledPledge = {
  status: 'FULFILLED',
  total_cents: 1000,
  expires_at: '2099-01-01T00:00:00Z',
  items: [{ id: 'i1', kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }],
};

function renderWithToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/pledge/${token}`]}>
      <Routes>
        <Route path="/pledge/:token" element={<PledgeReturn />} />
        <Route path="/wallet" element={<div>wallet page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PledgeReturn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSessionActive.mockReturnValue(false);
  });

  it('shows an error when no token is provided', async () => {
    render(
      <MemoryRouter>
        <PledgeReturn />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No pledge token provided.')).toBeInTheDocument();
  });

  it('renders the fulfilled state with items and stays put when logged out', async () => {
    mocks.getPledge.mockResolvedValue(fulfilledPledge);

    renderWithToken('tok123');

    expect(await screen.findByText(/Your pledge has been fulfilled/)).toBeInTheDocument();
    expect(screen.getByText('Reward')).toBeInTheDocument();
    expect(screen.getAllByText('$10.00')).toHaveLength(2);
    expect(screen.queryByText('wallet page')).not.toBeInTheDocument();
  });

  it('renders the expired state', async () => {
    mocks.getPledge.mockResolvedValue({ ...fulfilledPledge, status: 'EXPIRED' });

    renderWithToken('tok123');

    expect(await screen.findByText(/This pledge has expired/)).toBeInTheDocument();
  });

  it('navigates straight to the wallet when the browser already has an active session', async () => {
    // A returning, already-logged-in donor shouldn't have to click the magic
    // link again for their 2nd/3rd/... donation.
    mocks.getPledge.mockResolvedValue(fulfilledPledge);
    mocks.isSessionActive.mockReturnValue(true);

    renderWithToken('tok123');

    expect(await screen.findByText('wallet page')).toBeInTheDocument();
  });

  it('never auto-authenticates from a pledge return, even when fulfilled (account takeover guard, #48)', async () => {
    // Regression: no code path here may establish a session. The only way to
    // get a session for a fresh or logged-out donor is clicking the emailed
    // magic link, which proves ownership of the inbox — pledge-token
    // possession alone must never be enough to log in as the pledge's donor.
    mocks.getPledge.mockResolvedValue(fulfilledPledge);
    mocks.isSessionActive.mockReturnValue(false);

    renderWithToken('tok123');

    await screen.findByText(/Your pledge has been fulfilled/);
    expect(screen.queryByText('wallet page')).not.toBeInTheDocument();
  });
});
