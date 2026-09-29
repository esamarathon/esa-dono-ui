import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/api/campaign', () => ({ getCampaign: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn(), requestToken: vi.fn() }));
vi.mock('../../src/api/pledge', () => ({ createPledge: vi.fn(), getPledge: vi.fn() }));
vi.mock('../../src/lib/tracing', () => ({
  track: vi.fn(),
  trackAsync: vi.fn(),
  identifyDonor: vi.fn(),
}));

import { getCampaign } from '../../src/api/campaign';
import { getChannels } from '../../src/api/channels';
import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getDonor } from '../../src/api/donor';

import App from '../../src/App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCampaign).mockResolvedValue({ name: 'Test Campaign' });
    vi.mocked(getChannels).mockResolvedValue([]);
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getDonor).mockRejectedValue(new Error('no session'));
  });

  it('renders the home page with the campaign name', async () => {
    render(<App />);

    expect(await screen.findByText('Test Campaign')).toBeInTheDocument();
    expect(screen.getByText('contribute now')).toBeInTheDocument();
  });
});
