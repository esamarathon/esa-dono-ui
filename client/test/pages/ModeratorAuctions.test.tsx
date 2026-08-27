import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import { ModeratorChannelFilterProvider } from '../../src/context/ModeratorChannelFilterContext';
import ModeratorAuctions from '../../src/pages/moderator/ModeratorAuctions';

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

function renderPage() {
  return render(
    <ModeratorChannelFilterProvider>
      <ModeratorAuctions />
    </ModeratorChannelFilterProvider>,
  );
}

function mockGet() {
  moderatorClient.get.mockImplementation((path: string) => {
    if (path === '/auctions') return Promise.resolve({ data: [auction] });
    return Promise.resolve({ data: [] });
  });
}

describe('ModeratorAuctions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists auctions', async () => {
    mockGet();
    renderPage();
    expect(await screen.findByText('Signed Guitar')).toBeInTheDocument();
    expect(screen.getByText(/current bid:/)).toHaveTextContent('$15.00');
  });

  it('creates an auction', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });
    moderatorClient.post.mockResolvedValue({ data: { id: 'a2' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '+ new auction' }));
    expect(screen.getByText('new auction')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/auctions', expect.any(Object)),
    );
  });

  it('edits an auction', async () => {
    mockGet();
    moderatorClient.put.mockResolvedValue({ data: auction });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('edit auction')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(moderatorClient.put).toHaveBeenCalledWith('/auctions/a1', expect.any(Object)),
    );
  });

  it('force-closes an open auction', async () => {
    mockGet();
    moderatorClient.post.mockResolvedValue({ data: { success: true, status: 'UNSOLD' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'force close' }));
    await waitFor(() => expect(moderatorClient.post).toHaveBeenCalledWith('/auctions/a1/close'));
  });

  it('cancels an auction', async () => {
    mockGet();
    moderatorClient.post.mockResolvedValue({ data: { success: true, status: 'CANCELLED' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(moderatorClient.post).toHaveBeenCalledWith('/auctions/a1/cancel'));
  });

  it('shows the cascade view with resend/skip actions for an awaiting-payment auction', async () => {
    const awaiting = { ...auction, status: 'AWAITING_PAYMENT' };
    moderatorClient.get.mockImplementation((path: string) => {
      if (path === '/auctions') return Promise.resolve({ data: [awaiting] });
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
    moderatorClient.post.mockResolvedValue({ data: { success: true } });

    renderPage();
    await screen.findByText('Signed Guitar');

    fireEvent.click(screen.getByRole('button', { name: 'resend' }));
    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/auctions/a1/resend-offer'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'skip to next' }));
    await waitFor(() =>
      expect(moderatorClient.post).toHaveBeenCalledWith('/auctions/a1/skip-offer'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'cascade' }));
    expect(await screen.findByText(/rank 1/)).toBeInTheDocument();
  });
});
