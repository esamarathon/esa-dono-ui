import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

  it('adds an option to a poll', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    moderatorClient.post.mockResolvedValue({ data: { id: 'o2' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.change(await screen.findByPlaceholderText('New option...'), {
      target: { value: 'Runner B' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/polls/p1/options', {
        label: 'Runner B',
      }),
    );
  });

  it('removes an option from a poll', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    moderatorClient.delete.mockResolvedValue({ data: { success: true } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'remove' }));

    await waitFor(() => expect(moderatorClient.delete).toHaveBeenCalledWith('/polls/options/o1'));
  });

  it('loads custom entries for a poll', async () => {
    const customPoll = { ...poll, allow_custom_entries: true };
    moderatorClient.get.mockImplementation((path: string) => {
      if (path === '/polls') return Promise.resolve({ data: [customPoll] });
      if (path === '/polls/p1/custom-entries') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'custom entries' }));

    expect(await screen.findByText(/No entries yet/)).toBeInTheDocument();
  });

  it('creates a poll', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });
    moderatorClient.post.mockResolvedValue({ data: { id: 'p2' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new poll' }));
    expect(screen.getByText('new poll')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/polls', expect.any(Object)),
    );
  });

  it('edits a poll', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    moderatorClient.put.mockResolvedValue({ data: poll });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    const editBtns = await screen.findAllByRole('button', { name: 'edit' });
    fireEvent.click(editBtns[0]!);
    expect(screen.getByText('edit poll')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.put).toHaveBeenCalledWith('/polls/p1', expect.any(Object)),
    );
  });

  it('renames a poll option inline', async () => {
    moderatorClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    moderatorClient.patch.mockResolvedValue({ data: { id: 'o1', label: 'Renamed' } });

    render(
      <ModeratorChannelFilterProvider>
        <ModeratorPolls />
      </ModeratorChannelFilterProvider>,
    );

    const editBtns = await screen.findAllByRole('button', { name: 'edit' });
    fireEvent.click(editBtns[1]!);
    const inlineInputs = screen.getAllByRole('textbox');
    fireEvent.change(inlineInputs[inlineInputs.length - 1]!, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.patch).toHaveBeenCalledWith('/polls/options/o1', expect.any(Object)),
    );
  });
});
