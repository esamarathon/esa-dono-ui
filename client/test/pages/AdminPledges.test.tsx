import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminPledges from '../../src/pages/admin/AdminPledges';

const pledge = {
  id: 'p1',
  status: 'OPEN',
  donor_email: 'alice@example.com',
  format: 'POOLED',
  pledge_amount_cents: 1000,
  new_money_cents: 100,
  held_wallet_cents: 900,
  wallet_held_cents: 900,
  wallet_hold_status: 'HELD',
  checkout_session_status: 'open',
  payment_status: 'unpaid',
  payment_state: 'OPEN',
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

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(adminClient.get).toHaveBeenCalledWith('/pledges', {
      params: { status: 'OPEN', offset: 0, limit: 50 },
    });
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  it('filters and checks Stripe instead of offering manual hold release', async () => {
    adminClient.get.mockResolvedValue({ data: [pledge], headers: { 'x-total-count': '51' } });
    adminClient.post.mockResolvedValue({ data: {} });
    render(<AdminPledges />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check Stripe' }));
    await waitFor(() => expect(adminClient.post).toHaveBeenCalledWith('/pledges/p1/check-stripe'));
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() =>
      expect(adminClient.get).toHaveBeenLastCalledWith('/pledges', {
        params: { status: 'OPEN', offset: 50, limit: 50 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'PAYMENT_REVIEW' }));
    await waitFor(() =>
      expect(adminClient.get).toHaveBeenLastCalledWith('/pledges', {
        params: { status: 'PAYMENT_REVIEW', offset: 0, limit: 50 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'LEGACY_PAID' }));
    await waitFor(() =>
      expect(adminClient.get).toHaveBeenLastCalledWith('/pledges', {
        params: { payment_state: 'LEGACY_PAID', offset: 0, limit: 50 },
      }),
    );
    expect(screen.queryByRole('button', { name: /release/i })).not.toBeInTheDocument();
  });

  it('distinguishes legacy late payment and cash-only admin review from original fulfillment', async () => {
    adminClient.get.mockResolvedValue({
      data: [
        {
          ...pledge,
          id: 'legacy',
          format: 'LEGACY',
          status: 'EXPIRED',
          payment_state: 'LEGACY_PAID',
          fulfilled_by: { id: 'late-cash', amount_cents: 1000 },
          pledge_amount_cents: null,
          new_money_cents: null,
          held_wallet_cents: 0,
          wallet_held_cents: 0,
        },
        {
          ...pledge,
          id: 'review',
          status: 'PAYMENT_REVIEW',
          payment_state: 'PAYMENT_REVIEW',
          wallet_held_cents: 0,
          wallet_hold_status: 'RELEASED',
        },
      ],
    });
    render(<AdminPledges />);
    expect(await screen.findByText('paid after transition: not fulfilled')).toBeInTheDocument();
    expect(
      screen.getByText('Needs admin review: cash-only recovery, not original fulfillment'),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('button', { name: 'Check Stripe' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    expect(screen.getByText(/Confirmed Wallet funding: \$9.00 · RELEASED/)).toBeInTheDocument();
    expect(screen.queryByText(/relay/i)).not.toBeInTheDocument();
  });

  it('does not relabel historical pre-change fulfilled legacy pledges as late cash receipts', async () => {
    adminClient.get.mockResolvedValue({
      data: [
        {
          ...pledge,
          format: 'LEGACY',
          status: 'FULFILLED',
          payment_state: 'FULFILLED',
          fulfilled_by: { id: 'original', amount_cents: 1000 },
        },
      ],
    });
    render(<AdminPledges />);
    expect(await screen.findByRole('link', { name: 'Donation original' })).toBeInTheDocument();
    expect(screen.queryByText('paid after transition: not fulfilled')).not.toBeInTheDocument();
  });

  it('shows a zero total when there are no pledges', async () => {
    adminClient.get.mockResolvedValue({ data: [] });

    render(<AdminPledges />);

    expect(await screen.findByText(/0 total pledges/)).toBeInTheDocument();
  });
});
