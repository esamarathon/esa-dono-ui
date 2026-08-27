import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const moderatorClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import ModeratorChannels from '../../src/pages/moderator/ModeratorChannels';

describe('ModeratorChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists channels', async () => {
    moderatorClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });

    render(<ModeratorChannels />);

    expect(await screen.findByText('Main')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    moderatorClient.get.mockResolvedValue({ data: [] });

    render(<ModeratorChannels />);

    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
  });
});
