import { readdir } from 'node:fs/promises';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catchAsyncErrors, errorHandler, handle, httpError } from '../../lib/httpError.js';

afterEach(() => vi.restoreAllMocks());

function finish(app: express.Express) {
  catchAsyncErrors(app);
  app.use(errorHandler);
  return app;
}

describe('central route error handling', () => {
  it.each([400, 404, 409])('preserves a rejected HTTP %i error and message', async (status) => {
    const app = express();
    app.get('/fail', async () => {
      throw httpError(status, 'Expected failure');
    });
    const response = await request(finish(app)).get('/fail');
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: 'Expected failure' });
  });

  it.each([null, undefined, 'route', 'router', httpError(500, 'Private Prisma detail')])(
    'returns a generic 500 for a rejection with value %j',
    async (error) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const app = express();
      app.get('/fail', async () => {
        throw error;
      });
      const response = await request(finish(app)).get('/fail');
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(log).toHaveBeenCalledOnce();
    },
  );

  it('logs and hides unexpected async middleware errors, then serves another request', async () => {
    const error = new Error('Private database detail');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    const outer = express.Router();
    const inner = express.Router();
    inner.use('/fail', async () => {
      throw error;
    });
    outer.use('/nested', inner);
    app.use('/api', outer);
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    const response = await request(finish(app)).get('/api/nested/fail');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(log).toHaveBeenCalledWith('[routes] unexpected error:', error);
    expect((await request(app).get('/ok')).body).toEqual({ ok: true });
  });

  it('catches a promise returned by a non-async handler', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.route('/fail').get(() => Promise.reject(new Error('Private detail')));
    const response = await request(finish(app)).get('/fail');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  it('keeps four-argument error middleware working for synchronous throws', async () => {
    const app = express();
    const router = express.Router();
    router.get('/fail', () => {
      throw httpError(400, 'Upload error');
    });
    const uploadError: ErrorRequestHandler = (err, _req, res, _next) => {
      res.status(422).json({ error: err.message });
    };
    router.use(uploadError);
    app.use('/uploads', router);
    const response = await request(finish(app)).get('/uploads/fail');
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: 'Upload error' });
  });

  it('forwards a rejection from async four-argument error middleware', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/fail', () => {
      throw new Error('Initial failure');
    });
    const failingErrorMiddleware: ErrorRequestHandler = async (_err, _req, _res, _next) => {
      throw httpError(409, 'Error middleware failed');
    };
    app.use(failingErrorMiddleware);
    const response = await request(finish(app)).get('/fail').timeout(1000);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Error middleware failed' });
  });

  it('does not attempt another response after headers were sent', async () => {
    const error = new Error('After headers');
    const next = vi.fn();
    const res = { headersSent: true, status: vi.fn() };
    errorHandler(error, {} as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keeps existing handle() mapping without logging an expected error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get(
      '/fail',
      handle('[existing]', async () => {
        throw httpError(404, 'Not found');
      }),
    );
    const response = await request(finish(app)).get('/fail');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
    expect(log).not.toHaveBeenCalled();
  });

  it('forwards rejections from every registered handler in every router', async () => {
    // Discover all routers, not a hand-maintained list that can miss a new file.
    // identityRoutes has no default: its handlers are mounted by admin/moderator.
    const files = (await readdir(new URL('../../routes/', import.meta.url))).filter((name) =>
      name.endsWith('.ts'),
    );
    const app = express();
    const routerNames: string[] = [];
    for (const file of files) {
      const name = file.slice(0, -3);
      const module = await import(`../../routes/${name}.ts`);
      if (module.default) {
        app.use(module.default);
        routerNames.push(file);
      }
    }
    expect(routerNames).toContain('admin.ts');
    expect(routerNames).toContain('moderator.ts');

    type Layer = {
      handle: (RequestHandler | ErrorRequestHandler) & { stack?: Layer[] };
      route?: { stack: Layer[] };
    };
    const handlers: Array<{ layer: Layer; original: Layer['handle'] }> = [];
    const failure = new Error('Forced rejection');
    function inject(stack: Layer[]) {
      for (const layer of stack) {
        if (layer.route) inject(layer.route.stack);
        else if (layer.handle.stack) inject(layer.handle.stack);
        else if (layer.handle.length <= 4) {
          handlers.push({ layer, original: layer.handle });
          layer.handle =
            layer.handle.length === 4
              ? async (
                  _err: unknown,
                  _req: Request,
                  _res: Response,
                  _next: express.NextFunction,
                ) => {
                  throw failure;
                }
              : async () => {
                  throw failure;
                };
        }
      }
    }
    inject(app._router.stack);
    expect(handlers.length).toBeGreaterThan(0);
    try {
      catchAsyncErrors(app);
      for (const { layer } of handlers) {
        const next = vi.fn();
        // Consume an escaping promise so this guard fails an assertion rather
        // than crashing Vitest itself when the wrapper is missing.
        const result =
          layer.handle.length === 4
            ? (layer.handle as ErrorRequestHandler)(
                new Error('Initial failure'),
                {} as Request,
                {} as Response,
                next,
              )
            : (layer.handle as RequestHandler)({} as Request, {} as Response, next);
        await Promise.resolve(result).catch(() => {});
        expect(next).toHaveBeenCalledExactlyOnceWith(failure);
      }
    } finally {
      for (const { layer, original } of handlers) layer.handle = original;
    }
  });
});
