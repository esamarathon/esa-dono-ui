import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminPledges from '../../src/pages/admin/AdminPledges';

const pledge = {
  id: 'p1',
  status: 'OPEN',
  donor_email: 'alice@example.com',
  total_cents: 1000,
  items: [],
  relay_client_key: null,
  relay_key_id: null,
  expires_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  fulfilled_by: null,
};

describe('AdminPledges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists pledges', async () => {
    adminClient.get.mockResolvedValue({ data: [pledge] });

    render(<AdminPledges />);

    expect(await screen.findByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  it('shows a zero total when there are no pledges', async () => {
    adminClient.get.mockResolvedValue({ data: [] });

    render(<AdminPledges />);

    expect(await screen.findByText(/0 total pledges/)).toBeInTheDocument();
  });
});
