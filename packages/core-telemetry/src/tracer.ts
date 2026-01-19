import type { Span, Tracer } from "dd-trace";

/**
 * Telemetry provider type - controls which APM backend is used
 */
export type TelemetryProvider = "datadog" | "newrelic" | "none";

/**
 * New Relic agent type (loosely typed to avoid requiring @types/newrelic)
 */
type NewRelicAgent = {
	startBackgroundTransaction: (
		name: string,
		fn: () => void | Promise<void>,
	) => void;
	getTransaction: () => { end: () => void };
	addCustomAttribute: (key: string, value: string | number | boolean) => void;
	noticeError: (error: Error) => void;
	recordMetric: (
		name: string,
		value:
			| number
			| {
					count: number;
					total: number;
					min: number;
					max: number;
					sumOfSquares: number;
			  },
	) => void;
	incrementMetric: (name: string, value?: number) => void;
	distributedTraceHeaders: (headers: Record<string, unknown>) => void;
};

/**
 * Get the current telemetry provider from environment
 */
export function getTelemetryProvider(): TelemetryProvider {
	const provider = process.env["TELEMETRY_PROVIDER"]?.toLowerCase();
	if (provider === "newrelic") return "newrelic";
	if (provider === "none" || provider === "disabled") return "none";
	return "datadog"; // Default for backwards compatibility
}

let tracerInstance: Tracer | null = null;
let newrelicInstance: NewRelicAgent | null = null;

export interface TracerOptions {
	service: string;
	version: string;
	env: string;
	enabled?: boolean;
	logInjection?: boolean;
	runtimeMetrics?: boolean;
}

export function initTracer(options: TracerOptions): Tracer | null {
	const provider = getTelemetryProvider();

	if (provider === "none") {
		return null;
	}

	if (provider === "newrelic") {
		// New Relic is initialized via -r newrelic preload, just get the instance
		if (!newrelicInstance) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				newrelicInstance = require("newrelic");
			} catch {
				console.warn("New Relic agent not available, tracing disabled");
			}
		}
		return null; // New Relic doesn't expose a Tracer-compatible interface
	}

	// Datadog path (default)
	if (tracerInstance) {
		return tracerInstance;
	}

	// Dynamic import to avoid issues when dd-trace isn't needed
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const tracer = require("dd-trace") as { default: Tracer };

	tracerInstance = tracer.default.init({
		service: options.service,
		version: options.version,
		env: options.env,
		logInjection: options.logInjection ?? true,
		runtimeMetrics: options.runtimeMetrics ?? true,
	} as Parameters<typeof tracer.default.init>[0]);

	return tracerInstance;
}

export function getTracer(): Tracer | null {
	const provider = getTelemetryProvider();
	if (provider !== "datadog") {
		return null;
	}
	if (!tracerInstance) {
		throw new Error("Tracer not initialized. Call initTracer() first.");
	}
	return tracerInstance;
}

export function getNewRelicAgent(): NewRelicAgent | null {
	return newrelicInstance;
}

