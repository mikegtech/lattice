import type { Tracer, Span } from 'dd-trace';

let tracerInstance: Tracer | null = null;

export interface TracerOptions {
  service: string;
  version: string;
  env: string;
  enabled?: boolean;
  logInjection?: boolean;
  runtimeMetrics?: boolean;
}

export function initTracer(options: TracerOptions): Tracer {
  if (tracerInstance) {
    return tracerInstance;
  }

  // Dynamic import to avoid issues when dd-trace isn't needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tracer = require('dd-trace') as { default: Tracer };

  tracerInstance = tracer.default.init({
    service: options.service,
    version: options.version,
    env: options.env,
    logInjection: options.logInjection ?? true,
    runtimeMetrics: options.runtimeMetrics ?? true,
    enabled: options.enabled ?? true,
  });

  return tracerInstance;
}

export function getTracer(): Tracer {
  if (!tracerInstance) {
    throw new Error('Tracer not initialized. Call initTracer() first.');
  }
  return tracerInstance;
}

export function getCurrentSpan(): Span | undefined {
  if (!tracerInstance) {
    return undefined;
  }
  return tracerInstance.scope().active() ?? undefined;
}

export interface SpanOptions {
  resource?: string;
  type?: string;
  tags?: Record<string, string>;
}

export async function withSpan<T>(
  operationName: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();

  return tracer.trace(operationName, {
    resource: options.resource,
    type: options.type,
    tags: options.tags,
  }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.setTag('error', true);
      if (error instanceof Error) {
        span.setTag('error.message', error.message);
        span.setTag('error.stack', error.stack ?? '');
      }
      throw error;
    }
  });
}

/**
 * Extract trace context for propagation to Kafka headers
 */
export function injectTraceContext(): { trace_id?: string; span_id?: string } {
  const span = getCurrentSpan();
  if (!span) {
    return {};
  }

  const context = span.context();
  return {
    trace_id: context.toTraceId(),
    span_id: context.toSpanId(),
  };
}

/**
 * Extract trace context from Kafka headers
 */
export function extractTraceContext(headers: Record<string, string | Buffer | undefined>): {
  trace_id?: string;
  span_id?: string;
} {
  const traceId = headers['x-datadog-trace-id'];
  const spanId = headers['x-datadog-parent-id'];

  return {
    trace_id: traceId ? String(traceId) : undefined,
    span_id: spanId ? String(spanId) : undefined,
  };
}
