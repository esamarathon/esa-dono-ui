import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from '../../src/pages/Home';
import { CampaignProvider } from '../../src/context/CampaignContext';

vi.mock('../../src/api/campaign', () => ({
  getCampaign: vi.fn(),
}));

import { getCampaign } from '../../src/api/campaign';

function renderHome() {
  return render(
    <MemoryRouter>
      <CampaignProvider>
        <Home />
      </CampaignProvider>
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
      amount_raised: { value: '15602.67' },
      goal: { value: '60000.00' },
    });

    renderHome();

    expect(await screen.findByText('Test Campaign')).toBeDefined();
    expect(screen.getByText('A test campaign')).toBeDefined();
    expect(screen.getByText('raised')).toHaveClass('text-xl');
    const total = screen.getByText('$15,602.67 / $60,000.00');
    expect(total).toHaveClass('text-2xl', 'sm:text-3xl');
    expect(total.parentElement).toHaveClass('flex-wrap', 'gap-x-4', 'gap-y-1');
    expect(screen.getByText('26% of goal')).toHaveClass('text-xl');
  });

  it('shows error on failure', async () => {
    vi.mocked(getCampaign).mockRejectedValue(new Error('Network error'));

    renderHome();

    expect(await screen.findByText(/Failed to load campaign/)).toBeDefined();
  });
});
