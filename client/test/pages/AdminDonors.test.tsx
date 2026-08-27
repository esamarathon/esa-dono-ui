import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDonors: vi.fn(),
  getDonorWallet: vi.fn(),
  createDonor: vi.fn(),
  revokeDonorToken: vi.fn(),
  regenerateDonorToken: vi.fn(),
  toggleDonorFreeze: vi.fn(),
  adjustDonorBalance: vi.fn(),
  reverseDonorSpend: vi.fn(),
  setDonorRole: vi.fn(),
}));

vi.mock('../../src/api/admin', () => mocks);

import AdminDonors from '../../src/pages/admin/AdminDonors';

describe('AdminDonors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists donors', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });

    render(<AdminDonors />);

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    mocks.getDonors.mockResolvedValue({ donors: [], total: 0 });

    render(<AdminDonors />);

    expect(await screen.findByText(/No donors found/)).toBeInTheDocument();
  });
});
