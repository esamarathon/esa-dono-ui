import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import { ModeratorChannelFilterProvider } from '../../src/context/ModeratorChannelFilterContext';
import ModeratorDonations from '../../src/pages/moderator/ModeratorDonations';

const donation = {
  id: 'd1',
  amount_cents: 2500,
  donor_name: 'Alice',
  comment: 'thanks',
  created_at: '2026-01-01T00:00:00Z',
  channel: null,
  moderated: false,
};

describe('ModeratorDonations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists donations', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/donations' ? [donation] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorDonations />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('UNMODERATED')).toBeInTheDocument();
  });

  it('shows what the donor selected/pledged toward, human-readable (#58)', async () => {
    const donationWithPledge = {
      ...donation,
      pledge_items: [
        { kind: 'REWARD', label: 'T-shirt', amount_cents: 500 },
        { kind: 'POLL_VOTE', label: 'Best Runner: Runner A', amount_cents: 400 },
      ],
      top_up_cents: 1000,
    };
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/donations' ? [donationWithPledge] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorDonations />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText(/T-shirt/)).toBeInTheDocument();
    expect(screen.getByText(/Best Runner: Runner A/)).toBeInTheDocument();
    expect(screen.getByText(/additional contribution/)).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorDonations />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText(/No donations yet/)).toBeInTheDocument();
  });
});
