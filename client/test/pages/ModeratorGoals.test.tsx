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
import ModeratorGoals from '../../src/pages/moderator/ModeratorGoals';

const goal = {
  id: 'g1',
  title: 'Race entry',
  description: null,
  current_cents: 750,
  target_cents: 2000,
  is_active: true,
  is_complete: false,
  channel_id: null,
};

describe('ModeratorGoals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists fund goals', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorGoals />
      </ModeratorChannelFilterProvider>,
    );

    expect(await screen.findByText('Race entry')).toBeInTheDocument();
    expect(screen.getByText('$7.50 / $20.00')).toBeInTheDocument();
  });

  it('creates a goal', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });
    moderatorClient.post.mockResolvedValue({ data: { id: 'g2' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorGoals />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new goal' }));
    expect(screen.getByText('new goal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/goals', expect.any(Object)),
    );
  });

  it('deletes a goal after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    moderatorClient.delete.mockResolvedValue({ data: { success: true } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorGoals />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));

    await waitFor(() => expect(moderatorClient.delete).toHaveBeenCalledWith('/goals/g1'));
    vi.unstubAllGlobals();
  });

  it('edits a goal', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    moderatorClient.put.mockResolvedValue({ data: { ...goal, title: 'Updated' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorGoals />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit goal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.put).toHaveBeenCalledWith('/goals/g1', expect.any(Object)),
    );
  });
});
