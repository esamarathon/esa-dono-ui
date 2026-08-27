import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../src/api/client', () => ({ default: { post } }));

import {
  extractToken,
  isSessionActive,
  startSession,
  endSession,
  noteSessionEstablished,
  clearSessionMarker,
} from '../../src/utils/authToken';

describe('authToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('extractToken parses a full URL and a bare token', () => {
    expect(extractToken('https://x/wallet?token=abc')).toBe('abc');
    expect(extractToken('abc')).toBe('abc');
    expect(extractToken('')).toBe('');
    expect(extractToken(null)).toBe('');
  });

  it('isSessionActive reads the marker', () => {
    expect(isSessionActive()).toBe(false);
    localStorage.setItem('donor_session_active', '1');
    expect(isSessionActive()).toBe(true);
  });

  it('startSession posts and marks active', async () => {
    post.mockResolvedValue({});
    await startSession('tok');
    expect(post).toHaveBeenCalledWith('/auth/session', { token: 'tok' });
    expect(localStorage.getItem('donor_session_active')).toBe('1');
  });

  it('endSession posts logout and marks inactive', async () => {
    localStorage.setItem('donor_session_active', '1');
    post.mockResolvedValue({});
    await endSession();
    expect(post).toHaveBeenCalledWith('/auth/session/logout');
    expect(localStorage.getItem('donor_session_active')).toBeNull();
  });

  it('endSession clears the marker even when the request fails', async () => {
    localStorage.setItem('donor_session_active', '1');
    post.mockRejectedValue(new Error('boom'));
    await expect(endSession()).rejects.toThrow('boom');
    expect(localStorage.getItem('donor_session_active')).toBeNull();
  });

  it('noteSessionEstablished and clearSessionMarker toggle the marker', () => {
    noteSessionEstablished();
    expect(localStorage.getItem('donor_session_active')).toBe('1');
    clearSessionMarker();
    expect(localStorage.getItem('donor_session_active')).toBeNull();
  });
});
