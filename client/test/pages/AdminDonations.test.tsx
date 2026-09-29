import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

const assignDonationChannel = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/admin', () => ({ default: adminClient, assignDonationChannel }));

import AdminDonations from '../../src/pages/admin/AdminDonations';

const donation = {
  id: 'd1',
  amount_cents: 2500,
  donor_name: 'Alice',
  comment: 'thanks',
  created_at: '2026-01-01T00:00:00Z',
  donor: { email: 'alice@example.com' },
  status: 'COMPLETED',
  channel_id: 'c1',
  event_id: 'e1',
  channel: { id: 'c1', name: 'Main' },
};

const claim = {
  id: 'cl1',
  status: 'PENDING',
  claim_data: null,
  created_at: '2026-01-01T00:00:00Z',
  donor: { email: 'alice@example.com' },
  reward: { title: 'T-shirt' },
};

describe('AdminDonations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists donations by default', async () => {
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/donations' ? [donation] : [] }),
    );

    render(<AdminDonations />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
  });

  it('switches to the claims tab', async () => {
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/claims' ? [claim] : [] }),
    );

    render(<AdminDonations />);

    fireEvent.click(await screen.findByRole('button', { name: 'claims' }));

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
  });

  it('filters donations by status via the status pills (#63)', async () => {
    adminClient.get.mockImplementation(
      (path: string, config?: { params?: { status?: string } }) => {
        if (path !== '/donations') return Promise.resolve({ data: [] });
        if (config?.params?.status === 'REFUNDED') return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [donation] });
      },
    );

    render(<AdminDonations />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'REFUNDED' }));

    await screen.findByText('Alice').catch(() => null);
    expect(adminClient.get).toHaveBeenCalledWith('/donations', { params: { status: 'REFUNDED' } });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('changes a donation status via the status dropdown (#63)', async () => {
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/donations' ? [donation] : [] }),
    );
    adminClient.patch.mockResolvedValue({ data: { ...donation, status: 'REFUNDED' } });

    render(<AdminDonations />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('COMPLETED'), { target: { value: 'REFUNDED' } });

    expect(adminClient.patch).toHaveBeenCalledWith('/donations/d1/status', { status: 'REFUNDED' });
  });

  it('shows a channel name for assigned donations and "unassigned" otherwise (#115)', async () => {
    const unassigned = { ...donation, id: 'd2', channel_id: null, event_id: null, channel: null };
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({ data: path === '/donations' ? [donation, unassigned] : [] }),
    );

    render(<AdminDonations />);

    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.getByText('unassigned')).toBeInTheDocument();
  });

  it('filters to unassigned donations only (#115)', async () => {
    const unassigned = { ...donation, id: 'd2', channel_id: null, event_id: null, channel: null };
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({
        data: path === '/donations' ? [donation, unassigned] : [],
      }),
    );

    render(<AdminDonations />);

    expect(await screen.findAllByText('Alice')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'unassigned only' }));

    await waitFor(() => expect(screen.getAllByText('Alice')).toHaveLength(1));
  });

  it('assigns an unassigned donation to a channel (#115)', async () => {
    const unassigned = { ...donation, id: 'd2', channel_id: null, event_id: null, channel: null };
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({
        data:
          path === '/donations'
            ? [unassigned]
            : path === '/channels'
              ? [{ id: 'c9', name: 'Side' }]
              : [],
      }),
    );
    assignDonationChannel.mockResolvedValue({ data: { ...unassigned, channel_id: 'c9' } });

    render(<AdminDonations />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: /assign channel for d2/ }), {
      target: { value: 'c9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assign…' }));

    await waitFor(() => expect(assignDonationChannel).toHaveBeenCalledWith('d2', 'c9'));
  });
});
