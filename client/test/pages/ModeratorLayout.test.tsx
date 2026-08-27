import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getDonor = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/donor', () => ({ getDonor }));

const moderatorClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import ModeratorLayout from '../../src/pages/moderator/ModeratorLayout';

describe('ModeratorLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    moderatorClient.get.mockResolvedValue({ data: [] });
  });

  it('shows the login gate when there is no key or session', async () => {
    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('moderator login')).toBeInTheDocument();
  });

  it('renders the nav when a moderator key is present', async () => {
    localStorage.setItem('moderator_key', 'secret');
    localStorage.setItem('moderator_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('grants access for a MODERATOR-role donor session', async () => {
    localStorage.setItem('donor_session_active', '1');
    localStorage.setItem('moderator_sidebar_collapsed', '0');
    getDonor.mockResolvedValue({ role: 'MODERATOR' });

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });
});
