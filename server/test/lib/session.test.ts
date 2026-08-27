import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { setSessionCookie, clearSessionCookie, readSessionCookie } from '../../lib/session.js';

function fakeRes() {
  const headers: Record<string, string | string[]> = {};
  const res = {
    getHeader: (k: string) => headers[k.toLowerCase()] ?? headers[k],
    setHeader: (k: string, v: string | string[]) => {
      headers[k] = v;
    },
  };
  return { res: res as unknown as Response, headers };
}

describe('session cookie helpers', () => {
  it('setSessionCookie sets an httpOnly SameSite=Lax cookie', () => {
    const { res, headers } = fakeRes();
    setSessionCookie(res, 'tok123');
    const cookie = headers['Set-Cookie'];
    expect(cookie).toContain('dono_session=tok123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=');
  });

  it('clearSessionCookie sets an expired cookie', () => {
    const { res, headers } = fakeRes();
    clearSessionCookie(res);
    const cookie = headers['Set-Cookie'];
    expect(cookie).toContain('dono_session=');
    expect(cookie).toContain('Expires=');
  });

  it('readSessionCookie reads the token from the cookie header', () => {
    const req = { headers: { cookie: 'foo=bar; dono_session=tok123; baz=qux' } };
    expect(readSessionCookie(req as never)).toBe('tok123');
  });

  it('readSessionCookie returns undefined when the cookie is absent', () => {
    const req = { headers: {} };
    expect(readSessionCookie(req as never)).toBeUndefined();
  });

  it('appends multiple Set-Cookie headers', () => {
    const { res, headers } = fakeRes();
    setSessionCookie(res, 'a');
    setSessionCookie(res, 'b');
    expect(Array.isArray(headers['Set-Cookie'])).toBe(true);
  });
});