export function getCurrentSpan(): Span | undefined {
	const provider = getTelemetryProvider();
	if (provider !== "datadog" || !tracerInstance) {
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
	fn: (span: Span | null) => Promise<T>,
): Promise<T> {
	const provider = getTelemetryProvider();

	if (provider === "newrelic" && newrelicInstance) {
		// Use New Relic's startBackgroundTransaction for async work
		return new Promise((resolve, reject) => {
			newrelicInstance!.startBackgroundTransaction(operationName, async () => {
				const transaction = newrelicInstance!.getTransaction();
				try {
					// Add custom attributes from tags
					if (options.tags) {
						for (const [key, value] of Object.entries(options.tags)) {
							newrelicInstance!.addCustomAttribute(key, value);
						}
					}
					if (options.resource) {
						newrelicInstance!.addCustomAttribute("resource", options.resource);
					}
					const result = await fn(null);
					resolve(result);
				} catch (error) {
					newrelicInstance!.noticeError(error as Error);
					reject(error);
				} finally {
					transaction.end();
				}
			});
		});
	}

	if (provider === "datadog") {
		const tracer = getTracer();
		if (!tracer) {
			return fn(null);
		}

		// Build trace options only with defined values to satisfy exactOptionalPropertyTypes
		const traceOpts: Record<string, unknown> = {};
		if (options.resource !== undefined)
			traceOpts["resource"] = options.resource;
		if (options.type !== undefined) traceOpts["type"] = options.type;
		if (options.tags !== undefined) traceOpts["tags"] = options.tags;

		return tracer.trace(operationName, traceOpts, async (span) => {
			if (!span) {
				throw new Error("Span not created");
			}
			try {
				return await fn(span);
			} catch (error) {
				span.setTag("error", true);
				if (error instanceof Error) {
					span.setTag("error.message", error.message);
					span.setTag("error.stack", error.stack ?? "");
				}
				throw error;
			}
		});
	}

	// No tracing enabled
	return fn(null);
}

/**
 * W3C Trace Context header names
 */
const W3C_TRACEPARENT = "traceparent";
const W3C_TRACESTATE = "tracestate";

/**
 * Datadog-specific header names (for backwards compatibility)
 */
const DD_TRACE_ID = "x-datadog-trace-id";
const DD_PARENT_ID = "x-datadog-parent-id";

/**
 * Extract trace context for propagation to Kafka headers
 * Uses W3C trace context format for New Relic, Datadog format for dd-trace
 */
export function injectTraceContext(): {
	trace_id?: string;
	span_id?: string;
	traceparent?: string;
	tracestate?: string;
} {
	const provider = getTelemetryProvider();

	if (provider === "newrelic" && newrelicInstance) {
		// New Relic uses W3C trace context - get from transaction
		const transaction = newrelicInstance.getTransaction();
		if (transaction) {
			// New Relic automatically handles W3C headers via insertDistributedTraceHeaders
			const headers: Record<string, string> = {};
			newrelicInstance.distributedTraceHeaders(
				headers as unknown as Parameters<
					typeof newrelicInstance.distributedTraceHeaders
				>[0],
			);
			return {
				traceparent: headers[W3C_TRACEPARENT],
				tracestate: headers[W3C_TRACESTATE],
				trace_id: headers[W3C_TRACEPARENT]?.split("-")[1],
				span_id: headers[W3C_TRACEPARENT]?.split("-")[2],
			};
		}
		return {};
	}

	if (provider === "datadog") {
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

	return {};
}

/**
 * Extract trace context from Kafka headers
 * Supports both W3C trace context (New Relic) and Datadog formats
 */
export function extractTraceContext(
	headers: Record<string, string | Buffer | undefined>,
): {
	trace_id?: string;
	span_id?: string;
	traceparent?: string;
	tracestate?: string;
} {
	const result: {
		trace_id?: string;
		span_id?: string;
		traceparent?: string;
		tracestate?: string;
	} = {};

	// Check for W3C trace context first (New Relic format)
	const traceparent = headers[W3C_TRACEPARENT];
	const tracestate = headers[W3C_TRACESTATE];

	if (traceparent) {
		result.traceparent = String(traceparent);
		if (tracestate) {
			result.tracestate = String(tracestate);
		}
		// Parse W3C traceparent: version-trace_id-parent_id-flags
		const parts = result.traceparent.split("-");
		if (parts.length >= 3) {
			result.trace_id = parts[1];
			result.span_id = parts[2];
		}
		return result;
	}

	// Fall back to Datadog format
	const traceId = headers[DD_TRACE_ID];
	const spanId = headers[DD_PARENT_ID];

	if (traceId) result.trace_id = String(traceId);
	if (spanId) result.span_id = String(spanId);

	return result;
}

/**
 * Accept distributed trace headers from incoming request/message
 * Call this when receiving a Kafka message to continue the trace
 */
export function acceptTraceContext(
	headers: Record<string, string | Buffer | undefined>,
): void {
	const provider = getTelemetryProvider();

	if (provider === "newrelic" && newrelicInstance) {
		// Convert headers to string format for New Relic
		const stringHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) {
				stringHeaders[key] = String(value);
			}
		}
		// New Relic will automatically pick up W3C headers
		// No explicit API call needed when using -r newrelic preload
	}

	// Datadog handles trace context automatically via dd-trace instrumentation
}
