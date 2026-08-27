import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminChannels from '../../src/pages/admin/AdminChannels';

describe('AdminChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists channels', async () => {
    adminClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });

    render(<AdminChannels />);

    expect(await screen.findByText('Main')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    adminClient.get.mockResolvedValue({ data: [] });

    render(<AdminChannels />);

    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
  });

  it('creates a channel', async () => {
    adminClient.get.mockResolvedValue({ data: [] });
    adminClient.post.mockResolvedValue({ data: { id: 'c2', name: 'New', is_active: true } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new channel' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith(
        '/channels',
        expect.objectContaining({ name: 'New' }),
      ),
    );
  });

  it('edits a channel', async () => {
    adminClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });
    adminClient.put.mockResolvedValue({ data: { id: 'c1', name: 'Renamed', is_active: true } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith(
        '/channels/c1',
        expect.objectContaining({ name: 'Renamed' }),
      ),
    );
  });

  it('deactivates a channel after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });
    adminClient.delete.mockResolvedValue({ data: { success: true } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'deactivate' }));

    await waitFor(() => expect(adminClient.delete).toHaveBeenCalledWith('/channels/c1'));
    vi.unstubAllGlobals();
  });
});
