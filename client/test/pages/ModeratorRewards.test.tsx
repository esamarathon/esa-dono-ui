import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import { ModeratorChannelFilterProvider } from '../../src/context/ModeratorChannelFilterContext';
import ModeratorRewards from '../../src/pages/moderator/ModeratorRewards';

const reward = {
  id: 'r1',
  title: 'T-shirt',
  type: 'PHYSICAL',
  cost_cents: 2000,
  quantity_total: 10,
  quantity_claimed: 2,
  is_active: true,
  channel_id: null,
};

describe('ModeratorRewards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists rewards', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/rewards' ? [reward] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorRewards />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText(/PHYSICAL · \$20\.00/)).toBeInTheDocument();
  });

  it('creates a reward', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });
    moderatorClient.post.mockResolvedValue({ data: { id: 'r2' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorRewards />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new reward' }));
    expect(screen.getByText('new reward')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/rewards', expect.any(Object)),
    );
  });

  it('deletes a reward after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/rewards' ? [reward] : [] }),
    );
    moderatorClient.delete.mockResolvedValue({ data: { success: true } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorRewards />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));

    await waitFor(() => expect(moderatorClient.delete).toHaveBeenCalledWith('/rewards/r1'));
    vi.unstubAllGlobals();
  });
});
