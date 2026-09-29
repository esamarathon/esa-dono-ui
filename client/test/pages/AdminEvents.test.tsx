import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminEvents from '../../src/pages/admin/AdminEvents';

const event = {
  id: 'e1',
  name: 'Marathon',
  slug: 'marathon',
  is_active: false,
  primary_channel_id: 'c1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const channel = { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true };

function mockGet(events: unknown[], channels: unknown[] = []) {
  adminClient.get.mockImplementation((path: string) =>
    Promise.resolve({ data: path === '/channels' ? channels : events }),
  );
}

describe('AdminEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists events with their slug and primary channel (#115)', async () => {
    mockGet([event], [channel]);

    render(<AdminEvents />);

    expect(await screen.findByText('Marathon')).toBeInTheDocument();
    expect(screen.getByText(/slug: marathon/)).toBeInTheDocument();
    expect(screen.getByText(/primary channel: Main/)).toBeInTheDocument();
  });

  it('shows the empty state (#115)', async () => {
    mockGet([]);

    render(<AdminEvents />);

    expect(await screen.findByText(/No events yet/)).toBeInTheDocument();
  });

  it('creates an event with an optional slug (#115)', async () => {
    mockGet([]);
    adminClient.post.mockResolvedValue({ data: { id: 'e2', name: 'Hekathon' } });

    render(<AdminEvents />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new event' }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Hekathon' } });
    fireEvent.change(screen.getAllByRole('textbox')[1]!, { target: { value: 'hekathon' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith('/events', {
        name: 'Hekathon',
        slug: 'hekathon',
      }),
    );
  });

  it("saves an event's name and primary channel (#115)", async () => {
    mockGet([event], [channel]);
    adminClient.put.mockResolvedValue({ data: { ...event, name: 'Renamed' } });

    render(<AdminEvents />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith(
        '/events/e1',
        expect.objectContaining({ name: 'Renamed', primary_channel_id: 'c1' }),
      ),
    );
  });

  it('blocks the slug field while editing an active event and explains why (#115)', async () => {
    mockGet([{ ...event, is_active: true }], [channel]);

    render(<AdminEvents />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));

    expect(screen.getAllByRole('textbox')[1]!).toBeDisabled();
    expect(screen.getByText(/Changing a slug breaks overlay bindings/)).toBeInTheDocument();
  });

  it('activates an inactive event via the toggle (#115)', async () => {
    mockGet([event], [channel]);
    adminClient.put.mockResolvedValue({ data: { ...event, is_active: true } });

    render(<AdminEvents />);

    fireEvent.click(await screen.findByRole('button', { name: 'activate' }));

    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith('/events/e1', { is_active: true }),
    );
  });
});
