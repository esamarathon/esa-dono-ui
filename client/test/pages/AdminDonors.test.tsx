import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  sweepCredits: vi.fn(),
}));

vi.mock('../../src/api/admin', () => mocks);

import AdminDonors from '../../src/pages/admin/AdminDonors';

const wallet = {
  email: 'alice@example.com',
  total_donated: 500,
  balance_remaining: 100,
  role: 'USER',
  is_frozen: false,
  donations: [],
  reward_claims: [],
  poll_votes: [],
  fund_contributions: [],
  balance_adjustments: [],
};

describe('AdminDonors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('opens a donor wallet on click', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));

    expect(await screen.findByText('No spend history.')).toBeInTheDocument();
    expect(screen.getByText('No donation history.')).toBeInTheDocument();
  });

  it('opens the create-donor modal and creates a donor', async () => {
    mocks.getDonors.mockResolvedValue({ donors: [], total: 0 });
    mocks.createDonor.mockResolvedValue({ id: 'd2' });
    mocks.getDonorWallet.mockResolvedValue(wallet);

    render(<AdminDonors />);

    fireEvent.click(await screen.findByRole('button', { name: 'add donor' }));
    expect(screen.getByRole('heading', { name: 'add donor' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'create' }));

    await waitFor(() => expect(mocks.createDonor).toHaveBeenCalledWith('bob@example.com', 'USER'));
  });

  it('freezes a donor', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);
    mocks.toggleDonorFreeze.mockResolvedValue({ success: true });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'freeze' }));

    await waitFor(() => expect(mocks.toggleDonorFreeze).toHaveBeenCalledWith('d1', true));
  });

  it('revokes a donor token', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);
    mocks.revokeDonorToken.mockResolvedValue({ success: true });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'revoke token' }));

    await waitFor(() => expect(mocks.revokeDonorToken).toHaveBeenCalledWith('d1'));
  });

  it('regenerates a token and shows the magic link', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);
    mocks.regenerateDonorToken.mockResolvedValue({
      success: true,
      email: 'alice@example.com',
      magic_token: 'newtoken123',
    });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'regenerate token' }));

    expect(await screen.findByText('new token generated')).toBeInTheDocument();
    expect(screen.getByDisplayValue('newtoken123')).toBeInTheDocument();
  });

  it('opens the adjust-balance modal and submits', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);
    mocks.adjustDonorBalance.mockResolvedValue({ success: true });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'adjust balance' }));

    const amountInput = screen.getByPlaceholderText('e.g. 10.00');
    fireEvent.change(amountInput, { target: { value: '5.00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'save' })[0]!);

    await waitFor(() =>
      expect(mocks.adjustDonorBalance).toHaveBeenCalledWith('d1', 500, null, 'MANUAL'),
    );
  });

  it('shows donation history for the donor (#47)', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue({
      ...wallet,
      donations: [
        { id: 'don1', amount_cents: 1000, comment: 'go team!', created_at: '2024-01-01T00:00:00Z' },
        { id: 'don2', amount_cents: 500, comment: null, created_at: '2024-01-02T00:00:00Z' },
      ],
    });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));

    expect(await screen.findByText('donation history')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/go team!/)).toBeInTheDocument();
    expect(screen.queryByText('No donation history.')).not.toBeInTheDocument();
  });

  it('shows poll votes and fund contributions in the spend history', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue({
      ...wallet,
      poll_votes: [{ id: 'v1', amount_cents: 500, reversed_at: null }],
      fund_contributions: [
        { id: 'c1', amount_cents: 300, reversed_at: null, goal: { title: 'Goal A' } },
      ],
    });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));

    expect(await screen.findByText('poll votes')).toBeInTheDocument();
    expect(screen.getByText('fund contributions')).toBeInTheDocument();
    expect(screen.getByText(/Goal A/)).toBeInTheDocument();
  });

  it('shows balance adjustments history', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue({
      ...wallet,
      balance_adjustments: [
        {
          id: 'a1',
          amount_cents: 500,
          type: 'MANUAL',
          reason: 'test reason',
          balance_after_cents: 600,
        },
      ],
    });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));

    expect(await screen.findByText('balance adjustments')).toBeInTheDocument();
    expect(screen.getByText('MANUAL')).toBeInTheDocument();
    expect(screen.getByText(/test reason/)).toBeInTheDocument();
  });

  it('shows a validation error when adjust-balance amount is zero', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);

    render(<AdminDonors />);

    fireEvent.click(await screen.findByText('alice@example.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'adjust balance' }));

    // Submit with amount 0 (the input is pre-filled with empty; just click save directly)
    fireEvent.click(screen.getAllByRole('button', { name: 'save' })[0]!);

    expect(await screen.findByText('Enter a non-zero amount')).toBeInTheDocument();
  });

  it('previews and confirms a bulk credit sweep (#60)', async () => {
    mocks.getDonors.mockResolvedValue({ donors: [], total: 0 });
    mocks.sweepCredits.mockImplementation((_filter, confirm) =>
      Promise.resolve(
        confirm
          ? { success: true, donor_count: 2, total_cents: 900 }
          : {
              preview: true,
              donor_count: 2,
              total_cents: 900,
              sample: [
                { id: 'd1', balance_remaining: 500, donor_name: 'Jane Donor' },
                { id: 'd2', balance_remaining: 400, donor_name: null },
              ],
            },
      ),
    );

    render(<AdminDonors />);

    fireEvent.click(await screen.findByRole('button', { name: 'sweep credits' }));
    expect(screen.getByRole('heading', { name: 'bulk credit sweep' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'preview' }));

    expect(await screen.findByText(/This will zero/)).toBeInTheDocument();
    expect(screen.getByText('Jane Donor')).toBeInTheDocument();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'confirm sweep' }));

    expect(await screen.findByText(/Swept 2 donors/)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.sweepCredits).toHaveBeenLastCalledWith(expect.objectContaining({}), true),
    );
  });

  it('applies min/max balance filters to the sweep preview', async () => {
    mocks.getDonors.mockResolvedValue({ donors: [], total: 0 });
    mocks.sweepCredits.mockResolvedValue({
      preview: true,
      donor_count: 0,
      total_cents: 0,
      sample: [],
    });

    render(<AdminDonors />);

    fireEvent.click(await screen.findByRole('button', { name: 'sweep credits' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. 0.00'), { target: { value: '0.00' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'preview' }));

    await waitFor(() =>
      expect(mocks.sweepCredits).toHaveBeenCalledWith(
        { min_balance_cents: 0, max_balance_cents: 100 },
        false,
      ),
    );
  });

  it('gives the donor list and detail panel their own independent scroll viewport (#64)', async () => {
    mocks.getDonors.mockResolvedValue({
      donors: [
        { id: 'd1', email: 'alice@example.com', total_donated: 500, balance_remaining: 100 },
      ],
      total: 1,
    });
    mocks.getDonorWallet.mockResolvedValue(wallet);

    render(<AdminDonors />);

    const listColumn = (await screen.findByText('alice@example.com')).closest(
      'div.lg\\:col-span-1',
    ) as HTMLElement;
    expect(listColumn).not.toBeNull();
    expect(listColumn.className).toContain('overflow-y-auto');
    expect(listColumn.className).toContain('h-full');

    fireEvent.click(screen.getByText('alice@example.com'));

    const detailColumn = (await screen.findByText('adjust balance')).closest(
      'div.lg\\:col-span-2',
    ) as HTMLElement;
    expect(detailColumn).not.toBeNull();
    expect(detailColumn.className).toContain('overflow-y-auto');
    expect(detailColumn.className).toContain('h-full');
  });
});
