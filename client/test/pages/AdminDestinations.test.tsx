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
  requeueDelivery: vi.fn(),
  requeueFailedDeliveries: vi.fn(),
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
  payload_format: 'NATIVE',
  amqp_url: null,
  amqp_exchange: '',
  amqp_routing_key: null,
};

const failedDelivery = {
  id: 'del-failed',
  seq: 2,
  message_id: 'msg-2',
  event_type: 'donation.created',
  status: 'FAILED',
  attempts: 3,
  next_attempt_at: '2026-01-01T00:01:00Z',
  last_status_code: 500,
  last_error: 'boom',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:01:00Z',
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

    expect(await screen.findByText(/No Destinations configured/)).toBeInTheDocument();
  });

  it('creates an HTTP destination', async () => {
    mocks.getDestinations.mockResolvedValue([]);
    mocks.createDestination.mockResolvedValue({ id: 'ep-2' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new destination' }));
    expect(screen.getByText('new destination')).toBeInTheDocument();

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

  it('edits an existing destination', async () => {
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.updateDestination.mockResolvedValue({ ...endpoint, description: 'Updated' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit destination')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.updateDestination).toHaveBeenCalledWith('ep-1', expect.any(Object)),
    );
  });

  it('creates a RabbitMQ destination', async () => {
    mocks.getDestinations.mockResolvedValue([]);
    mocks.createDestination.mockResolvedValue({ id: 'ep-3' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new destination' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'RABBITMQ' } });
    expect(
      screen.getByPlaceholderText('amqps://user:pass@rabbitmq.example.com:5671/vhost'),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByPlaceholderText('amqps://user:pass@rabbitmq.example.com:5671/vhost'),
      { target: { value: 'amqp://localhost' } },
    );
    fireEvent.change(screen.getByPlaceholderText('my.queue.name'), {
      target: { value: 'my.queue' },
    });
    fireEvent.click(screen.getByLabelText('donation.created'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.createDestination).toHaveBeenCalledWith(
        expect.objectContaining({ destination_type: 'RABBITMQ', amqp_url: 'amqp://localhost' }),
      ),
    );
  });

  it('creates a Tiltify-compatible RabbitMQ destination and hides message types (#116)', async () => {
    mocks.getDestinations.mockResolvedValue([]);
    mocks.createDestination.mockResolvedValue({ id: 'ep-4' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ new destination' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'RABBITMQ' } });
    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'TILTIFY' } });

    // Message types and the routing key are ignored for a Tiltify destination.
    expect(screen.queryByLabelText('donation.created')).toBeNull();
    expect(screen.queryByPlaceholderText('my.queue.name')).toBeNull();
    expect(screen.getByText(/sends bare Tiltify-style/)).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText('amqps://user:pass@rabbitmq.example.com:5671/vhost'),
      { target: { value: 'amqp://localhost' } },
    );
    expect(screen.getByPlaceholderText('(default exchange)')).toHaveValue('tiltify');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.createDestination).toHaveBeenCalledWith(
        expect.objectContaining({
          destination_type: 'RABBITMQ',
          payload_format: 'TILTIFY',
          amqp_exchange: 'tiltify',
        }),
      ),
    );
  });

  it('shows a Tiltify badge in the list (#116)', async () => {
    mocks.getDestinations.mockResolvedValue([
      {
        ...endpoint,
        destination_type: 'RABBITMQ',
        payload_format: 'TILTIFY',
        amqp_routing_key: null,
      },
    ]);

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Tiltify')).toBeInTheDocument();
  });

  it('rotates the endpoint secret after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.rotateDestinationSecret.mockResolvedValue({ ...endpoint, secret: 'new_secret' });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'rotate' }));

    await waitFor(() => expect(mocks.rotateDestinationSecret).toHaveBeenCalledWith('ep-1'));
    vi.unstubAllGlobals();
  });

  it('deletes a destination after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.deleteDestination.mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));

    await waitFor(() => expect(mocks.deleteDestination).toHaveBeenCalledWith('ep-1'));
    vi.unstubAllGlobals();
  });

  it('requeues a single FAILED delivery', async () => {
    vi.stubGlobal('alert', vi.fn());
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.getDestinationDeliveries.mockResolvedValue({
      deliveries: [failedDelivery],
      total: 1,
    });
    mocks.requeueDelivery.mockResolvedValue({ ...failedDelivery, status: 'PENDING', attempts: 0 });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'log' }));
    const requeue = await screen.findByTitle('Re-send at its original queue position');
    fireEvent.click(requeue);

    await waitFor(() => expect(mocks.requeueDelivery).toHaveBeenCalledWith('ep-1', 'del-failed'));
    vi.unstubAllGlobals();
  });

  it('shows requeue all failed only when a FAILED delivery exists', async () => {
    vi.stubGlobal('alert', vi.fn());
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.getDestinationDeliveries.mockResolvedValue({
      deliveries: [
        {
          ...failedDelivery,
          id: 'del-success',
          seq: 1,
          status: 'SUCCESS',
          attempts: 1,
        },
      ],
      total: 1,
    });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'log' }));
    expect(await screen.findByText('SUCCESS')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'requeue all failed' })).toBeNull();

    vi.unstubAllGlobals();
  });

  it('requeues all failed deliveries', async () => {
    vi.stubGlobal('alert', vi.fn());
    mocks.getDestinations.mockResolvedValue([endpoint]);
    mocks.getDestinationDeliveries.mockResolvedValue({
      deliveries: [failedDelivery],
      total: 1,
    });
    mocks.requeueFailedDeliveries.mockResolvedValue({ requeued: 1, skipped_unbuilt: 0 });

    render(
      <MemoryRouter>
        <AdminDestinations />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'log' }));
    fireEvent.click(await screen.findByRole('button', { name: 'requeue all failed' }));

    await waitFor(() => expect(mocks.requeueFailedDeliveries).toHaveBeenCalledWith('ep-1'));
    vi.unstubAllGlobals();
  });
});
