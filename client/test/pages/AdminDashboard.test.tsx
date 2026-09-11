import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminDashboard from '../../src/pages/admin/AdminDashboard';

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the stat cards', async () => {
    adminClient.get.mockResolvedValue({
      data: { total_raised_cents: 12345, donors: 3, donations: 5, claims: 2, pledges: 1 },
    });

    render(<AdminDashboard />);

    expect(await screen.findByText('$123.45')).toBeInTheDocument();
    expect(screen.getByText('total raised')).toBeInTheDocument();
    expect(screen.getByText('donors')).toBeInTheDocument();
  });

  it('renders the unallocated credits card (#59)', async () => {
    adminClient.get.mockResolvedValue({
      data: {
        total_raised_cents: 12345,
        donors: 3,
        donations: 5,
        claims: 2,
        pledges: 1,
        unallocated_credits_cents: 4000,
      },
    });

    render(<AdminDashboard />);

    expect(await screen.findByText('unallocated credits')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();
  });

  it('renders per-channel totals when present', async () => {
    adminClient.get.mockResolvedValue({
      data: {
        total_raised_cents: 0,
        donors: 0,
        donations: 0,
        claims: 0,
        pledges: 0,
        channels: [{ id: 'c1', name: 'Main', raised_cents: 500, donations: 2 }],
      },
    });

    render(<AdminDashboard />);

    expect(await screen.findByText('per-channel totals')).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  it('shows an error when the stats request fails', async () => {
    adminClient.get.mockRejectedValue(new Error('boom'));

    render(<AdminDashboard />);

    expect(await screen.findByText('Failed to load stats.')).toBeInTheDocument();
  });
});
