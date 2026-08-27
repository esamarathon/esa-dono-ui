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
  donor: { email: 'alice@example.com' },
  reward: { title: 'T-shirt', type: 'PHYSICAL', channel_id: null },
};

describe('ModeratorClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists claims with their donor details', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/claims' ? [claim] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorClaims />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('donor: Alice')).toBeInTheDocument();
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
