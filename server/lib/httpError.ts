import type { Response } from 'express';

/** An Error carrying an HTTP `status`, the convention routes already use (see services/pledge.ts). */
export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Send an Error carrying `status` as `{ error }` JSON. Anything else is logged and
 * sent as a 500: Express 4 does not catch a rejected async handler, so rethrowing
 * would leave the request hanging.
 */
export function sendError(res: Response, e: unknown, logPrefix = '[routes]'): void {
  const status = (e as { status?: number }).status;
  if (status) {
    res.status(status).json({ error: (e as Error).message });
    return;
  }
  console.error(`${logPrefix} unexpected error:`, e);
  res.status(500).json({ error: 'Internal server error' });
}
