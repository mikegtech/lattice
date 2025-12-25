import type { ServiceIdentity } from "@lattice/core-config";

/**
 * Required tags for all telemetry (metrics, logs, traces)
 * These MUST be present on every emission
 */
export const REQUIRED_TAGS = ["env", "service", "version"] as const;

/**
 * Optional but recommended tags for context
 */
export const OPTIONAL_TAGS = [
	"team",
	"cloud",
	"region",
	"domain",
	"pipeline",
	"stage",
] as const;

/**
 * Approved additional dimensions for metrics (low-cardinality)
 * These are acceptable in addition to required/optional tags
 */
export const APPROVED_METRIC_DIMENSIONS = [
	"error_code",
	"reason",
	"status",
	"operation",
	"topic",
] as const;

/**
 * High-cardinality tags that should NEVER be used as metric tags
 * These are acceptable in logs and trace attributes only
 */
export const HIGH_CARDINALITY_TAGS = [
	"account_id",
	"tenant_id",
	"email_id",
	"provider_message_id",
	"chunk_id",
	"trace_id",
	"span_id",
	"message_id",
	"user_id",
] as const;

export type RequiredTag = (typeof REQUIRED_TAGS)[number];
export type OptionalTag = (typeof OPTIONAL_TAGS)[number];
export type ApprovedMetricDimension =
	(typeof APPROVED_METRIC_DIMENSIONS)[number];
export type HighCardinalityTag = (typeof HIGH_CARDINALITY_TAGS)[number];

/**
 * All allowed keys for metric tags
 */
export const ALLOWED_METRIC_KEYS = [
	...REQUIRED_TAGS,
	...OPTIONAL_TAGS,
	...APPROVED_METRIC_DIMENSIONS,
] as const;

export type AllowedMetricKey = (typeof ALLOWED_METRIC_KEYS)[number];

export interface ServiceTags {
	env: string;
	service: string;
	version: string;
	team?: string;
	cloud?: string;
	region?: string;
	domain?: string;
	pipeline?: string;
	stage?: string;
}

export interface MetricTags extends ServiceTags {
	// Metric tags must NOT include high-cardinality fields
	// This type enforces that at compile time
	// Approved dimensions for metrics
	error_code?: string;
	reason?: string;
	status?: string;
	operation?: string;
	topic?: string;
}

export interface LogTags extends ServiceTags {
	// Log tags CAN include high-cardinality fields
	account_id?: string;
	tenant_id?: string;
	email_id?: string;
	provider_message_id?: string;
	chunk_id?: string;
	trace_id?: string;
	span_id?: string;
	message_id?: string;
	// Also allow metric dimensions
	error_code?: string;
	reason?: string;
	status?: string;
	operation?: string;
}

export interface TraceTags extends LogTags {
	// Trace span attributes can include high-cardinality fields
	// Same as LogTags, included for clarity
}

/**
 * Sanitize a tag value for Datadog
 * - Lowercase
 * - Replace spaces/special chars with underscores
 * - Truncate to 200 chars
 */
export function sanitizeTagValue(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_\-./]/g, "_")
		.replace(/_+/g, "_")
		.slice(0, 200);
}

/**
 * Validate that required tags are present
 */
export function validateTags(
	tags: Record<string, string | undefined>,
	context: string,
): void {
	const missing = REQUIRED_TAGS.filter((tag) => !tags[tag]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required tags in ${context}: ${missing.join(", ")}`,
		);
	}
}

/**
 * Check if a tag is high-cardinality (should not be used for metrics)
 */
export function isHighCardinality(tagName: string): boolean {
	return HIGH_CARDINALITY_TAGS.includes(tagName as HighCardinalityTag);
}

/**
 * Check if a tag key is allowed for metrics
 */
export function isAllowedMetricKey(tagName: string): boolean {
	return ALLOWED_METRIC_KEYS.includes(tagName as AllowedMetricKey);
}

/**
 * Error thrown when high-cardinality tags are used in metrics
 */
export class HighCardinalityMetricError extends Error {
	constructor(
		public readonly forbiddenKeys: string[],
		context?: string,
	) {
		super(
			`High-cardinality tags not allowed in metrics${context ? ` (${context})` : ""}: ${forbiddenKeys.join(", ")}. ` +
				"These tags cause metric cardinality explosion. Use forLog() or forTrace() instead.",
		);
		this.name = "HighCardinalityMetricError";
	}
}

/**
 * Validate that metric tags do not contain high-cardinality keys.
 * Throws HighCardinalityMetricError if forbidden keys are found.
 */
export function validateMetricTags(
	tags: Record<string, string | undefined>,
	context?: string,
): void {
	const forbiddenKeys = Object.keys(tags).filter((key) =>
		isHighCardinality(key),
	);
	if (forbiddenKeys.length > 0) {
		throw new HighCardinalityMetricError(forbiddenKeys, context);
	}
}

/**
 * Filter out high-cardinality tags for metric emissions
 * @deprecated Use validateMetricTags instead to enforce compliance
 */
export function filterMetricTags(
	tags: Record<string, string | undefined>,
): MetricTags {
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(tags)) {
		if (value !== undefined && !isHighCardinality(key)) {
			filtered[key] = value;
		}
	}
	return filtered as unknown as MetricTags;
}

/**
 * Create a tag builder from service identity
 */
export function createTagBuilder(identity: ServiceIdentity) {
	const baseTags: ServiceTags = {
		env: identity.name.includes("prod") ? "prod" : "dev",
		service: identity.name,
		version: identity.version,
		team: identity.team,
		cloud: identity.cloud,
		region: identity.region,
		domain: identity.domain,
		pipeline: identity.pipeline,
	};

	return {
		/**
		 * Get base service tags (safe for metrics)
		 */
		getServiceTags(): ServiceTags {
			return { ...baseTags };
		},

		/**
		 * Build tags for metrics (no high-cardinality).
		 * THROWS if high-cardinality tags are passed.
		 * Only accepts: required tags, optional tags, and approved metric dimensions
		 * (error_code, reason, status, operation, topic).
		 */
		forMetric(extra?: Partial<MetricTags>): MetricTags {
			const tags = { ...baseTags, ...extra };
			// Validate that no high-cardinality tags are present
			validateMetricTags(tags, `forMetric(${identity.name})`);
			// Filter undefined values
			const filtered: Record<string, string> = {};
			for (const [key, value] of Object.entries(tags)) {
				if (value !== undefined) {
					filtered[key] = value;
				}
			}
			return filtered as unknown as MetricTags;
		},

		/**
		 * Build tags for logs (can include high-cardinality)
		 */
		forLog(extra?: Record<string, string | undefined>): LogTags {
			return { ...baseTags, ...extra } as LogTags;
		},

		/**
		 * Build tags for trace span attributes (can include high-cardinality)
		 */
		forTrace(extra?: Record<string, string | undefined>): TraceTags {
			return { ...baseTags, ...extra } as TraceTags;
		},

		/**
		 * Build tags for a specific pipeline stage
		 */
		forStage(
			stage: string,
			extra?: Record<string, string | undefined>,
		): LogTags {
			return { ...baseTags, stage, ...extra } as LogTags;
		},
	};
}
