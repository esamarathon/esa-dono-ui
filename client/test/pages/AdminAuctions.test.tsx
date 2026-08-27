import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  uploadRewardImage: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: mocks.adminClient,
  uploadRewardImage: mocks.uploadRewardImage,
}));

import AdminAuctions from '../../src/pages/admin/AdminAuctions';

const auction = {
  id: 'a1',
  title: 'Signed Guitar',
  description: null,
  type: 'PHYSICAL',
  custom_type_label: null,
  image_url: null,
  starting_price_cents: 1000,
  min_increment_cents: 100,
  current_bid_cents: 1500,
  current_bidder_id: 'd1',
  ends_at: new Date(Date.now() + 3_600_000).toISOString(),
  status: 'OPEN',
  is_active: true,
  channel_id: null,
};

function mockGet(overrides: Record<string, unknown> = {}) {
  mocks.adminClient.get.mockImplementation((path: string) => {
    if (path === '/auctions') return Promise.resolve({ data: [auction] });
    if (path === '/events') return Promise.resolve({ data: [] });
    if (overrides[path]) return Promise.resolve({ data: overrides[path] });
    return Promise.resolve({ data: [] });
  });
}

describe('AdminAuctions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists auctions with current bid and status', async () => {
    mockGet();
    render(<AdminAuctions />);
    expect(await screen.findByText('Signed Guitar')).toBeInTheDocument();
    expect(screen.getByText(/current bid:/)).toHaveTextContent('$15.00');
  });

  it('creates an auction', async () => {
    mocks.adminClient.get.mockResolvedValue({ data: [] });
    mocks.adminClient.post.mockResolvedValue({ data: { id: 'a2' } });
    render(<AdminAuctions />);
    fireEvent.click(await screen.findByRole('button', { name: '+ new auction' }));
    expect(screen.getByText('new auction')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/auctions', expect.any(Object)),
    );
  });

  it('edits an auction', async () => {
    mockGet();
    mocks.adminClient.put.mockResolvedValue({ data: auction });
    render(<AdminAuctions />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit auction')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.adminClient.put).toHaveBeenCalledWith('/auctions/a1', expect.any(Object)),
    );
  });

  it('deletes an auction after confirmation', async () => {
    mockGet();
    mocks.adminClient.delete.mockResolvedValue({ data: { success: true } });
    render(<AdminAuctions />);
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    await waitFor(() => expect(mocks.adminClient.delete).toHaveBeenCalledWith('/auctions/a1'));
  });

  it('force-closes an open auction', async () => {
    mockGet();
    mocks.adminClient.post.mockResolvedValue({ data: { success: true, status: 'UNSOLD' } });
    render(<AdminAuctions />);
    fireEvent.click(await screen.findByRole('button', { name: 'force close' }));
    await waitFor(() => expect(mocks.adminClient.post).toHaveBeenCalledWith('/auctions/a1/close'));
  });

  it('cancels an auction', async () => {
    mockGet();
    mocks.adminClient.post.mockResolvedValue({ data: { success: true, status: 'CANCELLED' } });
    render(<AdminAuctions />);
    fireEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(mocks.adminClient.post).toHaveBeenCalledWith('/auctions/a1/cancel'));
  });

  it('shows resend/skip actions and the cascade view for an awaiting-payment auction', async () => {
    const awaiting = { ...auction, status: 'AWAITING_PAYMENT' };
    mocks.adminClient.get.mockImplementation((path: string) => {
      if (path === '/auctions') return Promise.resolve({ data: [awaiting] });
      if (path === '/events') return Promise.resolve({ data: [] });
      if (path === '/auctions/a1/offers') {
        return Promise.resolve({
          data: [
            {
              id: 'o1',
              rank: 1,
              amount_cents: 1500,
              status: 'SENT',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    mocks.adminClient.post.mockResolvedValue({ data: { success: true } });

    render(<AdminAuctions />);
    await screen.findByText('Signed Guitar');

    fireEvent.click(screen.getByRole('button', { name: 'resend' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/auctions/a1/resend-offer'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'skip to next' }));
    await waitFor(() =>
      expect(mocks.adminClient.post).toHaveBeenCalledWith('/auctions/a1/skip-offer'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'cascade' }));
    expect(await screen.findByText(/rank 1/)).toBeInTheDocument();
  });
});
