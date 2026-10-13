import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

/** An Error carrying an HTTP `status`, the convention routes already use (see services/pledge.ts). */
export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Send an Error carrying `status` as `{ error }` JSON. A 500 (explicit or
 * unexpected) is always logged server-side and returned with a generic message.
 */
export function sendError(res: Response, e: unknown, logPrefix = '[routes]'): void {
  const status = (e as { status?: number } | null | undefined)?.status;
  if (status && status !== 500) {
    res.status(status).json({ error: (e as Error).message });
    return;
  }
  console.error(`${logPrefix} unexpected error:`, e);
  res.status(500).json({ error: 'Internal server error' });
}

// Express 4's private stack shape, also used by the OpenAPI coverage test.
interface Layer {
  handle: (RequestHandler | ErrorRequestHandler) & { stack?: Layer[] };
  route?: { stack: Layer[] };
}

// next(null/undefined) and next('route'/'router') mean control flow, not failure.
// Preserve status-bearing objects; normalize primitive rejection reasons.
function rejectionError(err: unknown): unknown {
  return typeof err === 'object' && err !== null
    ? err
    : new Error('Async handler rejected', { cause: err });
}

/** Install after all routes are registered, before listen(). Includes async middleware. */
export function catchAsyncErrors(app: Express): void {
  function wrap(stack: Layer[]): void {
    for (const layer of stack) {
      if (layer.route) {
        wrap(layer.route.stack);
      } else if (layer.handle.stack) {
        wrap(layer.handle.stack);
      } else {
        // Express distinguishes error middleware by its four-argument signature.
        if (layer.handle.length === 4) {
          const handler = layer.handle as ErrorRequestHandler;
          layer.handle = (err: unknown, req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(handler(err, req, res, next)).catch((e: unknown) =>
              next(rejectionError(e)),
            );
          };
        } else if (layer.handle.length < 4) {
          const handler = layer.handle as RequestHandler;
          layer.handle = (req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(handler(req, res, next)).catch((err: unknown) =>
              next(rejectionError(err)),
            );
          };
        }
      }
    }
  }

  wrap((app._router as { stack: Layer[] }).stack);
}

/** The single final error path for sync throws and forwarded async rejections. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  sendError(res, err);
};

/** Wrap an async handler: Express 4 does not catch a rejected promise. */
export function handle(logPrefix: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      sendError(res, e, logPrefix);
    }
  };
}
