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
const donation = {
  id: 'd1',
  donor_name: 'Alice',
  comment: 'runner choice',
  channel_id: 'main',
  event: { id: 'e1', name: 'Marathon', ended_at: null },
  unused_cents: { poll: 37, goal: 0 },
  assignments: [
    {
      id: 'a1',
      category: 'poll',
      label: 'Old choice',
      amount_cents: 20,
      allocated_at: null,
      can_undo: true,
    },
  ],
};
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
  client.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/channels'
          ? [{ id: 'main', name: 'Main' }]
          : path.includes('/targets')
            ? {
                amount_cents: 37,
                targets: [
                  {
                    id: 'opt',
                    label: 'Fast run',
                    channel_id: null,
                    before_cents: 1000,
                    after_cents: 1037,
                    target_cents: null,
                  },
                ],
              }
            : [donation],
    }),
  );
  client.post.mockResolvedValue({ data: {} });
});
it('uses default toggles, global Channel filter, eligible server impact, assignment and undo', async () => {
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
