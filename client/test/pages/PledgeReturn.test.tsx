import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getPledge: vi.fn(),
  reconcilePledge: vi.fn(),
  cancelPledge: vi.fn(),
  isSessionActive: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../src/api/pledge', () => ({
  getPledge: mocks.getPledge,
  reconcilePledge: mocks.reconcilePledge,
  cancelPledge: mocks.cancelPledge,
}));
vi.mock('../../src/utils/authToken', () => ({ isSessionActive: mocks.isSessionActive }));
vi.mock('../../src/lib/tracing', () => ({ track: mocks.track }));

import PledgeReturn from '../../src/pages/PledgeReturn';

const fulfilledPledge = {
  format: 'LEGACY',
  status: 'FULFILLED',
  payment_state: 'FULFILLED',
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
  it('keeps overdue processing read-only rather than treating a local deadline as non-payment', async () => {
    const pending = {
      ...fulfilledPledge,
      format: 'POOLED',
      pledge_amount_cents: 1000,
      status: 'OPEN',
      payment_state: 'PROCESSING',
      expires_at: '2000-01-01',
    };
    mocks.getPledge.mockResolvedValue(pending);
    mocks.reconcilePledge.mockResolvedValue(pending);
    renderWithToken('processing');
    expect(await screen.findByText(/Processing your pledge/)).toBeInTheDocument();
    expect(screen.queryByText(/This pledge has expired/)).not.toBeInTheDocument();
  });

  it.each(['PAYMENT_REVIEW', 'LEGACY_PAID'])(
    'does not call the original incentives fulfilled for %s',
    async (outcome) => {
      mocks.getPledge.mockResolvedValue({
        ...fulfilledPledge,
        status: outcome,
        payment_state: outcome,
      });
      renderWithToken('late');
      expect(
        await screen.findByText(/original incentives were not fulfilled/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Your pledge has been fulfilled/)).not.toBeInTheDocument();
      expect(screen.queryByText('wallet page')).not.toBeInTheDocument();
    },
  );

  it('uses the distinct cancel return action before polling, without establishing authentication', async () => {
    const cancelled = {
      ...fulfilledPledge,
      format: 'POOLED',
      pledge_amount_cents: 1000,
      status: 'CANCELLED',
      payment_state: 'NON_PAYMENT',
    };
    mocks.cancelPledge.mockResolvedValue(cancelled);
    renderWithToken('cancel-token?cancelled=1');
    expect(await screen.findByText(/Non-payment confirmed/)).toBeInTheDocument();
    expect(mocks.cancelPledge).toHaveBeenCalledWith('cancel-token');
    expect(screen.queryByText('wallet page')).not.toBeInTheDocument();
  });
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
    expect(screen.getAllByText('$10.00')).toHaveLength(1);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('wallet page')).not.toBeInTheDocument();
  });

  it('renders the expired state', async () => {
    mocks.getPledge.mockResolvedValue({
      ...fulfilledPledge,
      status: 'EXPIRED',
      payment_state: 'NON_PAYMENT',
    });

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
