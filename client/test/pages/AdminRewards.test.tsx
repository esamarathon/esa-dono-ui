import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  uploadRewardImage: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: mocks.adminClient,
  uploadRewardImage: mocks.uploadRewardImage,
}));

import AdminRewards from '../../src/pages/admin/AdminRewards';

const reward = {
  id: 'r1',
  title: 'T-shirt',
  type: 'PHYSICAL',
  cost_cents: 2000,
  quantity_total: 10,
  quantity_claimed: 2,
  is_active: true,
};

describe('AdminRewards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists rewards', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/rewards' ? [reward] : [] }),
    );

    render(<AdminRewards />);

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
  });

  it('shows an empty table when there are no rewards', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });

    render(<AdminRewards />);

    expect(await screen.findByText('rewards')).toBeInTheDocument();
  });

  it('creates a reward', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'r2' } });

    render(<AdminRewards />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new reward' }));
    expect(screen.getByText('new reward')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/rewards', expect.any(Object)),
    );
  });

  it('deletes a reward after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mocks.adminClient.get.mockResolvedValue({ data: [reward] });
    mocks.adminClient.delete.mockResolvedValue({ data: { success: true } });

    render(<AdminRewards />);

    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));

    await waitFor(() => expect(mocks.adminClient.delete).toHaveBeenCalledWith('/rewards/r1'));
    vi.unstubAllGlobals();
  });

  it('edits an existing reward', async () => {
    mocks.adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/rewards' ? [reward] : [] }),
    );
    mocks.adminClient.put.mockResolvedValue({ data: { ...reward, title: 'Updated' } });

    render(<AdminRewards />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit reward')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.adminClient.put).toHaveBeenCalledWith('/rewards/r1', expect.any(Object)),
    );
  });
});
