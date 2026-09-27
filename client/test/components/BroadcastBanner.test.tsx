import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const client = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/client', () => ({ default: client }));

import BroadcastBanner from '../../src/components/BroadcastBanner';

describe('BroadcastBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when there is no message', async () => {
    client.get.mockResolvedValue({ data: { message: null, level: null } });

    const { container } = render(<BroadcastBanner />);

    await waitFor(() => expect(client.get).toHaveBeenCalledWith('/campaign/broadcast'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the original fixed style when level is null (non-breaking default, #68)', async () => {
    client.get.mockResolvedValue({ data: { message: 'hello donors', level: null } });

    render(<BroadcastBanner />);

    const banner = await screen.findByText('hello donors');
    expect(banner).toHaveStyle({ borderBottom: '1px solid rgba(216, 226, 71, 0.2)' });
  });

  it('renders INFO styling', async () => {
    client.get.mockResolvedValue({ data: { message: 'fyi', level: 'INFO' } });

    render(<BroadcastBanner />);

    const banner = await screen.findByText('fyi');
    expect(banner).toHaveStyle({ borderBottom: '1px solid rgba(115, 78, 158, 0.3)' });
  });

  it('renders WARNING styling', async () => {
    client.get.mockResolvedValue({ data: { message: 'heads up', level: 'WARNING' } });

    render(<BroadcastBanner />);

    const banner = await screen.findByText('heads up');
    expect(banner).toHaveStyle({ borderBottom: '1px solid rgba(253, 187, 28, 0.4)' });
  });

  it('renders CRITICAL styling with more emphasis', async () => {
    client.get.mockResolvedValue({ data: { message: 'urgent!', level: 'CRITICAL' } });

    render(<BroadcastBanner />);

    const banner = await screen.findByText('urgent!');
    expect(banner).toHaveStyle({ borderBottom: '2px solid #fc1c67' });
  });

  it('renders nothing when the fetch fails', async () => {
    client.get.mockRejectedValue(new Error('network error'));

    const { container } = render(<BroadcastBanner />);

    await waitFor(() => expect(client.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
