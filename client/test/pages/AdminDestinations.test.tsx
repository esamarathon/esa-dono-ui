import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getDestinations: vi.fn(),
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  rotateDestinationSecret: vi.fn(),
  deleteDestination: vi.fn(),
  getDestinationDeliveries: vi.fn(),
  testDestination: vi.fn(),
}));

vi.mock('../../src/api/admin', () => mocks);

import AdminDestinations from '../../src/pages/admin/AdminDestinations';

const endpoint = {
  id: 'ep-1',
  url: 'https://example.com/webhook',
  secret: 's3cret',
  is_active: true,
  event_types: ['donation.created'],
  verify_ssl: true,
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  destination_type: 'HTTP',
  amqp_url: null,
  amqp_exchange: '',
  amqp_routing_key: null,
};

describe('AdminDestinations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the list of destinations from the (already-unwrapped) API result', async () => {
    // getDestinations() returns the endpoint array directly (not { data }),
    // mirroring the api/admin.ts helper contract.
    mocks.getDestinations.mockResolvedValue([endpoint]);

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    expect(await screen.findByText('webhooks')).toBeInTheDocument();
    expect(await screen.findByText('donation.created')).toBeInTheDocument();
  });

  it('shows the empty state when no destinations exist', async () => {
    mocks.getDestinations.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/No webhook endpoints configured/)).toBeInTheDocument();
  });

  it('creates an HTTP destination', async () => {
    mocks.getDestinations.mockResolvedValue([]);
    mocks.createDestination.mockResolvedValue({ id: 'ep-2' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new endpoint' }));
    expect(screen.getByText('new webhook endpoint')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('https://example.com/webhook'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByLabelText('donation.created'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.createDestination).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/hook' }),
      ),
    );
  });

  it('toggles a destination active state', async () => {
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.updateDestination.mockResolvedValue({ ...endpoint, is_active: false });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'pause' }));

    await waitFor(() =>
      expect(mocks.updateDestination).toHaveBeenCalledWith('ep-1', { is_active: false }),
    );
  });

  it('expands the delivery log', async () => {
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.getDestinationDeliveries.mockResolvedValue({ deliveries: [], total: 0 });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'log' }));

    expect(await screen.findByText(/No deliveries yet/)).toBeInTheDocument();
  });
});
