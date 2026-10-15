import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/api/moderator', () => ({ default: api }));
import ModeratorLayout from '../../src/pages/moderator/ModeratorLayout';
import ModeratorDonations from '../../src/pages/moderator/ModeratorDonations';
import ModeratorClaims from '../../src/pages/moderator/ModeratorClaims';
const donations = [
  {
    id: 'a',
    donor_name: 'Donor A',
    amount_cents: 100,
    pledge_amount_cents: 500,
    status: 'COMPLETED',
    created_at: '2026-01-01',
    channel: { id: 'a', name: 'Main' },
    unused_cents: { poll: 50, goal: 0 },
    allocations: {
      reward: [],
      poll: [],
      goal: [
        {
          id: 'assignment',
          label: 'Shared goal',
          source: 'moderator',
          amount_cents: 500,
          allocated_by: 'Staff operator',
          allocated_at: '2026-01-02',
        },
      ],
    },
  },
  {
    id: 'b',
    donor_name: 'Donor B',
    amount_cents: 0,
    pledge_amount_cents: 500,
    status: 'REFUNDED',
    created_at: '2026-01-01',
    channel: { id: 'b', name: 'Side' },
    allocations: { reward: [], poll: [], goal: [] },
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('moderator_key', 'test');
  localStorage.setItem('donation_draft_v1', 'untouched');
  api.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/channels'
          ? [
              { id: 'a', name: 'Main' },
              { id: 'b', name: 'Side' },
            ]
          : path === '/donations'
            ? donations
            : path === '/claims'
              ? [
                  {
                    id: 'claim',
                    amount_cents: 500,
                    donor_name: null,
                    reward: { title: 'Recorded claim', cost_cents: 900, channel_id: 'a' },
                  },
                ]
              : [],
    }),
  );
});
it('uses the real routed staff provider for live allocations, global Channel selection and assignment Undo without browser-draft coupling', async () => {
  api.post.mockResolvedValue({ data: { success: true } });
  render(
    <MemoryRouter initialEntries={['/moderate/donations']}>
      <Routes>
        <Route path="/moderate" element={<ModeratorLayout />}>
          <Route path="donations" element={<ModeratorDonations />} />
          <Route path="claims" element={<ModeratorClaims />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('Donor B')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
  expect(screen.queryByText('Donor B')).not.toBeInTheDocument();
  expect(screen.getByText(/Staff operator/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'undo' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/unused-pool-money/goal/assignment/undo'),
  );
  fireEvent.click(screen.getByRole('link', { name: 'claims' }));
  expect(await screen.findByText('donor: Anonymous')).toBeInTheDocument();
  expect(screen.getByText('Recorded allocation: $5.00 (price now $9.00)')).toBeInTheDocument();
  expect(localStorage.getItem('moderator_channel_filter')).toBe('a');
  expect(localStorage.getItem('donation_draft_v1')).toBe('untouched');
  expect(screen.queryByText(/Pool credit/)).not.toBeInTheDocument();
});
