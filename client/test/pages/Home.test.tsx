import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from '../../src/pages/Home';

vi.mock('../../src/api/campaign', () => ({
  getCampaign: vi.fn(),
}));

import { getCampaign } from '../../src/api/campaign';

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

describe('Home page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner initially', () => {
    vi.mocked(getCampaign).mockReturnValue(new Promise(() => {})); // never resolves
    renderHome();
    expect(document.querySelector('.animate-spin')).toBeDefined();
  });

  it('renders campaign data on success', async () => {
    vi.mocked(getCampaign).mockResolvedValue({
      name: 'Test Campaign',
      description: 'A test campaign',
      amount_raised: { value: '1500.00' },
      goal: { value: '5000.00' },
    });

    renderHome();

    expect(await screen.findByText('Test Campaign')).toBeDefined();
    expect(screen.getByText('A test campaign')).toBeDefined();
  });

  it('shows error on failure', async () => {
    vi.mocked(getCampaign).mockRejectedValue(new Error('Network error'));

    renderHome();

    expect(await screen.findByText(/Failed to load campaign/)).toBeDefined();
  });
});
