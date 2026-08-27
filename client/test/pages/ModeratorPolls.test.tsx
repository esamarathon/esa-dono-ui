import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import { ModeratorChannelFilterProvider } from '../../src/context/ModeratorChannelFilterContext';
import ModeratorPolls from '../../src/pages/moderator/ModeratorPolls';

const poll = {
  id: 'p1',
  title: 'Best runner',
  description: null,
  options: [{ id: 'o1', label: 'Runner A', votes_cents: 500 }],
  total_votes_cents: 500,
  ends_at: null,
  is_active: true,
  allow_custom_entries: false,
  channel_id: null,
};

describe('ModeratorPolls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists polls with their options', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('Best runner')).toBeInTheDocument();
    expect(screen.getByText(/Runner A/)).toBeInTheDocument();
  });
});
