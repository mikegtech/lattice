import type { Tracer } from "dd-trace";
import { type MetricTags, filterMetricTags } from "./tags.js";

export interface Metrics {
	increment(name: string, value?: number, tags?: Record<string, string>): void;
	gauge(name: string, value: number, tags?: Record<string, string>): void;
	histogram(name: string, value: number, tags?: Record<string, string>): void;
	timing(name: string, durationMs: number, tags?: Record<string, string>): void;
	flush(): Promise<void>;
}

interface MetricsOptions {
	prefix: string;
	baseTags: MetricTags;
	tracer?: Tracer;
}

class DatadogMetrics implements Metrics {
	private prefix: string;
	private baseTags: MetricTags;
	private dogstatsd: {
		increment: (name: string, value: number, tags: string[]) => void;
		gauge: (name: string, value: number, tags: string[]) => void;
		histogram: (name: string, value: number, tags: string[]) => void;
		flush: () => Promise<void>;
	} | null = null;

	constructor(options: MetricsOptions) {
		this.prefix = options.prefix;
		this.baseTags = options.baseTags;

		// Try to get dogstatsd from tracer if available
		if (options.tracer) {
			// @ts-expect-error - dogstatsd is not in the public API
			this.dogstatsd = options.tracer.dogstatsd;
		}
	}

	private formatTags(extraTags?: Record<string, string>): string[] {
		const allTags = { ...this.baseTags, ...filterMetricTags(extraTags ?? {}) };
		return Object.entries(allTags)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `${k}:${v}`);
	}

	private formatName(name: string): string {
		return `${this.prefix}.${name}`;
	}

	increment(name: string, value = 1, tags?: Record<string, string>): void {
		if (this.dogstatsd) {
			this.dogstatsd.increment(
				this.formatName(name),
				value,
				this.formatTags(tags),
			);
		}
	}

	gauge(name: string, value: number, tags?: Record<string, string>): void {
		if (this.dogstatsd) {
			this.dogstatsd.gauge(this.formatName(name), value, this.formatTags(tags));
		}
	}

	histogram(name: string, value: number, tags?: Record<string, string>): void {
		if (this.dogstatsd) {
			this.dogstatsd.histogram(
				this.formatName(name),
				value,
				this.formatTags(tags),
			);
		}
	}

	timing(
		name: string,
		durationMs: number,
		tags?: Record<string, string>,
	): void {
		this.histogram(`${name}.duration_ms`, durationMs, tags);
	}

	async flush(): Promise<void> {
		if (this.dogstatsd) {
			await this.dogstatsd.flush();
		}
	}
}

/**
 * No-op metrics for when Datadog is not configured
 */
class NoopMetrics implements Metrics {
	increment(): void {}
	gauge(): void {}
	histogram(): void {}
	timing(): void {}
	async flush(): Promise<void> {}
}

export function createMetrics(options: MetricsOptions): Metrics {
	if (!options.tracer) {
		return new NoopMetrics();
	}
	return new DatadogMetrics(options);
}
