import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getDonor = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/donor', () => ({ getDonor }));

const moderatorClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));
vi.mock('../../src/api/staffKeys');

import { validateModeratorKey } from '../../src/api/staffKeys';
import ModeratorLayout from '../../src/pages/moderator/ModeratorLayout';

describe('ModeratorLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    moderatorClient.get.mockResolvedValue({ data: [] });
    vi.mocked(validateModeratorKey).mockResolvedValue('valid');
  });

  it('shows the login gate when there is no key or session', async () => {
    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('moderator login')).toBeInTheDocument();
    expect(validateModeratorKey).not.toHaveBeenCalled();
  });

  it('renders the nav when a stored moderator key validates', async () => {
    localStorage.setItem('moderator_key', 'secret');
    localStorage.setItem('moderator_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    expect(validateModeratorKey).toHaveBeenCalledWith('secret');
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
    expect(validateModeratorKey).not.toHaveBeenCalled();
  });

  it('logs in via the key entry form and persists the key only after validation', async () => {
    localStorage.setItem('moderator_sidebar_collapsed', '0');

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter moderator key');
    fireEvent.change(input, { target: { value: 'mykey' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    expect(validateModeratorKey).toHaveBeenCalledWith('mykey');
    expect(localStorage.getItem('moderator_key')).toBe('mykey');
  });

  it('shows an error when login is attempted without a key', async () => {
    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'login' }));
    expect(screen.getByText('Enter moderator key')).toBeInTheDocument();
  });

  it('keeps the login form with an inline error when the key is rejected', async () => {
    localStorage.setItem('moderator_sidebar_collapsed', '0');
    vi.mocked(validateModeratorKey).mockResolvedValue('invalid');

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter moderator key');
    fireEvent.change(input, { target: { value: 'totally-wrong-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('Invalid key')).toBeInTheDocument();
    expect(localStorage.getItem('moderator_key')).toBeNull();
    expect(screen.getByText('moderator login')).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('keeps the login form with an inline error when the key cannot be verified', async () => {
    vi.mocked(validateModeratorKey).mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText('Enter moderator key');
    fireEvent.change(input, { target: { value: 'mykey' } });
    fireEvent.click(screen.getByRole('button', { name: 'login' }));

    expect(await screen.findByText('Could not verify the key. Try again.')).toBeInTheDocument();
    expect(localStorage.getItem('moderator_key')).toBeNull();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('clears a stored key the server rejects and shows the login form on load', async () => {
    localStorage.setItem('moderator_key', 'stale-key');
    localStorage.setItem('moderator_sidebar_collapsed', '0');
    vi.mocked(validateModeratorKey).mockResolvedValue('invalid');

    render(
      <MemoryRouter>
        <ModeratorLayout />
      </MemoryRouter>,
    );

    expect(await screen.findByText('moderator login')).toBeInTheDocument();
    expect(validateModeratorKey).toHaveBeenCalledWith('stale-key');
    expect(localStorage.getItem('moderator_key')).toBeNull();
    expect(screen.queryByText('dashboard')).toBeNull();
  });
});
