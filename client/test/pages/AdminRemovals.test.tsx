import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  refundPollOption: vi.fn(),
  refundGoal: vi.fn(),
  getReversalPreview: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: mocks.adminClient,
  refundPollOption: mocks.refundPollOption,
  refundGoal: mocks.refundGoal,
  getReversalPreview: mocks.getReversalPreview,
}));

import AdminPolls from '../../src/pages/admin/AdminPolls';
import AdminGoals from '../../src/pages/admin/AdminGoals';

const poll = {
  id: 'poll-1',
  title: 'Best runner',
  description: null,
  options: [{ id: 'option-1', label: 'Runner A', votes_cents: 500 }],
  total_votes_cents: 500,
  is_active: true,
  allow_custom_entries: false,
  ends_at: null,
};

const goal = {
  id: 'goal-1',
  title: 'Race entry',
  description: null,
  current_cents: 750,
  target_cents: 2000,
  is_active: true,
  is_complete: false,
};

function renderPage(page: 'polls' | 'goals') {
  return render(<MemoryRouter>{page === 'polls' ? <AdminPolls /> : <AdminGoals />}</MemoryRouter>);
}

describe('admin funded removals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn());
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/polls' ? [poll] : [goal] }),
    );
    mocks.adminClient.delete.mockResolvedValue({ data: { success: true } });
  });

  it('requires confirmation and warns before removing a funded poll option', async () => {
    mocks.getReversalPreview.mockResolvedValue({
      destinations: [
        {
          destination: 'Pool credit',
          category: 'poll',
          donation_id: 'd1',
          credit_id: null,
          amount_cents: 500,
        },
      ],
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    renderPage('polls');

    fireEvent.click(await screen.findByRole('button', { name: 'remove' }));

    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(
        expect.stringContaining('+$5.00 poll Pool credit of donation d1'),
      ),
    );
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('This cannot be undone.'));
    expect(mocks.adminClient.delete).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'remove' }));

    await waitFor(() => {
      expect(mocks.adminClient.delete).toHaveBeenCalledWith('/polls/options/option-1');
    });
  });

  it('requires confirmation and warns before removing a funded goal', async () => {
    mocks.getReversalPreview.mockResolvedValue({
      destinations: [
        {
          destination: 'Pool credit',
          category: 'goal',
          donation_id: 'd1',
          credit_id: null,
          amount_cents: 750,
        },
      ],
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    renderPage('goals');

    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));

    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(
        expect.stringContaining('+$7.50 goal Pool credit of donation d1'),
      ),
    );
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('This cannot be undone.'));
    expect(mocks.adminClient.delete).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => {
      expect(mocks.adminClient.delete).toHaveBeenCalledWith('/goals/goal-1');
    });
  });
});
