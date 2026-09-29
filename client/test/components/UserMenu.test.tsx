import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UserMenu from '../../src/components/UserMenu';
import type { DonorWallet } from '../../src/types';

const donor: DonorWallet = {
  id: 'd1',
  email: 'alice@example.com',
  balance_remaining: 1000,
  total_donated: 5000,
  role: 'USER',
  donations: [],
  reward_claims: [],
  poll_votes: [],
  fund_contributions: [],
  custom_entries: [],
};

describe('UserMenu', () => {
  it('toggles the dropdown open and closed', () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <UserMenu donor={donor} onLogout={onLogout} />
      </MemoryRouter>,
    );

    // Initially closed
    expect(screen.queryByText('wallet')).toBeNull();

    // Open
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('wallet')).toBeInTheDocument();
    expect(screen.getByText('logout')).toBeInTheDocument();
  });

  it('calls onLogout when the logout button is clicked', () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <UserMenu donor={donor} onLogout={onLogout} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('logout'));

    expect(onLogout).toHaveBeenCalled();
  });

  it('shows the moderate link for a moderator', () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <UserMenu donor={{ ...donor, role: 'MODERATOR' }} onLogout={onLogout} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('moderate')).toBeInTheDocument();
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('shows both moderate and admin links for an admin', () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <UserMenu donor={{ ...donor, role: 'ADMIN' }} onLogout={onLogout} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('moderate')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('closes on Escape key', () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <UserMenu donor={donor} onLogout={onLogout} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('wallet')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('wallet')).toBeNull();
  });
});
