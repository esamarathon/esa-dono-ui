import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import ModeratorDashboard from '../../src/pages/moderator/ModeratorDashboard';

describe('ModeratorDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stats', async () => {
    moderatorClient.get.mockResolvedValue({
      data: { pending_entries: 2, active_polls: 3, total_rewards: 4, total_goals: 5 },
    });

    render(<ModeratorDashboard />);

    expect(await screen.findByText('moderator dashboard')).toBeInTheDocument();
    expect(screen.getByText('pending entries')).toBeInTheDocument();
  });

  it('shows an error when stats fail to load', async () => {
    moderatorClient.get.mockRejectedValue(new Error('boom'));

    render(<ModeratorDashboard />);

    expect(await screen.findByText(/Unable to load moderator stats/)).toBeInTheDocument();
  });
});
