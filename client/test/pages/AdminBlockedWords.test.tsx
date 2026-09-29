import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminBlockedWords from '../../src/pages/admin/AdminBlockedWords';

describe('AdminBlockedWords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists blocked words', async () => {
    adminClient.get.mockResolvedValue({ data: [{ id: 'w1', word: 'spam' }] });

    render(<AdminBlockedWords />);

    expect(await screen.findByText('spam')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    adminClient.get.mockResolvedValue({ data: [] });

    render(<AdminBlockedWords />);

    expect(await screen.findByText(/No blocked words yet/)).toBeInTheDocument();
  });

  it('adds a blocked word', async () => {
    adminClient.get.mockResolvedValue({ data: [] });
    adminClient.post.mockResolvedValue({ data: { id: 'w2', word: 'spam' } });

    render(<AdminBlockedWords />);

    fireEvent.change(await screen.findByPlaceholderText('Add a word...'), {
      target: { value: 'spam' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith('/blocked-words', { word: 'spam' }),
    );
  });

  it('removes a blocked word', async () => {
    adminClient.get.mockResolvedValue({ data: [{ id: 'w1', word: 'spam' }] });
    adminClient.delete.mockResolvedValue({ data: { success: true } });

    render(<AdminBlockedWords />);

    fireEvent.click(await screen.findByRole('button', { name: 'remove' }));

    await waitFor(() => expect(adminClient.delete).toHaveBeenCalledWith('/blocked-words/w1'));
  });
});
