import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminDonations from '../../src/pages/admin/AdminDonations';

const donation = {
  id: 'd1',
  amount_cents: 2500,
  donor_name: 'Alice',
  comment: 'thanks',
  created_at: '2026-01-01T00:00:00Z',
  donor: { email: 'alice@example.com' },
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
});
