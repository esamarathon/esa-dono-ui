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

// Focused OpenAPI 3.0 object-shape guard, not a full spec validator.
const responseFields = new Set(['$ref', 'description', 'headers', 'content', 'links']);
const schemaFields = new Set([
  '$ref',
  'title',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'required',
  'enum',
  'type',
  'allOf',
  'oneOf',
  'anyOf',
  'not',
  'items',
  'properties',
  'additionalProperties',
  'description',
  'format',
  'default',
  'nullable',
  'discriminator',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  'example',
  'deprecated',
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function objectErrors(value: unknown, fields: ReadonlySet<string>, path: string) {
  if (!record(value)) return [`${path}: expected an object`];
  return Object.keys(value)
    .filter((key) => !fields.has(key) && !key.startsWith('x-'))
    .map((key) => `${path}: unexpected field ${key}`);
}
function schemaErrors(value: unknown, path: string): string[] {
  const errors = objectErrors(value, schemaFields, path);
  if (!record(value)) return errors;
  if ('description' in value && typeof value.description !== 'string')
    errors.push(`${path}: description must be text`);
  if (record(value.properties))
    for (const [name, schema] of Object.entries(value.properties))
      errors.push(...schemaErrors(schema, `${path}.properties.${name}`));
  for (const key of ['items', 'not', 'additionalProperties'])
    if (key in value && typeof value[key] !== 'boolean')
      errors.push(...schemaErrors(value[key], `${path}.${key}`));
  for (const key of ['allOf', 'oneOf', 'anyOf'])
    if (Array.isArray(value[key]))
      for (const [index, schema] of value[key].entries())
        errors.push(...schemaErrors(schema, `${path}.${key}[${index}]`));
  return errors;
}
function contractErrors(spec: unknown) {
  const responses: string[] = [],
    schemas: string[] = [];
  function walk(value: unknown, path: string) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const location = `${path}.${key}`;
      // Examples, extension payloads and defaults are arbitrary data, not schemas.
      if (['example', 'examples', 'default', 'enum'].includes(key) || key.startsWith('x-'))
        continue;
      if (key === 'schema') {
        schemas.push(...schemaErrors(child, location));
        continue;
      }
      if (location === 'spec.components.schemas' && record(child)) {
        for (const [name, schema] of Object.entries(child))
          schemas.push(...schemaErrors(schema, `${location}.${name}`));
        continue;
      }
      if (key === 'responses' && record(child))
        for (const [code, response] of Object.entries(child)) {
          if (code.startsWith('x-')) continue;
          responses.push(...objectErrors(response, responseFields, `${location}.${code}`));
          if (record(response) && !('$ref' in response) && typeof response.description !== 'string')
            responses.push(`${location}.${code}: description must be text`);
        }
      walk(child, location);
    }
  }
  walk(spec, 'spec');
  return { responses, schemas };
}

