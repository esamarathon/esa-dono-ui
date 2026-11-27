import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/api/schedule', () => ({ getSchedule: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/donor', () => ({
  getDonor: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ authenticated: false }),
  requestToken: vi.fn(),
}));
vi.mock('../../src/api/pledge', () => ({ createPledge: vi.fn(), getPledge: vi.fn() }));
vi.mock('../../src/lib/tracing', () => ({
  track: vi.fn(),
  trackAsync: vi.fn(),
  identifyDonor: vi.fn(),
}));

import { getSchedule } from '../../src/api/schedule';
import { getChannels } from '../../src/api/channels';
import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getDonor } from '../../src/api/donor';

import App from '../../src/App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSchedule).mockResolvedValue({ live: null, next: null });
    vi.mocked(getChannels).mockResolvedValue([]);
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getDonor).mockRejectedValue(new Error('no session'));
  });

  it('renders the home page hero', async () => {
    render(<App />);

    expect(await screen.findByText('ESA Charity Marathon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Donate now' })).toHaveAttribute('href', '/donate');
  });
});
