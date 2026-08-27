import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/api/auctions', () => ({
  getAuctions: vi.fn(),
  placeBid: vi.fn(),
}));

import Auctions from '../../src/pages/Auctions';
import { getAuctions, placeBid } from '../../src/api/auctions';
import type { Auction } from '../../src/types';

const openAuction: Auction = {
  id: 'a1',
  title: 'Signed Guitar',
  description: 'A rare find',
  type: 'PHYSICAL',
  starting_price_cents: 1000,
  min_increment_cents: 100,
  current_bid_cents: null,
  min_next_bid_cents: 1000,
  ends_at: new Date(Date.now() + 3_600_000).toISOString(),
  status: 'OPEN',
};

describe('Auctions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an empty state when there are no auctions', async () => {
    vi.mocked(getAuctions).mockResolvedValue([]);
    render(<Auctions />);
    expect(await screen.findByText('No auctions right now.')).toBeInTheDocument();
  });

  it('renders an open auction with current bid and a bid form', async () => {
    vi.mocked(getAuctions).mockResolvedValue([openAuction]);
    render(<Auctions />);
    expect(await screen.findByText('Signed Guitar')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bid' })).toBeInTheDocument();
  });

  it('places a bid and reloads the list', async () => {
    vi.mocked(getAuctions).mockResolvedValue([openAuction]);
    vi.mocked(placeBid).mockResolvedValue({ success: true });

    render(<Auctions />);
    await screen.findByText('Signed Guitar');

    fireEvent.click(screen.getByRole('button', { name: 'bid' }));

    await waitFor(() => expect(placeBid).toHaveBeenCalledWith('a1', 1000));
    await waitFor(() => expect(getAuctions).toHaveBeenCalledTimes(2));
  });

  it('shows a validation error for an invalid bid amount', async () => {
    vi.mocked(getAuctions).mockResolvedValue([openAuction]);
    render(<Auctions />);
    await screen.findByText('Signed Guitar');

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'bid' }));

    expect(await screen.findByText('Enter a valid bid amount.')).toBeInTheDocument();
    expect(placeBid).not.toHaveBeenCalled();
  });

  it('shows a server error message when the bid is rejected', async () => {
    vi.mocked(getAuctions).mockResolvedValue([openAuction]);
    vi.mocked(placeBid).mockRejectedValue({
      response: { data: { error: 'You are already the highest bidder' } },
    });

    render(<Auctions />);
    await screen.findByText('Signed Guitar');
    fireEvent.click(screen.getByRole('button', { name: 'bid' }));

    expect(await screen.findByText('You are already the highest bidder')).toBeInTheDocument();
  });

  it('does not show a bid form for a closed auction', async () => {
    vi.mocked(getAuctions).mockResolvedValue([{ ...openAuction, status: 'SETTLED' }]);
    render(<Auctions />);
    await screen.findByText('Signed Guitar');
    expect(screen.queryByRole('button', { name: 'bid' })).not.toBeInTheDocument();
    expect(screen.getByText('settled')).toBeInTheDocument();
  });
});
