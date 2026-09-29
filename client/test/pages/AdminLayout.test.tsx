import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getDonor = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/donor', () => ({ getDonor }));

import AdminLayout from '../../src/pages/admin/AdminLayout';

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows the login gate when there is no key or session', async () => {
    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('admin login')).toBeInTheDocument();
  });

  it('renders the nav when an admin key is present', async () => {
    localStorage.setItem('admin_key', 'secret');
    localStorage.setItem('admin_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('logs in via the key entry form', async () => {
    localStorage.setItem('admin_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter admin API key');
    fireEvent.change(input, { target: { value: 'mykey' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('shows an error when login is attempted without a key', async () => {
    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'login' }));
    expect(screen.getByText('Enter API key')).toBeInTheDocument();
  });

  it('grants access for an ADMIN-role donor session', async () => {
    localStorage.setItem('donor_session_active', '1');
    localStorage.setItem('admin_sidebar_collapsed', '0');
    getDonor.mockResolvedValue({ role: 'ADMIN' });

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });
});
