import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getPledge: vi.fn(),
  startSession: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../src/api/pledge', () => ({ getPledge: mocks.getPledge }));
vi.mock('../../src/utils/authToken', () => ({ startSession: mocks.startSession }));
vi.mock('../../src/lib/tracing', () => ({ track: mocks.track }));

import PledgeReturn from '../../src/pages/PledgeReturn';

const fulfilledPledge = {
  status: 'FULFILLED',
  total_cents: 1000,
  magic_token: null,
  expires_at: '2099-01-01T00:00:00Z',
  items: [{ id: 'i1', kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }],
};

function renderWithToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/pledge/${token}`]}>
      <Routes>
        <Route path="/pledge/:token" element={<PledgeReturn />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PledgeReturn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an error when no token is provided', async () => {
    render(
      <MemoryRouter>
        <PledgeReturn />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No pledge token provided.')).toBeInTheDocument();
  });

  it('renders the fulfilled state with items', async () => {
    mocks.getPledge.mockResolvedValue(fulfilledPledge);

    renderWithToken('tok123');

    expect(await screen.findByText(/Your pledge has been fulfilled/)).toBeInTheDocument();
    expect(screen.getByText('Reward')).toBeInTheDocument();
    expect(screen.getAllByText('$10.00')).toHaveLength(2);
  });

  it('renders the expired state', async () => {
    mocks.getPledge.mockResolvedValue({ ...fulfilledPledge, status: 'EXPIRED' });

    renderWithToken('tok123');

    expect(await screen.findByText(/This pledge has expired/)).toBeInTheDocument();
  });

  it('starts a session and navigates when fulfilled with a magic token', async () => {
    mocks.getPledge.mockResolvedValue({
      ...fulfilledPledge,
      magic_token: 'tok123',
    });
    mocks.startSession.mockResolvedValue(undefined);

    renderWithToken('tok123');

    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledWith('tok123'));
  });
});
