import { describe, it, expect } from 'vitest';
import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const META_ROUTES = new Set(['/api/openapi.yaml', '/api/docs']);

function extractRoutes(app: express.Express): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];

  function walk(stack: any[], prefix: string) {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          const fullPath =
            (prefix + layer.route.path).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
          if (!META_ROUTES.has(fullPath)) {
            routes.push({
              method: method.toUpperCase(),
              path: fullPath.replace(/:(\w+)/g, '{$1}'),
            });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const subPrefix = prefix + regexpToExpressPath(layer.regexp);
        walk(layer.handle.stack, subPrefix);
      }
    }
  }

  function regexpToExpressPath(regexp: RegExp): string {
    // Express regexp source: /^\/prefix\/?(?=\/|$)/i
    // source: "^\\/prefix\\/?(?=\\/|$)"
    const src = regexp.source;
    // Strip leading ^\/
    const withoutCaret = src.startsWith('^\\/') ? src.slice(3) : src.replace(/^\^/, '');
    // Strip trailing \/? pattern
    const stripped = withoutCaret.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
    // Convert \/ to / for all remaining escaped slashes
    return '/' + stripped.replace(/\\\//g, '/');
  }

  walk(app._router.stack, '');
  return routes.filter((r) => r.path.startsWith('/api/'));
}

function normalizeExpressPath(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

describe('OpenAPI route coverage', () => {
  it('every Express route has a corresponding OpenAPI path', async () => {
    const { default: yaml } = await import('js-yaml');
    const specPath = resolve(__dirname, '..', 'openapi.yaml');
    const spec = yaml.load(readFileSync(specPath, 'utf8')) as any;

    const specPaths = new Map<string, Set<string>>();
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      const methodsSet = new Set<string>();
      for (const [method] of Object.entries(methods as object)) {
        methodsSet.add(method.toUpperCase());
      }
      specPaths.set('/api' + path, methodsSet);
    }

    const app = express();
    const { default: webhookRouter } = await import('../routes/webhook.js');
    const { default: campaignRouter } = await import('../routes/campaign.js');
    const { default: donorRouter } = await import('../routes/donor.js');
    const { default: rewardsRouter } = await import('../routes/rewards.js');
    const { default: pollsRouter } = await import('../routes/polls.js');
    const { default: goalsRouter } = await import('../routes/goals.js');
    const { default: channelsRouter } = await import('../routes/channels.js');
    const { default: pledgeRouter } = await import('../routes/pledge.js');
    const { default: authRouter } = await import('../routes/auth.js');
    const { default: adminRouter } = await import('../routes/admin.js');
    const { default: moderatorRouter } = await import('../routes/moderator.js');

    app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);
    app.use(express.json());
    app.get('/api/health', (_req, _res) => {});
    app.use('/api/campaign', campaignRouter);
    app.use('/api/donor', donorRouter);
    app.use('/api/rewards', rewardsRouter);
    app.use('/api/polls', pollsRouter);
    app.use('/api/goals', goalsRouter);
    app.use('/api/channels', channelsRouter);
    app.use('/api/pledge', pledgeRouter);
    app.use('/api/auth', authRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api/moderator', moderatorRouter);

    const expressRoutes = extractRoutes(app);

    const missing: string[] = [];
    for (const route of expressRoutes) {
      const normalized = normalizeExpressPath(route.path);
      const methods = specPaths.get(normalized);
      if (!methods || !methods.has(route.method)) {
        missing.push(`${route.method} ${route.path}`);
      }
    }

    const extraSpecPaths: string[] = [];
    for (const [specPath, specMethods] of specPaths) {
      const expressMethods = new Set(
        expressRoutes.filter((r) => normalizeExpressPath(r.path) === specPath).map((r) => r.method),
      );
      for (const method of specMethods) {
        if (!expressMethods.has(method)) {
          extraSpecPaths.push(`${method} ${specPath}`);
        }
      }
    }

    if (missing.length > 0 || extraSpecPaths.length > 0) {
      const msgs: string[] = [];
      if (missing.length > 0) {
        msgs.push('Express routes not in OpenAPI spec:');
        missing.forEach((r) => msgs.push(`  ${r}`));
      }
      if (extraSpecPaths.length > 0) {
        msgs.push('OpenAPI paths without Express routes:');
        extraSpecPaths.forEach((r) => msgs.push(`  ${r}`));
      }
      msgs.push(
        '',
        'Update server/openapi.yaml to match the actual routes, then re-run this test.',
      );
      expect.fail(msgs.join('\n'));
    }
  });
});
