import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import { ModeratorChannelFilterProvider } from '../../src/context/ModeratorChannelFilterContext';
import ModeratorClaims from '../../src/pages/moderator/ModeratorClaims';

const claim = {
  id: 'cl1',
  status: 'PENDING',
  claim_data: { name: 'Alice', message: 'hi' },
  created_at: '2026-01-01T00:00:00Z',
  donor_name: 'Jane Donor',
  reward: { title: 'T-shirt', type: 'PHYSICAL', channel_id: null },
};

describe('ModeratorClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the donor's real (human-readable) identity alongside the claimed incentive (#57)", async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/claims' ? [claim] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorClaims />
      </ModeratorChannelFilterProvider>,
    );

    // The incentive (reward) and the donor identity are both glanceable,
    // and neither is a raw id/uuid.
    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText('donor: Jane Donor')).toBeInTheDocument();
    // The self-entered claim field (e.g. a shoutout name) is shown
    // separately and is never confused with the donor's own identity.
    expect(screen.getByText('entered name: Alice')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark fulfilled|mark pending/ })).toBeNull();
  });

  it('falls back to "Anonymous" (never a uuid) when no donor_name is available', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({
        data: path === '/claims' ? [{ ...claim, donor_name: null, claim_data: null }] : [],
      }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorClaims />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('donor: Anonymous')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorClaims />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText(/No claims yet/)).toBeInTheDocument();
  });
});
