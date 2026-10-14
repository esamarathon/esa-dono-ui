import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminEvents from '../../src/pages/admin/AdminEvents';
import ModeratorEvents from '../../src/pages/moderator/ModeratorEvents';
const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../../src/api/admin', () => ({ default: client }));
vi.mock('../../src/api/moderator', () => ({ default: client }));
const event = {
  id: 'e1',
  name: 'Marathon',
  slug: 'marathon',
  is_active: false,
  primary_channel_id: null,
  ended_at: null,
};
const preview = {
  event_id: 'e1',
  slug: 'marathon',
  action: 'END',
  can_apply: true,
  blockers: [],
  pool_credit_cents: { poll: 123, goal: 456, reward: 789 },
  unshipped_physical_donations: 2,
  open_pledges: 3,
  requested_payment_refunds: 0,
  consuming_assignments: [],
};
function renderPage(admin = true) {
  return render(
    <MemoryRouter initialEntries={[admin ? '/admin/events' : '/moderate/events']}>
      <Routes>
        <Route path="/admin/events" element={<AdminEvents />} />
        <Route path="/moderate/events" element={<ModeratorEvents />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  client.get.mockImplementation((path: string) =>
    Promise.resolve({ data: path === '/events' ? [event] : path === '/channels' ? [] : preview }),
  );
  client.post.mockResolvedValue({ data: {} });
});
it('previews conversion, expiry/refund window and pledges; requires exact slug and posts only on confirmation', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'end Event' }));
  expect(await screen.findByText(/poll Pool credit.*\$1.23/)).toBeInTheDocument();
  expect(screen.getByText(/goal Pool credit.*\$4.56/)).toBeInTheDocument();
  expect(screen.getByText(/reward Pool credit.*\$7.89/)).toBeInTheDocument();
  expect(screen.getByText(/2 donations/)).toBeInTheDocument();
  expect(screen.getByText(/3 open Pending pledges/)).toBeInTheDocument();
  const confirm = screen.getByRole('button', { name: 'confirm end Event' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Event slug confirmation'), {
    target: { value: 'marathon' },
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(client.post).toHaveBeenCalledWith('/events/e1/end', { slug: 'marathon' }),
  );
});
it('ended Events cannot activate; only admins see Undo end and blocked preview cannot be confirmed', async () => {
  client.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/events'
          ? [{ ...event, ended_at: '2026-10-01T00:00:00Z' }]
          : path === '/channels'
            ? []
            : {
                ...preview,
                action: 'UNDO_END',
                can_apply: false,
                blockers: ['Reverse consuming assignments first'],
              },
    }),
  );
  const rendered = renderPage(false);
  expect(await screen.findByText(/ended/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'activate' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Undo end' })).not.toBeInTheDocument();
  rendered.unmount();
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Undo end' }));
  expect(await screen.findByText('Reverse consuming assignments first')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Event slug confirmation'), {
    target: { value: 'marathon' },
  });
  expect(screen.getByRole('button', { name: 'confirm Undo end' })).toBeDisabled();
});
it('keeps server errors visible and supports Undo end confirmation', async () => {
  client.get.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/events'
          ? [{ ...event, ended_at: '2026-10-01T00:00:00Z' }]
          : path === '/channels'
            ? []
            : { ...preview, action: 'UNDO_END' },
    }),
  );
  client.post.mockRejectedValue({
    response: { data: { error: 'New consuming assignment; reload' } },
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Undo end' }));
  fireEvent.change(await screen.findByLabelText('Event slug confirmation'), {
    target: { value: 'marathon' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'confirm Undo end' }));
  expect(await screen.findByText('New consuming assignment; reload')).toBeInTheDocument();
  expect(client.post).toHaveBeenCalledWith('/events/e1/undo-end', { slug: 'marathon' });
});
