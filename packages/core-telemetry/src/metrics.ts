import type { Tracer } from "dd-trace";
import { type MetricTags, filterMetricTags } from "./tags.js";
import { getNewRelicAgent, getTelemetryProvider } from "./tracer.js";

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
	tracer?: Tracer | null;
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
 * New Relic metrics implementation using recordMetric API
 */
class NewRelicMetrics implements Metrics {
	private prefix: string;
	private baseTags: MetricTags;
	private newrelic: ReturnType<typeof getNewRelicAgent>;

	constructor(options: MetricsOptions) {
		this.prefix = options.prefix;
		this.baseTags = options.baseTags;
		this.newrelic = getNewRelicAgent();
	}

	private formatName(name: string): string {
		// New Relic custom metrics must start with Custom/
		return `Custom/${this.prefix}/${name}`;
	}

	private addAttributes(tags?: Record<string, string>): void {
		if (!this.newrelic) return;

		const allTags = { ...this.baseTags, ...filterMetricTags(tags ?? {}) };
		for (const [key, value] of Object.entries(allTags)) {
			if (value !== undefined) {
				this.newrelic.addCustomAttribute(key, value);
			}
		}
	}

	increment(name: string, value = 1, tags?: Record<string, string>): void {
		if (this.newrelic) {
			this.addAttributes(tags);
			this.newrelic.incrementMetric(this.formatName(name), value);
		}
	}

	gauge(name: string, value: number, tags?: Record<string, string>): void {
		if (this.newrelic) {
			this.addAttributes(tags);
			this.newrelic.recordMetric(this.formatName(name), value);
		}
	}

	histogram(name: string, value: number, tags?: Record<string, string>): void {
		if (this.newrelic) {
			this.addAttributes(tags);
			// New Relic recordMetric handles histograms/distributions
			this.newrelic.recordMetric(this.formatName(name), {
				count: 1,
				total: value,
				min: value,
				max: value,
				sumOfSquares: value * value,
			});
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
		// New Relic handles flushing automatically
	}
}

/**
 * No-op metrics for when telemetry is not configured
 */
class NoopMetrics implements Metrics {
	increment(): void {}
	gauge(): void {}
	histogram(): void {}
	timing(): void {}
	async flush(): Promise<void> {}
}

export function createMetrics(options: MetricsOptions): Metrics {
	const provider = getTelemetryProvider();

	if (provider === "newrelic") {
		return new NewRelicMetrics(options);
	}

	if (provider === "datadog" && options.tracer) {
		return new DatadogMetrics(options);
	}

	return new NoopMetrics();
}
