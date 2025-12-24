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
	HIGH_CARDINALITY_TAGS,
	validateTags,
	sanitizeTagValue,
	type ServiceTags,
	type MetricTags,
} from "./tags.js";
export { createMetrics, type Metrics } from "./metrics.js";
