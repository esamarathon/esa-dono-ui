import { describe, it, expect, vi, beforeEach } from 'vitest';
import { donorAuth } from '../../middleware/donorAuth.js';

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

describe('donorAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when token is missing', async () => {
    const req = { query: {} };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    vi.mocked(prisma.donor.findUnique).mockResolvedValue(null);
    const req = { query: { token: 'invalid-token' } };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
  });

  it('returns 401 when token is expired', async () => {
    const pastDate = new Date(Date.now() - 100000);
    vi.mocked(prisma.donor.findUnique).mockResolvedValue({ token_expires_at: pastDate } as any);
    const req = { query: { token: 'expired-token' } };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token expired' });
  });

  it('returns 403 when donor is frozen', async () => {
    const futureDate = new Date(Date.now() + 100000);
    vi.mocked(prisma.donor.findUnique).mockResolvedValue({
      id: 'donor-1',
      email: 'frozen@example.com',
      token_expires_at: futureDate,
      is_frozen: true,
    } as any);
    const req = { query: { token: 'frozen-token' } };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account frozen' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.donor for valid token', async () => {
    const futureDate = new Date(Date.now() + 100000);
    const donor = {
      id: 'donor-1',
      email: 'test@example.com',
      token_expires_at: futureDate,
      is_frozen: false,
      role: 'USER',
    };
    vi.mocked(prisma.donor.findUnique).mockResolvedValue(donor as any);
    const req = { query: { token: 'valid-token' } };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).donor).toEqual(donor);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resolves effective role from ADMIN_EMAILS without persisting or requiring a donation', async () => {
    const futureDate = new Date(Date.now() + 100000);
    const donor = {
      id: 'donor-1',
      email: 'hardcoded-admin@example.com',
      token_expires_at: futureDate,
      is_frozen: false,
      role: 'USER',
    };
    vi.mocked(prisma.donor.findUnique).mockResolvedValue(donor as any);
    process.env.ADMIN_EMAILS = 'hardcoded-admin@example.com';
    const req = { query: { token: 'valid-token' } };
    const res = createRes();
    const next = vi.fn();

    await donorAuth(req as any, res as any, next);

    expect((req as any).donor.role).toBe('ADMIN');
    delete process.env.ADMIN_EMAILS;
  });
});
