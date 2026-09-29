import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import ModeratorEvents from '../../src/pages/moderator/ModeratorEvents';

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
  moderatorClient.get.mockImplementation((path: string) =>
    Promise.resolve({ data: path === '/channels' ? channels : events }),
  );
}

describe('ModeratorEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists events with their slug and primary channel (#115)', async () => {
    mockGet([event], [channel]);

    render(<ModeratorEvents />);

    expect(await screen.findByText('Marathon')).toBeInTheDocument();
    expect(screen.getByText(/slug: marathon/)).toBeInTheDocument();
    expect(screen.getByText(/primary channel: Main/)).toBeInTheDocument();
  });

  it('shows the empty state (#115)', async () => {
    mockGet([]);

    render(<ModeratorEvents />);

    expect(await screen.findByText(/No events yet/)).toBeInTheDocument();
  });

  it('creates an event (#115)', async () => {
    mockGet([]);
    moderatorClient.post.mockResolvedValue({ data: { id: 'e2', name: 'Hekathon' } });

    render(<ModeratorEvents />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new event' }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Hekathon' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/events', { name: 'Hekathon' }),
    );
  });

  it('blocks the slug field while editing an active event (#115)', async () => {
    mockGet([{ ...event, is_active: true }], [channel]);

    render(<ModeratorEvents />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));

    expect(screen.getAllByRole('textbox')[1]!).toBeDisabled();
  });
});
