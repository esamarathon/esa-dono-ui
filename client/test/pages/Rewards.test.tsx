import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Rewards from '../../src/pages/Rewards';

vi.mock('../../src/api/rewards', () => ({
  getRewards: vi.fn(),
  claimReward: vi.fn(),
}));

import { getRewards } from '../../src/api/rewards';

function renderRewards() {
  return render(
    <MemoryRouter>
      <Rewards />
    </MemoryRouter>,
  );
}

describe('Rewards page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows warning when no donor token', async () => {
    vi.mocked(getRewards).mockResolvedValue([]);
    renderRewards();
    expect(await screen.findByText(/Visit your wallet link/)).toBeDefined();
  });

  it('renders rewards list', async () => {
    localStorage.setItem('donor_token', 'test-token');
    vi.mocked(getRewards).mockResolvedValue([
      {
        id: '1',
        title: 'Digital Reward',
        description: 'A digital item',
        type: 'DIGITAL',
        cost_cents: 500,
        quantity_total: null,
        quantity_claimed: 0,
        is_active: true,
      },
      {
        id: '2',
        title: 'Physical Reward',
        description: 'A physical item',
        type: 'PHYSICAL',
        cost_cents: 1000,
        quantity_total: 10,
        quantity_claimed: 3,
        is_active: true,
      },
    ]);

    renderRewards();

    expect(await screen.findByText('Digital Reward')).toBeDefined();
    expect(screen.getByText('Physical Reward')).toBeDefined();
  });
});
