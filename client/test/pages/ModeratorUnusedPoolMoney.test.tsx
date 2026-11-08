import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  ModeratorChannelFilterProvider,
  useModeratorChannelFilter,
} from '../../src/context/ModeratorChannelFilterContext';
import ModeratorUnusedPoolMoney from '../../src/pages/moderator/ModeratorUnusedPoolMoney';
const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/api/moderator', () => ({ default: client }));
function donation(unused: number, assigned: number) {
  return {
    id: 'd1',
    donor_name: 'Alice',
    comment: 'runner choice',
    channel_id: 'main',
    event: { id: 'e1', name: 'Marathon', ended_at: null },
    unused_cents: { poll: unused, goal: 0 },
    assignments: [
      {
        id: 'a1',
        category: 'poll',
        label: 'Old choice',
        amount_cents: assigned,
        allocated_at: null,
        can_undo: true,
      },
    ],
  };
}
function Filter() {
  const { setSelectedChannelId } = useModeratorChannelFilter();
  return <button onClick={() => setSelectedChannelId('side')}>side channel</button>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/moderate/unused-pool-money']}>
      <ModeratorChannelFilterProvider>
        <Filter />
        <Routes>
          <Route path="/moderate/unused-pool-money" element={<ModeratorUnusedPoolMoney />} />
        </Routes>
      </ModeratorChannelFilterProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
function mockUnused({
  unused,
  assigned,
  before,
  after,
}: Readonly<{ unused: number; assigned: number; before: number; after: number }>) {
  client.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/channels'
          ? [{ id: 'main', name: 'Main' }]
          : path.includes('/targets')
            ? {
                amount_cents: unused,
                targets: [
                  {
                    id: 'opt',
                    label: 'Fast run',
                    channel_id: null,
                    before_cents: before,
                    after_cents: after,
                    target_cents: null,
                  },
                ],
              }
            : [donation(unused, assigned)],
    }),
  );
  client.post.mockResolvedValue({ data: {} });
}
it('uses default toggles, global Channel filter, eligible server impact, assignment and undo', async () => {
  mockUnused({ unused: 37, assigned: 20, before: 1000, after: 1037 });
  renderPage();
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(screen.getByLabelText('comments only')).toBeChecked();
  expect(screen.getByLabelText('show ended Events')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'assign poll…' }));
  const target = await screen.findByLabelText(/Fast run/);
  expect(screen.getByText(/\$10.00 → \$10.37/)).toBeInTheDocument();
  fireEvent.click(target);
  fireEvent.click(screen.getByRole('button', { name: 'assign all $0.37' }));
  await waitFor(() =>
    expect(client.post).toHaveBeenCalledWith('/donations/d1/unused-pool-money', {
      category: 'poll',
      target_id: 'opt',
      expected_amount_cents: 37,
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'undo Old choice' }));
  await waitFor(() => expect(client.post).toHaveBeenCalledWith('/unused-pool-money/poll/a1/undo'));
  fireEvent.click(screen.getByLabelText('comments only'));
  fireEvent.click(screen.getByLabelText('show ended Events'));
  fireEvent.click(screen.getByRole('button', { name: 'side channel' }));
  await waitFor(() =>
    expect(client.get).toHaveBeenLastCalledWith('/unused-pool-money', {
      params: { comments_only: false, show_ended: true, channel_id: 'side' },
    }),
  );
});
it('shows stale errors, keeps the choice for review and never retries an assignment automatically', async () => {
  mockUnused({ unused: 37, assigned: 20, before: 1000, after: 1037 });
  client.post.mockRejectedValue({
    response: { data: { error: 'Unused amount changed; reload before assigning' } },
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'assign poll…' }));
  fireEvent.click(await screen.findByLabelText(/Fast run/));
  fireEvent.click(screen.getByRole('button', { name: 'assign all $0.37' }));
  expect(await screen.findByText(/Unused amount changed/)).toBeInTheDocument();
  expect(client.post).toHaveBeenCalledTimes(1);
});
