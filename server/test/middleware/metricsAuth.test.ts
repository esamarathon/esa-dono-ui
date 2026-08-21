import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metricsAuth } from '../../middleware/metricsAuth.js';

function createRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

function bearer(token?: string) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe('metricsAuth middleware', () => {
  beforeEach(() => {
    process.env.METRICS_API_KEY = 'test-metrics-key';
  });

  it('calls next() for a matching Bearer key_metrics_ credential', () => {
    const req = bearer('key_metrics_test-metrics-key');
    const res = createRes();
    const next = vi.fn();

    metricsAuth(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong metrics key', () => {
    const req = bearer('key_metrics_wrong');
    const res = createRes();
    const next = vi.fn();

    metricsAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an admin key credential (wrong credential kind)', () => {
    const req = bearer('key_admin_test-metrics-key');
    const res = createRes();
    const next = vi.fn();

    metricsAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when no credential is present', () => {
    const req = bearer();
    const res = createRes();
    const next = vi.fn();

    metricsAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when METRICS_API_KEY is not configured (fail closed)', () => {
    delete process.env.METRICS_API_KEY;
    const req = bearer('key_metrics_anything');
    const res = createRes();
    const next = vi.fn();

    metricsAuth(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});