describe('OpenAPI route coverage', () => {
  it('publishes the current server package version', async () => {
    const { default: yaml } = await import('js-yaml');
    const spec = yaml.load(readFileSync(resolve(__dirname, '..', 'openapi.yaml'), 'utf8'));
    const { version } = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(spec).toMatchObject({ info: { version } });
  });

  it.each(['responses', 'schemas'] as const)(
    'publishes valid parsed OpenAPI 3.0 %s object fields',
    async (kind) => {
      const { default: yaml } = await import('js-yaml');
      const spec = yaml.load(readFileSync(resolve(__dirname, '..', 'openapi.yaml'), 'utf8'));
      expect(contractErrors(spec)[kind]).toEqual([]);
    },
  );
  it('allows extensions, arbitrary examples and property names without treating them as object keywords', () => {
    expect(
      contractErrors({
        paths: {
          '/fixture': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  'x-source': { arbitrary: null },
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        'x-fixture': true,
                        properties: { 'not the allocation': { type: 'integer' } },
                        example: { schema: { arbitrary: null }, responses: { arbitrary: null } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual({ responses: [], schemas: [] });
  });
  it('rejects split prose in response and nested schema objects after parsing', async () => {
    const { default: yaml } = await import('js-yaml');
    const spec = yaml.load(
      'paths: { /fixture: { get: { responses: { "400": { description: Invalid key, duplicate target } } } } }\ncomponents: { schemas: { Fixture: { type: array, items: { type: integer, description: Current price, not the allocation } } } }',
    );
    expect(contractErrors(spec)).toEqual({
      responses: ['spec.paths./fixture.get.responses.400: unexpected field duplicate target'],
      schemas: ['spec.components.schemas.Fixture.items: unexpected field not the allocation'],
    });
  });
  it('documents the allocation-history conflict on every hard-remove route', async () => {
    const { default: yaml } = await import('js-yaml');
    const spec = yaml.load(readFileSync(resolve(__dirname, '..', 'openapi.yaml'), 'utf8'));
    expect(spec).toMatchObject({
      paths: Object.fromEntries(
        [
          '/admin/rewards/{id}',
          '/admin/polls/{id}',
          '/moderator/rewards/{id}',
          '/moderator/polls/{id}',
          '/moderator/polls/options/{id}',
          '/moderator/goals/{id}',
        ].map((path) => [
          path,
          {
            delete: {
              responses: { '409': { $ref: '#/components/responses/AllocationHistoryConflict' } },
            },
          },
        ]),
      ),
      components: {
        responses: {
          AllocationHistoryConflict: {
            content: {
              'application/json': {
                schema: {
                  required: ['error'],
                  properties: {
                    error: { enum: ['This has allocation history. Deactivate it instead.'] },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('documents the three optional ESA lookup envelopes separately from bare Tiltify DTOs', async () => {
    const { default: yaml } = await import('js-yaml');
    const spec = yaml.load(readFileSync(resolve(__dirname, '..', 'openapi.yaml'), 'utf8'));
    for (const [kind, param, resource] of [
      ['rewards', 'reward_id', 'Reward'],
      ['targets', 'target_id', 'Target'],
      ['polls', 'poll_id', 'Poll'],
    ]) {
      expect(spec).toMatchObject({
        paths: {
          [`/tiltify/campaign/{id}/lookup/${kind}/{${param}}`]: {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: `#/components/schemas/EsaDono${resource}Lookup` },
                    },
                  },
                },
                '404': { description: expect.any(String) },
              },
            },
          },
        },
        components: {
          schemas: {
            [`EsaDono${resource}Lookup`]: {
              type: 'object',
              required: ['campaign_id', 'incentive'],
              additionalProperties: false,
              properties: {
                campaign_id: { type: 'string', format: 'uuid', nullable: true },
                incentive: { $ref: `#/components/schemas/Tiltify${resource}` },
              },
            },
          },
        },
      });
    }
  });

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
    const { default: eventsRouter } = await import('../routes/events.js');
    const { default: pledgeRouter } = await import('../routes/pledge.js');
    const { default: authRouter } = await import('../routes/auth.js');
    const { default: adminRouter } = await import('../routes/admin.js');
    const { default: moderatorRouter } = await import('../routes/moderator.js');
    const { default: auctionsRouter } = await import('../routes/auctions.js');
    const { default: tiltifyRouter } = await import('../routes/tiltify.js');

    app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);
    app.use(express.json());
    app.get('/api/health', (_req, _res) => {});
    app.use('/api/campaign', campaignRouter);
    app.use('/api/donor', donorRouter);
    app.use('/api/rewards', rewardsRouter);
    app.use('/api/polls', pollsRouter);
    app.use('/api/goals', goalsRouter);
    app.use('/api/channels', channelsRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/pledge', pledgeRouter);
    app.use('/api/auth', authRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api/moderator', moderatorRouter);
    app.use('/api/auctions', auctionsRouter);
    app.use('/api/tiltify', tiltifyRouter);

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
