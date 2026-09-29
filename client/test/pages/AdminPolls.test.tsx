import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  refundPollOption: vi.fn(),
  refundGoal: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: mocks.adminClient,
  refundPollOption: mocks.refundPollOption,
  refundGoal: mocks.refundGoal,
}));

import AdminPolls from '../../src/pages/admin/AdminPolls';

const poll = {
  id: 'p1',
  title: 'Best Runner',
  description: null,
  options: [{ id: 'o1', label: 'Runner A', votes_cents: 0 }],
  total_votes_cents: 0,
  is_active: true,
  allow_custom_entries: false,
  channel_id: null,
};

describe('AdminPolls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists polls', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    render(<AdminPolls />);
    expect(await screen.findByText('Best Runner')).toBeInTheDocument();
    expect(screen.getByText(/Runner A/)).toBeInTheDocument();
  });

  it('creates a poll', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'p2' } });
    render(<AdminPolls />);
    fireEvent.click(await screen.findByRole('button', { name: '+ new poll' }));
    expect(screen.getByText('new poll')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/polls', expect.any(Object)),
    );
  });

  it('edits a poll', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    mocks.adminClient.put.mockResolvedValue({ data: poll });
    render(<AdminPolls />);
    const editBtns = await screen.findAllByRole('button', { name: 'edit' });
    fireEvent.click(editBtns[0]!);
    expect(screen.getByText('edit poll')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.put).toHaveBeenCalledWith('/polls/p1', expect.any(Object)),
    );
  });

  it('adds an option to a poll', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'o2' } });
    render(<AdminPolls />);
    const input = await screen.findByPlaceholderText('New option...');
    fireEvent.change(input, { target: { value: 'Runner B' } });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/polls/p1/options', {
        label: 'Runner B',
      }),
    );
  });

  it('starts editing a poll option inline', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    mocks.adminClient.patch.mockResolvedValue({ data: { id: 'o1', label: 'Renamed' } });
    render(<AdminPolls />);
    const editBtns = await screen.findAllByRole('button', { name: 'edit' });
    fireEvent.click(editBtns[1]!);
    const inlineInputs = screen.getAllByRole('textbox');
    fireEvent.change(inlineInputs[inlineInputs.length - 1]!, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.patch).toHaveBeenCalledWith('/polls/options/o1', expect.any(Object)),
    );
  });

  it('deletes a poll after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [] }),
    );
    mocks.adminClient.delete.mockResolvedValue({ data: { success: true } });
    render(<AdminPolls />);
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    await waitFor(() => expect(mocks.adminClient.delete).toHaveBeenCalledWith('/polls/p1'));
  });

  it('shows extra custom-entry fields when allow_custom_entries is toggled on', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    render(<AdminPolls />);
    fireEvent.click(await screen.findByRole('button', { name: '+ new poll' }));
    fireEvent.click(screen.getByLabelText('allow custom entries'));
    expect(
      screen.getByLabelText('auto-approve write-ins (off = review before funds count)'),
    ).toBeInTheDocument();
  });

  it('fills all poll modal fields including custom entry options', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'p2' } });
    render(<AdminPolls />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new poll' }));

    // Toggle allow_custom_entries ON to show extra fields
    fireEvent.click(screen.getByLabelText('allow custom entries'));
    // Toggle auto_approve OFF
    fireEvent.click(
      screen.getByLabelText('auto-approve write-ins (off = review before funds count)'),
    );
    // Fill max_entry_chars
    fireEvent.change(screen.getByPlaceholderText('No limit'), { target: { value: '100' } });
    // Toggle active off then back on
    fireEvent.click(screen.getByLabelText('active'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/polls', expect.any(Object)),
    );
  });
});
