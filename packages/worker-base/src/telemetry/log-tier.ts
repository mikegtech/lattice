/**
 * Log Tiering System for Datadog
 *
 * Controls which logs get shipped to Datadog based on importance:
 * - CRITICAL: Always ship (uncaught exceptions, DLQ, data issues)
 * - OPERATIONAL: Always ship (events, errors, significant state changes)
 * - LIFECYCLE: Ship only state changes, not verbose details
 * - DEBUG: Never ship to Datadog (local debugging only)
 */

/**
 * Log tier levels in order of importance
 */
export enum LogTier {
	CRITICAL = "critical",
	OPERATIONAL = "operational",
	LIFECYCLE = "lifecycle",
	DEBUG = "debug",
}

/**
 * Configuration for log shipping behavior
 */
export interface LoggingConfig {
	/** Base log level (debug, info, warn, error) */
	level: string;
	/** Which tiers to forward to Datadog */
	shipTiers: LogTier[];
	/** Percentage of debug logs to sample (0-1) */
	sampleDebugRate: number;
}

/**
 * Default logging config for production environments
 */
export const PRODUCTION_LOGGING_CONFIG: LoggingConfig = {
	level: "info",
	shipTiers: [LogTier.CRITICAL, LogTier.OPERATIONAL, LogTier.LIFECYCLE],
	sampleDebugRate: 0,
};

/**
 * Default logging config for local/dev environments
 */
export const LOCAL_LOGGING_CONFIG: LoggingConfig = {
	level: "debug",
	shipTiers: [
		LogTier.CRITICAL,
		LogTier.OPERATIONAL,
		LogTier.LIFECYCLE,
		LogTier.DEBUG,
	],
	sampleDebugRate: 1, // Ship all debug logs locally
};

/**
 * Determines if a log should be forwarded to Datadog based on tier configuration
 */
export function shouldForwardLog(
	tier: LogTier,
	config: LoggingConfig,
	traceId?: string,
): { forward: boolean; sampled?: boolean } {
	// Always forward CRITICAL logs
	if (tier === LogTier.CRITICAL) {
		return { forward: true };
	}

	// Check if tier is in shipTiers
	if (!config.shipTiers.includes(tier)) {
		return { forward: false };
	}

	// Special handling for DEBUG tier with sampling
	if (tier === LogTier.DEBUG) {
		if (config.sampleDebugRate <= 0) {
			return { forward: false };
		}

		if (config.sampleDebugRate >= 1) {
			// 100% sampling - forward all debug logs
			return { forward: true, sampled: true };
		}

		// Deterministic sampling based on trace_id if available
		const shouldSample = traceId
			? hashToRate(traceId) < config.sampleDebugRate
			: Math.random() < config.sampleDebugRate;

		return { forward: shouldSample, sampled: shouldSample };
	}

	return { forward: true };
}

/**
 * Deterministic hash of trace_id to a rate between 0-1
 * Ensures consistent sampling for the same trace across services
 */
function hashToRate(traceId: string): number {
	let hash = 0;
	for (let i = 0; i < traceId.length; i++) {
		const char = traceId.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	// Normalize to 0-1 range
	return Math.abs(hash) / 2147483647;
}

/**
 * Get tier priority (lower = higher priority)
 */
export function getTierPriority(tier: LogTier): number {
	switch (tier) {
		case LogTier.CRITICAL:
			return 0;
		case LogTier.OPERATIONAL:
			return 1;
		case LogTier.LIFECYCLE:
			return 2;
		case LogTier.DEBUG:
			return 3;
	}
}
