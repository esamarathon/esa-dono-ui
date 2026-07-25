import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminAuth } from '../../middleware/adminAuth.js';

function createRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

describe('adminAuth middleware', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  it('calls next() when key matches', () => {
    const req = { headers: { 'x-admin-key': 'test-admin-key' } };
    const res = createRes();
    const next = vi.fn();

    adminAuth(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when header is missing', () => {
    const req = { headers: {} };
    const res = createRes();
    const next = vi.fn();

    adminAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when key does not match', () => {
    const req = { headers: { 'x-admin-key': 'wrong-key' } };
    const res = createRes();
    const next = vi.fn();

    adminAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
