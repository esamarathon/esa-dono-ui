import {
  context,
  trace,
  propagation,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ZoneContextManager } from '@opentelemetry/context-zone';

/**
 * Browser OpenTelemetry tracing — the "user journey" half of the observability
 * stack. Emits OTLP HTTP spans to the otelcol gateway (proxied same-origin via
 * nginx `/traces`), so the backend and frontend traces join into single
 * distributed traces (frontend XHR instrumentation injects `traceparent`).
 *
 * Custom spans (page views, tab visits, cart/checkout steps) are exported via
 * the `track*` helpers below so the donation funnel is queryable in Grafana.
 */

const ENDPOINT = import.meta.env.VITE_OTEL_ENDPOINT || '/traces';
const SERVICE_NAME = import.meta.env.VITE_OTEL_SERVICE_NAME || 'esa-dono-frontend';
const SAMPLER_ARG = parseFloat(import.meta.env.VITE_OTEL_SAMPLE_RATE || '1.0');

const SESSION_KEY = 'dono_session_id';

function getOrCreateSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return 'unsupported';
  }
}

let provider: WebTracerProvider | null = null;
// Persistent root span for the current page session. All journey spans and the
// XHR-injected backend spans become children of it, so one donor visit = one
// distributed trace (single trace_id, single session.id).
let sessionSpan: Span | null = null;
let sessionContext: Context | null = null;

function isEnabled(): boolean {
  // Disabled by default; only turns on when explicitly enabled.
  if (import.meta.env.VITE_OTEL_ENABLED !== 'true') return false;
  return Boolean(ENDPOINT);
}

function init(): void {
  if (!isEnabled() || provider) return;

  const exporter = new OTLPTraceExporter({
    url: `${window.location.origin}${ENDPOINT}`,
  });

  provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
    }),
    sampler: new TraceIdRatioBasedSampler(SAMPLER_ARG),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register({
    contextManager: new ZoneContextManager(),
    propagator: new W3CTraceContextPropagator(),
  });

  // Open the session root span and set it as the active context so every span
  // created from here on (manual tracks, XHR auto-instrumentation) nests under
  // it — and the W3C traceparent the XHR instrumentation injects belongs to
  // this same session trace.
  const root = trace.getTracer(SERVICE_NAME).startSpan('session', {
    attributes: { 'session.id': getOrCreateSessionId() },
  });
  sessionSpan = root;
  sessionContext = trace.setSpan(context.active(), root);

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new DocumentLoadInstrumentation(),
      // axios uses XHR in the browser. Propagate `traceparent` to our own
      // `/api` origin so the backend continues the same trace.
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: [/\/api\//],
      }),
      // Filtered click tracking: only record spans for elements explicitly
      // opted in via a `data-track` attribute, and for donation-flow pages.
      new UserInteractionInstrumentation({
        eventNames: ['click'],
        shouldPreventSpanCreation: (_event, element) => {
          const path = window.location.pathname;
          const inFlow =
            path.startsWith('/donate') || path.startsWith('/pledge') || path.startsWith('/wallet');
          return !(inFlow || element.hasAttribute('data-track'));
        },
      }),
    ],
  });
}

export function getTracer() {
  init();
  return trace.getTracer(SERVICE_NAME);
}

/** Run fn with the session root span as the active context. */
function withSession<T>(fn: () => T): T {
  if (!sessionContext) return fn();
  return context.with(sessionContext, () => fn());
}

/**
 * Record a named span (a user-journey step) with optional attributes as a child
 * of the current session. Attaches `session.id` so the funnel is queryable.
 */
export function track(name: string, attrs: Attributes = {}): void {
  if (!provider) return;
  withSession(() => {
    trace
      .getTracer(SERVICE_NAME)
      .startSpan(name, { attributes: { 'session.id': getOrCreateSessionId(), ...attrs } })
      .end();
  });
}

/**
 * Wrap an async operation (e.g. checkout) in a child span of the session,
 * ending it on completion with OK/ERROR status.
 */
export async function trackAsync<T>(
  name: string,
  fn: () => Promise<T>,
  attrs: Attributes = {},
): Promise<T> {
  if (!provider) return fn();
  return withSession(async () => {
    const span = trace
      .getTracer(SERVICE_NAME)
      .startSpan(name, { attributes: { 'session.id': getOrCreateSessionId(), ...attrs } });
    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => fn());
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Set the donor identity on the session root so its traces can be linked to a
 * specific donor after sign-in. */
export function identifyDonor(donorId: string, donorEmail: string): void {
  if (!sessionSpan) return;
  sessionSpan.setAttributes({ 'enduser.id': donorId, 'enduser.email': donorEmail });
}

export { trace, propagation };
