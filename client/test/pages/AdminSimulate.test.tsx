import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminSimulate from '../../src/pages/admin/AdminSimulate';

describe('AdminSimulate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminClient.get.mockResolvedValue({ data: [] });
  });

  it('renders the form', () => {
    render(<AdminSimulate />);

    expect(screen.getByRole('heading', { name: 'add donation' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('donor@example.com')).toBeInTheDocument();
  });

  it('creates a donation and shows the result', async () => {
    adminClient.post.mockResolvedValue({
      data: { token: 'tok123', donor: { balance_remaining: 1000 } },
    });

    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    expect(await screen.findByText('donation created!')).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/token=tok123/)).toBeInTheDocument();
  });

  it('fills all form fields including donor name and comment', async () => {
    adminClient.post.mockResolvedValue({
      data: { token: 'tok', donor: { balance_remaining: 500 } },
    });

    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Anonymous'), {
      target: { value: 'Alice' },
    });
    fireEvent.change(screen.getByPlaceholderText('Optional comment'), {
      target: { value: 'A comment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    expect(await screen.findByText('donation created!')).toBeInTheDocument();
  });

  it('shows an error when the amount is below the minimum', () => {
    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    // Change amount to 0
    const amountInput = screen.getByRole('spinbutton');
    fireEvent.change(amountInput, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    expect(screen.getByText(/Minimum amount/)).toBeInTheDocument();
  });

  it('loads channels and submits the selected channel_id (#62)', async () => {
    adminClient.get.mockResolvedValue({
      data: [{ id: 'c1', name: 'Main Marathon', is_active: true }],
    });
    adminClient.post.mockResolvedValue({
      data: { token: 'tok', donor: { balance_remaining: 500 } },
    });

    render(<AdminSimulate />);

    expect(await screen.findByText('Main Marathon')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByDisplayValue('shared / no channel'), {
      target: { value: 'c1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith(
        '/simulate-donation',
        expect.objectContaining({ channel_id: 'c1' }),
      ),
    );
  });

  it('submits an external reference for recording a real externally-received donation (#62)', async () => {
    adminClient.post.mockResolvedValue({
      data: { token: 'tok', donor: { balance_remaining: 500 } },
    });

    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hekathon-12345'), {
      target: { value: 'hekathon-999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith(
        '/simulate-donation',
        expect.objectContaining({ external_id: 'hekathon-999' }),
      ),
    );
  });

  it('shows the server error message on a duplicate external reference', async () => {
    adminClient.post.mockRejectedValue({
      response: { data: { error: 'A donation with external_id "hekathon-999" already exists' } },
    });

    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add donation' }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});
