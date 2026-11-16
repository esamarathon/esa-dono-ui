import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getDonor = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/donor', () => ({ getDonor }));
vi.mock('../../src/api/staffKeys');

import { validateAdminKey } from '../../src/api/staffKeys';
import AdminLayout from '../../src/pages/admin/AdminLayout';

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(validateAdminKey).mockResolvedValue('valid');
  });

  it('shows the login gate when there is no key or session', async () => {
    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('admin login')).toBeInTheDocument();
    expect(validateAdminKey).not.toHaveBeenCalled();
  });

  it('renders the nav when a stored admin key validates', async () => {
    localStorage.setItem('admin_key', 'secret');
    localStorage.setItem('admin_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    expect(validateAdminKey).toHaveBeenCalledWith('secret');
  });

  it('logs in via the key entry form and persists the key only after validation', async () => {
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
    expect(validateAdminKey).toHaveBeenCalledWith('mykey');
    expect(localStorage.getItem('admin_key')).toBe('mykey');
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

  it('keeps the login form with an inline error when the key is rejected', async () => {
    localStorage.setItem('admin_sidebar_collapsed', '0');
    vi.mocked(validateAdminKey).mockResolvedValue('invalid');

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter admin API key');
    fireEvent.change(input, { target: { value: 'totally-wrong-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('Invalid key')).toBeInTheDocument();
    expect(localStorage.getItem('admin_key')).toBeNull();
    expect(screen.getByText('admin login')).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('keeps the login form with an inline error when the key cannot be verified', async () => {
    vi.mocked(validateAdminKey).mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter admin API key');
    fireEvent.change(input, { target: { value: 'mykey' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('Could not verify the key. Try again.')).toBeInTheDocument();
    expect(localStorage.getItem('admin_key')).toBeNull();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('clears a stored key the server rejects and shows the login form on load', async () => {
    localStorage.setItem('admin_key', 'stale-key');
    localStorage.setItem('admin_sidebar_collapsed', '0');
    vi.mocked(validateAdminKey).mockResolvedValue('invalid');

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('admin login')).toBeInTheDocument();
    expect(validateAdminKey).toHaveBeenCalledWith('stale-key');
    expect(localStorage.getItem('admin_key')).toBeNull();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('keeps a stored key that cannot be verified and shows the login form on load', async () => {
    localStorage.setItem('admin_key', 'maybe-good');
    vi.mocked(validateAdminKey).mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Could not verify the key. Try again.')).toBeInTheDocument();
    expect(localStorage.getItem('admin_key')).toBe('maybe-good');
    expect(screen.queryByText('dashboard')).toBeNull();
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
    expect(validateAdminKey).not.toHaveBeenCalled();
  });
});
