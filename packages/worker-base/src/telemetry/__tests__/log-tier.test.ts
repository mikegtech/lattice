import { describe, expect, it } from "vitest";
import {
	LOCAL_LOGGING_CONFIG,
	LogTier,
	type LoggingConfig,
	PRODUCTION_LOGGING_CONFIG,
	getTierPriority,
	shouldForwardLog,
} from "../log-tier.js";

describe("LogTier", () => {
	describe("shouldForwardLog", () => {
		const productionConfig = PRODUCTION_LOGGING_CONFIG;
		const localConfig = LOCAL_LOGGING_CONFIG;

		describe("CRITICAL tier", () => {
			it("should always forward CRITICAL logs in production", () => {
				const result = shouldForwardLog(LogTier.CRITICAL, productionConfig);
				expect(result.forward).toBe(true);
				expect(result.sampled).toBeUndefined();
			});

			it("should always forward CRITICAL logs locally", () => {
				const result = shouldForwardLog(LogTier.CRITICAL, localConfig);
				expect(result.forward).toBe(true);
			});

			it("should forward CRITICAL even if not in shipTiers", () => {
				const config: LoggingConfig = {
					level: "info",
					shipTiers: [], // Empty tiers
					sampleDebugRate: 0,
				};
				const result = shouldForwardLog(LogTier.CRITICAL, config);
				expect(result.forward).toBe(true);
			});
		});

		describe("OPERATIONAL tier", () => {
			it("should forward OPERATIONAL logs in production", () => {
				const result = shouldForwardLog(LogTier.OPERATIONAL, productionConfig);
				expect(result.forward).toBe(true);
			});

			it("should not forward OPERATIONAL if not in shipTiers", () => {
				const config: LoggingConfig = {
					level: "info",
					shipTiers: [LogTier.CRITICAL],
					sampleDebugRate: 0,
				};
				const result = shouldForwardLog(LogTier.OPERATIONAL, config);
				expect(result.forward).toBe(false);
			});
		});

		describe("LIFECYCLE tier", () => {
			it("should forward LIFECYCLE logs in production", () => {
				const result = shouldForwardLog(LogTier.LIFECYCLE, productionConfig);
				expect(result.forward).toBe(true);
			});

			it("should not forward LIFECYCLE if not in shipTiers", () => {
				const config: LoggingConfig = {
					level: "info",
					shipTiers: [LogTier.CRITICAL, LogTier.OPERATIONAL],
					sampleDebugRate: 0,
				};
				const result = shouldForwardLog(LogTier.LIFECYCLE, config);
				expect(result.forward).toBe(false);
			});
		});

		describe("DEBUG tier", () => {
			it("should not forward DEBUG logs in production by default", () => {
				const result = shouldForwardLog(LogTier.DEBUG, productionConfig);
				expect(result.forward).toBe(false);
			});

			it("should forward DEBUG logs locally", () => {
				const result = shouldForwardLog(LogTier.DEBUG, localConfig);
				expect(result.forward).toBe(true);
				expect(result.sampled).toBe(true);
			});

			it("should not forward DEBUG if sampleDebugRate is 0", () => {
				const config: LoggingConfig = {
					level: "debug",
					shipTiers: [LogTier.DEBUG],
					sampleDebugRate: 0,
				};
				const result = shouldForwardLog(LogTier.DEBUG, config);
				expect(result.forward).toBe(false);
			});

			it("should forward all DEBUG if sampleDebugRate is 1", () => {
				const config: LoggingConfig = {
					level: "debug",
					shipTiers: [LogTier.DEBUG],
					sampleDebugRate: 1,
				};
				const result = shouldForwardLog(LogTier.DEBUG, config);
				expect(result.forward).toBe(true);
				expect(result.sampled).toBe(true);
			});

			it("should deterministically sample based on trace_id", () => {
				const config: LoggingConfig = {
					level: "debug",
					shipTiers: [LogTier.DEBUG],
					sampleDebugRate: 0.5,
				};

				// Same trace_id should always produce same result
				const traceId = "abc123";
				const result1 = shouldForwardLog(LogTier.DEBUG, config, traceId);
				const result2 = shouldForwardLog(LogTier.DEBUG, config, traceId);
				expect(result1.forward).toBe(result2.forward);
			});
		});
	});

	describe("getTierPriority", () => {
		it("should return priorities in correct order", () => {
			expect(getTierPriority(LogTier.CRITICAL)).toBeLessThan(
				getTierPriority(LogTier.OPERATIONAL),
			);
			expect(getTierPriority(LogTier.OPERATIONAL)).toBeLessThan(
				getTierPriority(LogTier.LIFECYCLE),
			);
			expect(getTierPriority(LogTier.LIFECYCLE)).toBeLessThan(
				getTierPriority(LogTier.DEBUG),
			);
		});

		it("should return 0 for CRITICAL", () => {
			expect(getTierPriority(LogTier.CRITICAL)).toBe(0);
		});
	});

	describe("default configs", () => {
		it("PRODUCTION_LOGGING_CONFIG should not include DEBUG tier", () => {
			expect(PRODUCTION_LOGGING_CONFIG.shipTiers).not.toContain(LogTier.DEBUG);
			expect(PRODUCTION_LOGGING_CONFIG.sampleDebugRate).toBe(0);
		});

		it("PRODUCTION_LOGGING_CONFIG should include CRITICAL, OPERATIONAL, LIFECYCLE", () => {
			expect(PRODUCTION_LOGGING_CONFIG.shipTiers).toContain(LogTier.CRITICAL);
			expect(PRODUCTION_LOGGING_CONFIG.shipTiers).toContain(
				LogTier.OPERATIONAL,
			);
			expect(PRODUCTION_LOGGING_CONFIG.shipTiers).toContain(LogTier.LIFECYCLE);
		});

		it("LOCAL_LOGGING_CONFIG should include all tiers", () => {
			expect(LOCAL_LOGGING_CONFIG.shipTiers).toContain(LogTier.CRITICAL);
			expect(LOCAL_LOGGING_CONFIG.shipTiers).toContain(LogTier.OPERATIONAL);
			expect(LOCAL_LOGGING_CONFIG.shipTiers).toContain(LogTier.LIFECYCLE);
			expect(LOCAL_LOGGING_CONFIG.shipTiers).toContain(LogTier.DEBUG);
			expect(LOCAL_LOGGING_CONFIG.sampleDebugRate).toBe(1);
		});
	});
});
