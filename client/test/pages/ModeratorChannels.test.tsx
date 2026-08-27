import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import ModeratorChannels from '../../src/pages/moderator/ModeratorChannels';

describe('ModeratorChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists channels', async () => {
    moderatorClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });

    render(<ModeratorChannels />);

    expect(await screen.findByText('Main')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });

    render(<ModeratorChannels />);

    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
  });

  it('creates a channel', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });
    moderatorClient.post.mockResolvedValue({ data: { id: 'c2', name: 'New', is_active: true } });

    render(<ModeratorChannels />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new channel' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith(
        '/channels',
        expect.objectContaining({ name: 'New' }),
      ),
    );
  });

  it('deactivates a channel after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    moderatorClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });
    moderatorClient.delete.mockResolvedValue({ data: { success: true } });

    render(<ModeratorChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'deactivate' }));

    await waitFor(() => expect(moderatorClient.delete).toHaveBeenCalledWith('/channels/c1'));
    vi.unstubAllGlobals();
  });

  it('edits a channel', async () => {
    moderatorClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });
    moderatorClient.put.mockResolvedValue({ data: { id: 'c1', name: 'Renamed', is_active: true } });

    render(<ModeratorChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByRole('textbox')).toHaveValue('Main');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.put).toHaveBeenCalledWith(
        '/channels/c1',
        expect.objectContaining({ name: 'Renamed' }),
      ),
    );
  });
});
