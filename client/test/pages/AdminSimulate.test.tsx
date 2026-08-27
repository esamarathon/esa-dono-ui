import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const adminClient = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../../src/api/admin', () => ({ default: adminClient }));

import AdminSimulate from '../../src/pages/admin/AdminSimulate';

describe('AdminSimulate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the form', () => {
    render(<AdminSimulate />);

    expect(screen.getByRole('heading', { name: 'simulate donation' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('donor@example.com')).toBeInTheDocument();
  });

  it('creates a simulated donation and shows the result', async () => {
    adminClient.post.mockResolvedValue({
      data: { token: 'tok123', donor: { balance_remaining: 1000 } },
    });

    render(<AdminSimulate />);

    fireEvent.change(screen.getByPlaceholderText('donor@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'simulate donation' }));

    expect(await screen.findByText('donation created!')).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/token=tok123/)).toBeInTheDocument();
  });
});
