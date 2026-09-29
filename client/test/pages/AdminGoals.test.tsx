import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  refundGoal: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: mocks.adminClient,
  refundGoal: mocks.refundGoal,
}));

import AdminGoals from '../../src/pages/admin/AdminGoals';

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

describe('AdminGoals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists goals', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    render(<AdminGoals />);
    expect(await screen.findByText('Race entry')).toBeInTheDocument();
  });

  it('creates a goal', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'g2' } });
    render(<AdminGoals />);
    fireEvent.click(await screen.findByRole('button', { name: '+ new goal' }));
    expect(screen.getByText('new goal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/goals', expect.any(Object)),
    );
  });

  it('edits a goal', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    mocks.adminClient.put.mockResolvedValue({ data: goal });
    render(<AdminGoals />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit goal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.put).toHaveBeenCalledWith('/goals/g1', expect.any(Object)),
    );
  });

  it('deletes a goal after confirmation', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    mocks.adminClient.delete.mockResolvedValue({ data: { success: true } });
    render(<AdminGoals />);
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    await waitFor(() => expect(mocks.adminClient.delete).toHaveBeenCalledWith('/goals/g1'));
  });

  it('shows the mark-complete checkbox when editing a goal', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    mocks.adminClient.put.mockResolvedValue({ data: goal });
    render(<AdminGoals />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByLabelText('mark complete')).toBeInTheDocument();
  });

  it('shows the complete badge for a finished goal', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [{ ...goal, is_complete: true }] : [] }),
    );
    render(<AdminGoals />);
    expect(await screen.findByText('complete')).toBeInTheDocument();
  });

  it('refunds contributions to a goal', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/goals' ? [goal] : [] }),
    );
    mocks.refundGoal.mockResolvedValue({
      success: true,
      refunded_count: 1,
      refunded_cents: 750,
    });

    render(<AdminGoals />);

    fireEvent.click(await screen.findByRole('button', { name: 'refund contributions' }));

    await waitFor(() => expect(mocks.refundGoal).toHaveBeenCalledWith('g1'));
  });
});
