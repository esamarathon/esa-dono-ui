import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/api/admin', () => ({ default: api }));
import AdminDonationDetail from '../../src/pages/admin/AdminDonationDetail';
import AdminLayout from '../../src/pages/admin/AdminLayout';
import PaymentRefunds from '../../src/pages/admin/PaymentRefunds';
import type { PaymentRefundRecord } from '../../src/types';
const detail = {
  id: 'd',
  donor_name: 'Alice',
  amount_cents: 0,
  pledge_amount_cents: 1000,
  wallet_applied_cents: 1000,
  status: 'COMPLETED',
  pools: {
    reward: { live_cents: 0, pool_credit_cents: 0, unused_cents: 0 },
    poll: { live_cents: 1000, pool_credit_cents: 0, unused_cents: 0 },
    goal: { live_cents: 0, pool_credit_cents: 0, unused_cents: 1000 },
  },
  allocations: {
    reward: [],
    poll: [{ id: 'v', label: 'Runner A', source: 'auto', amount_cents: 1000, channel: 'Main' }],
    goal: [],
  },
  flags: [],
  action_disabled_reasons: {
    REFUNDED: null,
    CHARGEBACK: 'Cannot record a chargeback for zero money',
  },
};
beforeEach(() => vi.clearAllMocks());
it('routed detail shows source rows, server-disabled cash0 action and confirms a server preview', async () => {
  api.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/donations/d'
          ? detail
          : path.includes('reversal-preview')
            ? {
                donation_id: 'd',
                status: 'REFUNDED',
                accounting: 'POOLED',
                wallet_adjustment_cents: 1000,
                money_before_cents: 0,
                money_after_cents: 0,
                reversed_rows: { reward: 0, poll: 1, goal: 0 },
                retained_claim_ids: [],
                cleared_pool_credit_cents: { reward: 0, poll: 0, goal: 0 },
                reversed_allocation_ids: { reward: [], poll: ['v'], goal: [] },
                cleared_unused_cents: { poll: 0, goal: 1000 },
              }
            : { records: [], total: 0, offset: 0, limit: 50 },
    }),
  );
  api.patch.mockResolvedValue({ data: {} });
  localStorage.setItem('admin_key', 'test');
  localStorage.setItem('donation_draft_v1', 'unrelated-browser-draft');
  render(
    <MemoryRouter initialEntries={['/admin/donations/d']}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="donations/:id" element={<AdminDonationDetail />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { name: 'Alice' })).toBeInTheDocument();
  expect(screen.getAllByRole('tooltip')).toHaveLength(2);
  expect(screen.getAllByRole('tooltip')[0]).toHaveTextContent('not Wallet credit');
  expect(screen.getByRole('button', { name: 'Record chargeback' })).toBeDisabled();
  expect(screen.getByText('Cannot record a chargeback for zero money')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Show poll allocation/ }));
  expect(screen.getByText('Runner A')).toBeInTheDocument();
  expect(screen.getByText('auto')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Wallet refund' }));
  expect(await screen.findByText('Wallet credit change: $10.00')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'confirm Wallet refund' }));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith('/donations/d/status', { status: 'REFUNDED' }),
  );
  expect(localStorage.getItem('donation_draft_v1')).toBe('unrelated-browser-draft');
});
it.each([
  { status: 'REQUESTED', resolution: null },
  { status: 'PENDING', resolution: null },
  { status: 'REQUIRES_ACTION', resolution: null },
  { status: 'SUCCEEDED', resolution: null },
  { status: 'FAILED', resolution: null },
  { status: 'RESOLVED', resolution: 'WALLET_CREDIT' },
  { status: 'RESOLVED', resolution: 'RETURNED_OUTSIDE_APP' },
  { status: 'RESOLVED', resolution: 'SETTLED_BY_DISPUTE' },
])(
  'previews a physical cancellation and refreshes/locks for $status / $resolution',
  async ({ status, resolution }) => {
    const plan = {
      donation_id: 'd',
      claim_id: 'c',
      money_before_cents: 800,
      money_after_cents: 400,
      pledge_before_cents: 1000,
      pledge_after_cents: 600,
      wallet_applied_cents: 200,
      categories: {
        reward: {
          before_cents: 1000,
          after_cents: 600,
          unused_consumed_cents: 400,
          reduced_cents: 0,
        },
        poll: {
          before_cents: 1000,
          after_cents: 600,
          unused_consumed_cents: 0,
          reduced_cents: 400,
        },
        goal: {
          before_cents: 1000,
          after_cents: 600,
          unused_consumed_cents: 0,
          reduced_cents: 400,
        },
      },
      affected_targets: [
        {
          target_id: 'p',
          label: 'Ended poll',
          before_cents: 1000,
          after_cents: 600,
          ended: true,
          completed: false,
        },
        {
          target_id: 'g',
          label: 'Completed goal',
          before_cents: 1000,
          after_cents: 600,
          ended: false,
          completed: true,
        },
      ],
      components: [],
    };
    api.get.mockImplementation((path: string) =>
      Promise.resolve({
        data:
          path === '/donations/d'
            ? {
                ...detail,
                amount_cents: 800,
                wallet_applied_cents: 200,
                allocations: {
                  ...detail.allocations,
                  reward: [
                    {
                      id: 'c',
                      label: 'Physical shirt',
                      channel: 'shared',
                      amount_cents: 400,
                      recorded_amount_cents: 400,
                      current_price_cents: 9000,
                      source: 'donor',
                      status: 'PENDING',
                    },
                  ],
                },
              }
            : api.post.mock.calls.length
              ? { eligible: false, reason: 'This claim already has a Payment refund' }
              : { eligible: true, item_cents: 400, shipping_cents: 200, pool_shrink: plan },
      }),
    );
    api.post.mockResolvedValue({ data: { status, resolution } });
    render(
      <MemoryRouter initialEntries={['/admin/donations/d']}>
        <Routes>
          <Route path="/admin/donations/:id" element={<AdminDonationDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show reward allocation/ }));
    const request = await screen.findByRole('button', { name: 'Cancel with Payment refund' });
    await waitFor(() => expect(request).not.toBeDisabled());
    fireEvent.click(request);
    expect(
      screen.getByText('Item return: $4.00 · Shipping return (outside totals): $2.00'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ended poll: \$10.00 → \$6.00/)).toBeInTheDocument();
    expect(screen.getByText(/Completed goal: \$10.00 → \$6.00/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'confirm Payment refund' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/claims/c/payment-refund'));
    expect(await screen.findByText('This claim already has a Payment refund')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel with Payment refund' })).toBeDisabled();
    expect(
      screen.queryByRole('heading', { name: 'Cancel with Payment refund' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);

it.each([
  { failureReason: 'charge_disputed', reason: 'charge_disputed' },
  { failureReason: null, reason: 'Stripe did not provide a reason' },
])(
  'shows a definite Payment refund rejection ($failureReason) immediately without cancelling the claim or changing money',
  async ({ failureReason, reason }) => {
    api.get.mockImplementation((path: string) =>
      Promise.resolve({
        data:
          path === '/donations/d'
            ? {
                ...detail,
                amount_cents: 800,
                wallet_applied_cents: 200,
                allocations: {
                  ...detail.allocations,
                  reward: [
                    {
                      id: 'c',
                      label: 'Physical shirt',
                      channel: 'Main',
                      amount_cents: 400,
                      recorded_amount_cents: 400,
                      current_price_cents: 400,
                      source: 'donor',
                      status: 'PENDING',
                    },
                  ],
                },
              }
            : {
                eligible: true,
                reason: null,
                claim_id: 'c',
                donation_id: 'd',
                item_cents: 400,
                shipping_cents: 200,
                pool_shrink: {
                  money_before_cents: 800,
                  money_after_cents: 400,
                  pledge_before_cents: 1000,
                  pledge_after_cents: 600,
                  wallet_applied_cents: 200,
                  categories: {
                    reward: { before_cents: 1000, after_cents: 600 },
                    poll: { before_cents: 1000, after_cents: 600 },
                    goal: { before_cents: 1000, after_cents: 600 },
                  },
                  affected_targets: [],
                  components: [],
                },
              },
      }),
    );
    const record: PaymentRefundRecord = {
      id: 'rejected',
      donation_id: 'd',
      claim_id: 'c',
      item_cents: 400,
      shipping_cents: 200,
      status: 'RESOLVED',
      resolution: 'REJECTED',
      failure_reason: failureReason,
      stripe_refund_id: null,
      pool_shrink_data: null,
      shipping_resolution: null,
      created_by: 'admin',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
      accepted_at: null,
      resolved_at: '2026-01-01T00:00:01.000Z',
      resolved_by: 'admin',
      shipping_resolved_at: null,
      shipping_resolved_by: null,
    };
    api.post.mockResolvedValue({ status: 200, data: record });
    render(
      <MemoryRouter initialEntries={['/admin/donations/d']}>
        <Routes>
          <Route path="/admin/donations/:id" element={<AdminDonationDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show reward allocation/ }));
    const request = await screen.findByRole('button', { name: 'Cancel with Payment refund' });
    await waitFor(() => expect(request).toBeEnabled());
    fireEvent.click(request);
    fireEvent.click(screen.getByRole('button', { name: 'confirm Payment refund' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Payment refund rejected: ${reason}. The claim and money are unchanged.`,
    );
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Cancel with Payment refund' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'pools' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Money: $8.00')).toBeVisible();
    expect(screen.getByText('PENDING')).toBeVisible();
    expect(screen.queryByText(/Only this physical claim is cancelled/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'confirm Payment refund' }),
    ).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close and review' }));
    expect(
      screen.queryByRole('heading', { name: 'Cancel with Payment refund' }),
    ).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  },
);

it('renders a changed server eligibility error without committing a stale action', async () => {
  api.get.mockImplementation((path: string) =>
    path.includes('reversal-preview')
      ? Promise.reject({
          response: { data: { error: 'A Payment refund is requested for this donation' } },
        })
      : Promise.resolve({ data: detail }),
  );
  render(
    <MemoryRouter initialEntries={['/admin/donations/d']}>
      <Routes>
        <Route path="/admin/donations/:id" element={<AdminDonationDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Wallet refund' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'A Payment refund is requested for this donation',
  );
  expect(screen.queryByRole('button', { name: 'confirm Wallet refund' })).not.toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

it('shows recorded ended-target history and acknowledges a retained shipped flag instead of reversing it', async () => {
  api.get.mockResolvedValue({
    data: {
      ...detail,
      status: 'CHARGEBACK',
      needs_attention: true,
      flags: ['Shipped claim after chargeback'],
      action_disabled_reasons: { REFUNDED: 'Terminal donation', CHARGEBACK: 'Terminal donation' },
      allocations: {
        ...detail.allocations,
        reward: [
          {
            id: 'shipped',
            label: 'Shipped shirt',
            source: 'donor',
            amount_cents: 500,
            recorded_amount_cents: 500,
            current_price_cents: 900,
            status: 'FULFILLED',
            chargeback_flagged_at: '2026-01-01',
          },
        ],
      },
      ended_target_changes: [
        {
          payment_refund_id: 'refund',
          target_id: 'p',
          label: 'Ended poll',
          before_cents: 1000,
          after_cents: 500,
          ended: true,
          completed: false,
        },
      ],
    },
  });
  api.post.mockResolvedValue({ data: {} });
  render(
    <MemoryRouter initialEntries={['/admin/donations/d']}>
      <Routes>
        <Route path="/admin/donations/:id" element={<AdminDonationDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('button', { name: 'Wallet refund' })).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'flags & ended targets' }));
  expect(screen.getByText(/Ended poll: \$10.00 → \$5.00/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'acknowledge shipped claim' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/claims/shipped/acknowledge-chargeback', {}),
  );
});

it('recovers an uncertain refund through its existing record rather than starting a new cancellation', async () => {
  api.get.mockResolvedValue({
    data: {
      records: [
        {
          id: 'uncertain',
          donation_id: 'd',
          claim_id: 'c',
          status: 'REQUESTED',
          item_cents: 400,
          shipping_cents: 200,
        },
      ],
      total: 1,
      offset: 0,
      limit: 50,
    },
  });
  api.post.mockRejectedValue({ response: { data: { error: 'Stripe state is still unknown' } } });
  render(
    <MemoryRouter>
      <PaymentRefunds />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Retry / Check Stripe' }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'confirm Retry / Check Stripe' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-refunds/uncertain/retry'));
  expect(await screen.findAllByText('Stripe state is still unknown')).not.toHaveLength(0);
  expect(api.post).not.toHaveBeenCalledWith('/claims/c/payment-refund');
});

it('constrains item recovery to the source status and keeps shipping recovery independent', async () => {
  const record = {
    id: 'failed',
    donation_id: 'd',
    claim_id: 'c',
    status: 'FAILED',
    item_cents: 500,
    shipping_cents: 200,
    accepted_at: '2026-01-01',
    resolution: null,
    shipping_resolution: null,
  };
  api.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/payment-refunds'
          ? { records: [record], total: 1, offset: 0, limit: 50 }
          : { status: 'CHARGEBACK' },
    }),
  );
  api.post.mockResolvedValue({ data: record });
  render(
    <MemoryRouter>
      <PaymentRefunds />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'resolve item' }));
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Settled by dispute/ })).not.toBeDisabled(),
  );
  expect(screen.getByRole('option', { name: /Give as Wallet credit/ })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'resolution' }), {
    target: { value: 'SETTLED_BY_DISPUTE' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'confirm resolution' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/payment-refunds/failed/resolve-item', {
      resolution: 'SETTLED_BY_DISPUTE',
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'confirm resolution' })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'resolve shipping' }));
  expect(screen.queryByRole('option', { name: /Wallet credit/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'resolution' }), {
    target: { value: 'KEPT_BY_AGREEMENT' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'confirm resolution' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/payment-refunds/failed/resolve-shipping', {
      resolution: 'KEPT_BY_AGREEMENT',
    }),
  );
});

it('keeps resolved item / failed shipping discoverable with independent confirmation', async () => {
  const record = {
    id: 'r',
    donation_id: 'd',
    claim_id: 'c',
    status: 'RESOLVED',
    item_cents: 500,
    shipping_cents: 200,
    accepted_at: '2026-01-01',
    failure_reason: null,
    resolution: 'RETURNED_OUTSIDE_APP',
    shipping_resolution: null,
  };
  api.get.mockResolvedValue({ data: { records: [record], total: 1, offset: 0, limit: 50 } });
  api.post.mockResolvedValue({ data: record });
  render(
    <MemoryRouter>
      <PaymentRefunds />
    </MemoryRouter>,
  );
  expect(await screen.findByText('RESOLVED')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/payment-refunds', { params: { offset: 0, limit: 50 } });
  fireEvent.click(screen.getByRole('button', { name: 'resolve shipping' }));
  expect(screen.getByText(/Shipping never becomes Wallet credit/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'confirm resolution' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/payment-refunds/r/resolve-shipping', {
      resolution: 'RETURNED_OUTSIDE_APP',
    }),
  );
});
