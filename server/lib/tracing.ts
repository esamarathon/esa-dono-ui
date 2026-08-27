import type { Request, Response, NextFunction } from 'express';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * OpenTelemetry tracing for the server.
 *
 * Deliberately uses the low-level `NodeTracerProvider` + `BatchSpanProcessor`
 * rather than `@opentelemetry/sdk-node`'s auto-instrumentations. This app runs
 * via `tsx`, whose ESM loader conflicts with `import-in-the-middle` (the
 * mechanism OTel auto-instrumentations use to hook ESM imports). Manual
 * middleware is ~30 lines, gives full control, and carries zero loader risk.
 *
 * Linkage: the browser sends OTLP HTTP to the otelcol gateway (via nginx
 * `/traces`); the backend sends OTLP HTTP directly. Trace context propagates
 * frontend→backend because the browser's XHR instrumentation injects the W3C
 * `traceparent` header, which this module's middleware extracts and continues.
 */

const contextManager = new AsyncHooksContextManager();
contextManager.enable();

/** The configured OTLP exporter, or null when tracing is disabled. */
let provider: NodeTracerProvider | null = null;

const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'esa-dono-backend';
const SAMPLER_ARG = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG || '1.0');

function isEnabled(): boolean {
  // Disabled by default. Tracing only turns on when explicitly enabled
  // (OTEL_TRACES_ENABLED === 'true') AND an endpoint is configured — otherwise
  // spans would be emitted to nowhere useful.
  if (process.env.OTEL_TRACES_ENABLED !== 'true') return false;
  return Boolean(ENDPOINT);
}

function init(): void {
  if (!isEnabled()) return;
  if (provider) return;

  const exporter = new OTLPTraceExporter({
    url: ENDPOINT!.replace(/\/+$/, '') + '/v1/traces',
  });

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(SAMPLER_ARG),
  });

  provider = new NodeTracerProvider({
    sampler,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
}

/**
 * Get the tracer for the backend service. Initializes on first call.
 */
export function getTracer(): Tracer {
  init();
  return trace.getTracer(SERVICE_NAME);
}

export { SpanKind, SpanStatusCode };
export type { Attributes };

/** The global API — safe to call after `initTracing()` has run. */
export const tracingApi = trace;

/**
 * Express middleware that creates a root span for every HTTP request,
 * continuing any trace propagated from the browser via `traceparent`.
 *
 * The span is named after the matched route, not the raw path, so spans group
 * cleanly in VictoriaTraces. Mount this on every API router (or app-wide)
 * before route handlers.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!provider) return next();

  const activeContext = propagation.extract(context.active(), req.headers);
  const span = getTracer().startSpan(
    `HTTP ${req.method} ${req.path}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': req.method,
        'url.path': req.path,
        'user_agent.original': req.headers['user-agent'] || '',
      },
    },
    activeContext,
  );

  res.on('finish', () => {
    span.setAttribute('http.response.status_code', res.statusCode);
    span.setStatus(
      res.statusCode >= 500 ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK },
    );
    span.end();
  });

  context.with(trace.setSpan(activeContext, span), () => next());
}

/**
 * Attach the authenticated donor identity to the currently active span.
 * Call from `donorAuth` after the donor is resolved so every backend span of
 * an authenticated request carries `enduser.id` (used to group traces for a
 * single donor across the funnel).
 */
export function setDonorOnActiveSpan(donorId: string, donorEmail: string): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttributes({
    'enduser.id': donorId,
    'enduser.email': donorEmail,
  });
}

/**
 * Wrap an async function in a child span named `name`. The span is ended and
 * its status set (ERROR on throw) regardless of success/failure, and it is
 * propagated as the active context so nested spans become children.
 *
 * Returns the wrapped result (or re-throws the original error).
 */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const parent = context.active();
  const span = getTracer().startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      attributes: {},
    },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn());
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}
