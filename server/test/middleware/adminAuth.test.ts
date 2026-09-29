import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminAuth } from '../../middleware/adminAuth.js';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    donor: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../../lib/prisma.js';

function createRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

function bearer(token: string) {
  return { query: {}, headers: { authorization: `Bearer ${token}` } };
}

describe('adminAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  it('calls next() for a matching Bearer key_admin_ credential', async () => {
    const req = bearer('key_admin_test-admin-key');
    const res = createRes();
    const next = vi.fn();

    await adminAuth(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('grants access to an ADMIN-role donor session (ADR 0003)', async () => {
    vi.mocked(prisma.donor.findUnique).mockResolvedValue({
      id: 'd1',
      email: 'admin@example.com',
      token_expires_at: new Date(Date.now() + 60_000),
      is_frozen: false,
      role: 'ADMIN',
    } as any);
    const req = bearer('admin-donor-token');
    const res = createRes();
    const next = vi.fn();

    await adminAuth(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin (MODERATOR) donor session', async () => {
    vi.mocked(prisma.donor.findUnique).mockResolvedValue({
      id: 'd2',
      email: 'mod@example.com',
      token_expires_at: new Date(Date.now() + 60_000),
      is_frozen: false,
      role: 'MODERATOR',
    } as any);
    const req = bearer('mod-donor-token');
    const res = createRes();
    const next = vi.fn();

    await adminAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong admin key that is not a valid donor token', async () => {
    vi.mocked(prisma.donor.findUnique).mockResolvedValue(null);
    const req = bearer('key_admin_wrong');
    const res = createRes();
    const next = vi.fn();

    await adminAuth(req as any, res as any, next);

    // Wrong key → falls through to donorAuth, which finds no donor → 401.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when no credential is present', async () => {
    const req = { query: {}, headers: {} };
    const res = createRes();
    const next = vi.fn();

    await adminAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token required' });
    expect(next).not.toHaveBeenCalled();
  });
});
