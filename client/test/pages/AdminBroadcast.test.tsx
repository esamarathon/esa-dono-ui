import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminBroadcast from '../../src/pages/admin/AdminBroadcast';

describe('AdminBroadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the current broadcast and defaults the level selector to "default" when null', async () => {
    adminClient.get.mockResolvedValue({
      data: { id: '1', message: 'existing message', level: null, is_active: true },
    });

    render(<AdminBroadcast />);

    await screen.findByDisplayValue('existing message');
    const select = screen.getByLabelText(/severity/i) as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('preselects the saved level', async () => {
    adminClient.get.mockResolvedValue({
      data: { id: '1', message: 'careful', level: 'WARNING', is_active: true },
    });

    render(<AdminBroadcast />);

    await screen.findByDisplayValue('careful');
    const select = screen.getByLabelText(/severity/i) as HTMLSelectElement;
    expect(select.value).toBe('WARNING');
  });

  it('saves the message with the selected level', async () => {
    adminClient.get.mockResolvedValue({
      data: { id: null, message: '', level: null, is_active: false },
    });
    adminClient.put.mockResolvedValue({
      data: { id: '1', message: 'urgent notice', level: 'CRITICAL', is_active: true },
    });

    render(<AdminBroadcast />);

    await waitFor(() => expect(adminClient.get).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/enter announcement message/i), {
      target: { value: 'urgent notice' },
    });
    fireEvent.change(screen.getByLabelText(/severity/i), { target: { value: 'CRITICAL' } });
    fireEvent.click(screen.getByRole('button', { name: /save banner/i }));

    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith('/broadcast', {
        message: 'urgent notice',
        level: 'CRITICAL',
      }),
    );

    expect(await screen.findByText('urgent notice', { selector: 'div' })).toBeInTheDocument();
  });

  it('clears the message and resets the level on clear', async () => {
    adminClient.get.mockResolvedValue({
      data: { id: '1', message: 'to clear', level: 'INFO', is_active: true },
    });
    adminClient.delete.mockResolvedValue({ data: { success: true } });

    render(<AdminBroadcast />);

    await screen.findByDisplayValue('to clear');
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));

    await waitFor(() => expect(adminClient.delete).toHaveBeenCalledWith('/broadcast'));
    const select = (await screen.findByLabelText(/severity/i)) as HTMLSelectElement;
    expect(select.value).toBe('');
  });
});
