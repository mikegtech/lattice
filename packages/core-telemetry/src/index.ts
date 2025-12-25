export { createLogger, type Logger, type LogContext } from "./logger.js";
export {
	initTracer,
	getTracer,
	withSpan,
	getCurrentSpan,
	injectTraceContext,
	extractTraceContext,
	type TracerOptions,
} from "./tracer.js";
export {
	createTagBuilder,
	REQUIRED_TAGS,
	OPTIONAL_TAGS,
	APPROVED_METRIC_DIMENSIONS,
	ALLOWED_METRIC_KEYS,
	HIGH_CARDINALITY_TAGS,
	validateTags,
	validateMetricTags,
	sanitizeTagValue,
	isHighCardinality,
	isAllowedMetricKey,
	HighCardinalityMetricError,
	type ServiceTags,
	type MetricTags,
	type LogTags,
	type TraceTags,
} from "./tags.js";
export { createMetrics, type Metrics } from "./metrics.js";
