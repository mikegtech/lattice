import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../config/config.module.js";
import { LogTier } from "../log-tier.js";
import { LoggerService } from "../logger.service.js";

const createMockConfig = (
	overrides: Partial<WorkerConfig> = {},
): WorkerConfig => ({
	service: "test-worker",
	version: "1.0.0",
	env: "production",
	team: "platform",
	cloud: "gcp",
	region: "us-east-1",
	domain: "mail",
	stage: "parse",
	kafka: {
		brokers: ["localhost:9092"],
		clientId: "test-client",
		groupId: "test-group",
		ssl: false,
		topicIn: "lattice.mail.raw.v1",
		topicOut: "lattice.mail.parse.v1",
		topicDlq: "lattice.dlq.mail.parse.v1",
		maxRetries: 3,
		retryBackoffMs: 1000,
	},
	logLevel: "info",
	healthPort: 3000,
	logging: {
		level: "info",
		shipTiers: [LogTier.CRITICAL, LogTier.OPERATIONAL, LogTier.LIFECYCLE],
		sampleDebugRate: 0,
	},
	...overrides,
});

describe("LoggerService Tiering", () => {
	let logger: LoggerService;
	let pinoInfoSpy: ReturnType<typeof vi.fn>;
	let pinoErrorSpy: ReturnType<typeof vi.fn>;
	let pinoDebugSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logger = new LoggerService(createMockConfig());
		// Access the private pino instance to spy on it
		const pinoInstance = (logger as unknown as { pino: unknown }).pino as {
			info: typeof pinoInfoSpy;
			error: typeof pinoErrorSpy;
			debug: typeof pinoDebugSpy;
		};
		pinoInfoSpy = vi.spyOn(pinoInstance, "info");
		pinoErrorSpy = vi.spyOn(pinoInstance, "error");
		pinoDebugSpy = vi.spyOn(pinoInstance, "debug");
	});

	describe("critical()", () => {
		it("should log with CRITICAL tier and dd.forward: true", () => {
			logger.critical("Critical error occurred", { email_id: "test-123" });

			expect(pinoErrorSpy).toHaveBeenCalledOnce();
			const [context] = pinoErrorSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.CRITICAL);
			expect(context["dd.forward"]).toBe(true);
		});
	});

	describe("operational()", () => {
		it("should log with OPERATIONAL tier and dd.forward: true", () => {
			logger.operational("Message processed", { duration_ms: 150 });

			expect(pinoInfoSpy).toHaveBeenCalledOnce();
			const [context] = pinoInfoSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.OPERATIONAL);
			expect(context["dd.forward"]).toBe(true);
		});
	});

	describe("lifecycle()", () => {
		it("should log with LIFECYCLE tier and dd.forward: true in production", () => {
			logger.lifecycle("Worker starting", { stage: "parse" });

			expect(pinoInfoSpy).toHaveBeenCalledOnce();
			const [context] = pinoInfoSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.LIFECYCLE);
			expect(context["dd.forward"]).toBe(true);
		});
	});

	describe("debugTiered()", () => {
		it("should log with DEBUG tier and dd.forward: false in production", () => {
			logger.debugTiered("Debug info", { trace_id: "abc123" });

			expect(pinoDebugSpy).toHaveBeenCalledOnce();
			const [context] = pinoDebugSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.DEBUG);
			expect(context["dd.forward"]).toBe(false);
		});

		it("should include dd.sampled when sampled", () => {
			// Create logger with sampling enabled
			const sampledConfig = createMockConfig({
				logging: {
					level: "debug",
					shipTiers: [LogTier.DEBUG],
					sampleDebugRate: 1, // 100% sampling
				},
			});
			const sampledLogger = new LoggerService(sampledConfig);
			const sampledPinoInstance = (
				sampledLogger as unknown as { pino: unknown }
			).pino as { debug: typeof pinoDebugSpy };
			const sampledDebugSpy = vi.spyOn(sampledPinoInstance, "debug");

			sampledLogger.debugTiered("Debug info", { trace_id: "abc123" });

			expect(sampledDebugSpy).toHaveBeenCalled();
			const [context] = sampledDebugSpy.mock.calls[0];
			expect(context["dd.forward"]).toBe(true);
			expect(context["dd.sampled"]).toBe(true);
		});
	});

	describe("tiered()", () => {
		it("should use error level for CRITICAL tier", () => {
			logger.tiered(LogTier.CRITICAL, "Critical message");
			expect(pinoErrorSpy).toHaveBeenCalledOnce();
		});

		it("should use info level for OPERATIONAL tier", () => {
			logger.tiered(LogTier.OPERATIONAL, "Operational message");
			expect(pinoInfoSpy).toHaveBeenCalledOnce();
		});

		it("should use info level for LIFECYCLE tier", () => {
			logger.tiered(LogTier.LIFECYCLE, "Lifecycle message");
			expect(pinoInfoSpy).toHaveBeenCalledOnce();
		});

		it("should use debug level for DEBUG tier", () => {
			logger.tiered(LogTier.DEBUG, "Debug message");
			expect(pinoDebugSpy).toHaveBeenCalledOnce();
		});
	});

	describe("default tier behavior", () => {
		it("should use OPERATIONAL tier for info() calls", () => {
			logger.info("Info message");

			expect(pinoInfoSpy).toHaveBeenCalledOnce();
			const [context] = pinoInfoSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.OPERATIONAL);
			expect(context["dd.forward"]).toBe(true);
		});

		it("should use DEBUG tier for debug() calls", () => {
			logger.debug("Debug message", { email_id: "test" });

			expect(pinoDebugSpy).toHaveBeenCalledOnce();
			const [context] = pinoDebugSpy.mock.calls[0];
			expect(context.tier).toBe(LogTier.DEBUG);
			expect(context["dd.forward"]).toBe(false);
		});
	});

	describe("context handling", () => {
		it("should preserve context fields", () => {
			logger.operational("Message", {
				email_id: "email-123",
				trace_id: "trace-456",
				duration_ms: 100,
			});

			const [context] = pinoInfoSpy.mock.calls[0];
			expect(context.email_id).toBe("email-123");
			expect(context.duration_ms).toBe(100);
			expect(context.dd.trace_id).toBe("trace-456");
		});

		it("should include base tags in all tiered logs", () => {
			logger.operational("Message");

			const [context] = pinoInfoSpy.mock.calls[0];
			expect(context.service).toBe("test-worker");
			expect(context.env).toBe("production");
			expect(context.team).toBe("platform");
		});
	});
});
