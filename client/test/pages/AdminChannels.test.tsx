import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminChannels from '../../src/pages/admin/AdminChannels';

const channel = { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true };

function mockGet(channels: unknown[], events: unknown[] = []) {
  adminClient.get.mockImplementation((path: string) =>
    Promise.resolve({ data: path === '/events' ? events : channels }),
  );
}

describe('AdminChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists channels with their slug and event name', async () => {
    mockGet([channel], [{ id: 'e1', name: 'Marathon', is_active: true }]);

    render(<AdminChannels />);

    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.getByText(/slug: main/)).toBeInTheDocument();
    expect(screen.getByText(/event: Marathon/)).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    mockGet([]);

    render(<AdminChannels />);

    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
  });

  it('creates a channel with a slug and event', async () => {
    mockGet([], [{ id: 'e1', name: 'Marathon', is_active: true }]);
    adminClient.post.mockResolvedValue({ data: { id: 'c2', name: 'New', slug: 'new' } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: '+ new channel' }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'New' } });
    fireEvent.change(screen.getAllByRole('textbox')[1]!, { target: { value: 'new' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'e1' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.post).toHaveBeenCalledWith(
        '/channels',
        expect.objectContaining({ name: 'New', slug: 'new', event_id: 'e1' }),
      ),
    );
  });

  it('edits a channel', async () => {
    mockGet([channel]);
    adminClient.put.mockResolvedValue({ data: { id: 'c1', name: 'Renamed' } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith(
        '/channels/c1',
        expect.objectContaining({ name: 'Renamed' }),
      ),
    );
  });

  it('blocks the slug field while editing an active channel (#115)', async () => {
    mockGet([channel]);

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));

    expect(screen.getAllByRole('textbox')[1]!).toBeDisabled();
    expect(screen.getByText(/Changing a slug breaks overlay bindings/)).toBeInTheDocument();
  });

  it('edits ordered own/shared defaults, preserves ineligible entries and excludes foreign goals', async () => {
    adminClient.get.mockImplementation((path: string) =>
      Promise.resolve({
        data:
          path === '/channels'
            ? [
                {
                  ...channel,
                  default_goals: ['g1', 'g2'],
                  has_eligible_default: false,
                  fallback_goal: { id: 'g3', title: 'Fallback' },
                },
              ]
            : path === '/goals'
              ? [
                  {
                    id: 'g1',
                    title: 'Closed',
                    channel_id: 'c1',
                    is_active: false,
                    current_cents: 300,
                    target_cents: 500,
                  },
                  {
                    id: 'g2',
                    title: 'Shared',
                    channel_id: null,
                    is_active: true,
                    current_cents: 100,
                    target_cents: 500,
                  },
                  { id: 'g3', title: 'Foreign', channel_id: 'c2', is_active: true },
                ]
              : [],
      }),
    );
    adminClient.put.mockResolvedValue({ data: {} });
    render(<AdminChannels />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('receives goal-Pool money now')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Foreign' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Shared up' }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(adminClient.put).toHaveBeenCalledWith(
        '/channels/c1',
        expect.objectContaining({ default_goals: ['g2', 'g1'] }),
      ),
    );
  });

  it('deactivates a channel after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mockGet([channel]);
    adminClient.delete.mockResolvedValue({ data: { success: true } });

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'deactivate' }));

    await waitFor(() => expect(adminClient.delete).toHaveBeenCalledWith('/channels/c1'));
    vi.unstubAllGlobals();
  });

  it('copies a /donate?channel=<id> deep link for a channel (#49)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com' },
      writable: true,
    });

    mockGet([channel]);

    render(<AdminChannels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://example.com/donate?channel=c1'),
    );
  });
});
