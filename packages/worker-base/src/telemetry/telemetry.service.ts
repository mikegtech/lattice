import { createRequire } from "module";
import { Injectable } from "@nestjs/common";
import type { Span, Tracer } from "dd-trace";
import type { WorkerConfig } from "../config/config.module.js";

const require = createRequire(import.meta.url);

@Injectable()
export class TelemetryService {
	private tracer: Tracer | null = null;
	private config: WorkerConfig | null = null;
	private baseTags: Record<string, string> = {};

	initialize(config: WorkerConfig): void {
		this.config = config;

		// Set base tags for all metrics
		this.baseTags = {
			env: config.env,
			service: config.service,
			version: config.version,
			team: config.team,
			cloud: config.cloud,
			region: config.region,
			domain: config.domain,
			stage: config.stage,
		};

		// Initialize dd-trace
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const ddTrace = require("dd-trace") as { default: Tracer };
			this.tracer = ddTrace.default.init({
				service: config.service,
				version: config.version,
				env: config.env,
				logInjection: true,
				runtimeMetrics: true,
			});
		} catch {
			// dd-trace may not be available in all environments
			console.warn("dd-trace not available, tracing disabled");
		}
	}

	getTracer(): Tracer | null {
		return this.tracer;
	}

	getCurrentSpan(): Span | undefined {
		return this.tracer?.scope().active() ?? undefined;
	}

	/**
	 * Get base tags for metrics (low cardinality only)
	 */
	getMetricTags(extra?: Record<string, string>): Record<string, string> {
		return { ...this.baseTags, ...extra };
	}

	/**
	 * Get tags for logs (can include high cardinality)
	 */
	getLogTags(
		extra?: Record<string, string | undefined>,
	): Record<string, string | undefined> {
		return { ...this.baseTags, ...extra };
	}

	/**
	 * Increment a counter metric
	 */
	increment(name: string, value = 1, tags?: Record<string, string>): void {
		const fullTags = this.getMetricTags(tags);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.tracer as any)?.dogstatsd?.increment(
			`lattice.${name}`,
			value,
			this.formatTags(fullTags),
		);
	}

	/**
	 * Record a gauge metric
	 */
	gauge(name: string, value: number, tags?: Record<string, string>): void {
		const fullTags = this.getMetricTags(tags);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.tracer as any)?.dogstatsd?.gauge(
			`lattice.${name}`,
			value,
			this.formatTags(fullTags),
		);
	}

	/**
	 * Record a histogram/timing metric
	 */
	timing(
		name: string,
		durationMs: number,
		tags?: Record<string, string>,
	): void {
		const fullTags = this.getMetricTags(tags);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.tracer as any)?.dogstatsd?.histogram(
			`lattice.${name}`,
			durationMs,
			this.formatTags(fullTags),
		);
	}

	/**
	 * Create a traced span
	 */
	async withSpan<T>(
		name: string,
		tags: Record<string, string>,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		if (!this.tracer) {
			// Stub span when tracer not available
			return fn({ setTag: () => {} } as unknown as Span);
		}

		return this.tracer.trace(name, { tags }, async (span: Span | undefined) => {
			if (!span) throw new Error("Span not created");
			try {
				return await fn(span);
			} catch (error) {
				span.setTag("error", true);
				if (error instanceof Error) {
					span.setTag("error.message", error.message);
				}
				throw error;
			}
		});
	}

	/**
	 * Extract trace context for Kafka header propagation
	 */
	getTraceContext(): { trace_id?: string; span_id?: string } {
		const span = this.getCurrentSpan();
		if (!span) return {};

		const context = span.context();
		return {
			trace_id: context.toTraceId(),
			span_id: context.toSpanId(),
		};
	}

	private formatTags(tags: Record<string, string>): string[] {
		return Object.entries(tags).map(([k, v]) => `${k}:${v}`);
	}
}
