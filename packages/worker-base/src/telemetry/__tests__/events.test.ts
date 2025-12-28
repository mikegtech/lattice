import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../config/config.module.js";
import { EventLogger } from "../events.js";
import { LogTier } from "../log-tier.js";
import type { LoggerService } from "../logger.service.js";

// Mock LoggerService
const createMockLogger = (): LoggerService =>
	({
		log: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		verbose: vi.fn(),
		child: vi.fn(),
		createEventLogger: vi.fn(),
	}) as unknown as LoggerService;

// Mock WorkerConfig
const createMockConfig = (
	overrides: Partial<WorkerConfig> = {},
): WorkerConfig => ({
	service: "test-worker",
	version: "1.0.0",
	env: "test",
	team: "platform",
	cloud: "local",
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

describe("EventLogger", () => {
	let mockLogger: LoggerService;
	let mockConfig: WorkerConfig;
	let eventLogger: EventLogger;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLogger = createMockLogger();
		mockConfig = createMockConfig();
		eventLogger = new EventLogger(mockLogger, mockConfig);
	});

	describe("Worker Lifecycle Events", () => {
		it("should emit workerStarted event with correct structure", () => {
			eventLogger.workerStarted();

			expect(mockLogger.info).toHaveBeenCalledOnce();
			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.worker.started");
			expect(context).toMatchObject({
				event: "lattice.worker.started",
				"dd.forward": true,
				service: "test-worker",
				version: "1.0.0",
				env: "test",
				config: {
					team: "platform",
					domain: "mail",
					stage: "parse",
					kafka_topic_in: "lattice.mail.raw.v1",
					kafka_topic_out: "lattice.mail.parse.v1",
					health_port: 3000,
				},
			});
			expect(context.timestamp).toBeDefined();
		});

		it("should emit workerShutdown event with correct structure", () => {
			eventLogger.workerShutdown(5000, 3, "graceful");

			expect(mockLogger.info).toHaveBeenCalledOnce();
			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.worker.shutdown");
			expect(context).toMatchObject({
				event: "lattice.worker.shutdown",
				"dd.forward": true,
				service: "test-worker",
				duration_ms: 5000,
				in_flight_count: 3,
				reason: "graceful",
			});
		});
	});

	describe("Message Processing Events", () => {
		it("should emit messageProcessed event with required fields", () => {
			eventLogger.messageProcessed("msg-123", 150);

			expect(mockLogger.info).toHaveBeenCalledOnce();
			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.message.processed");
			expect(context).toMatchObject({
				event: "lattice.message.processed",
				"dd.forward": true,
				message_id: "msg-123",
				stage: "parse",
				duration_ms: 150,
			});
		});

		it("should emit messageProcessed event with optional fields", () => {
			eventLogger.messageProcessed("msg-123", 150, {
				emailId: "email-456",
				outputTopic: "lattice.mail.parse.v1",
			});

			const [, context] = (mockLogger.info as ReturnType<typeof vi.fn>).mock
				.calls[0];

			expect(context.email_id).toBe("email-456");
			expect(context.output_topic).toBe("lattice.mail.parse.v1");
		});

		it("should emit messageSkipped event", () => {
			eventLogger.messageSkipped("msg-123", "duplicate", "email-456");

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.message.skipped");
			expect(context).toMatchObject({
				event: "lattice.message.skipped",
				"dd.forward": true,
				message_id: "msg-123",
				reason: "duplicate",
				email_id: "email-456",
			});
		});

		it("should emit messageRetry event", () => {
			eventLogger.messageRetry("msg-123", 2, 3, "timeout", 2000, "email-456");

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.message.retry");
			expect(context).toMatchObject({
				event: "lattice.message.retry",
				"dd.forward": true,
				message_id: "msg-123",
				attempt: 2,
				max_attempts: 3,
				reason: "timeout",
				backoff_ms: 2000,
				email_id: "email-456",
			});
		});

		it("should emit messageDLQ event", () => {
			eventLogger.messageDLQ(
				"msg-123",
				"parsing failed",
				"PARSE_ERROR",
				"Invalid MIME structure",
				"email-456",
			);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.message.dlq");
			expect(context).toMatchObject({
				event: "lattice.message.dlq",
				"dd.forward": true,
				message_id: "msg-123",
				reason: "parsing failed",
				error_code: "PARSE_ERROR",
				error_message: "Invalid MIME structure",
				dlq_topic: "lattice.dlq.mail.parse.v1",
				email_id: "email-456",
			});
		});

		it("should emit messageDLQ event with Kafka context", () => {
			eventLogger.messageDLQ(
				"msg-123",
				"processing failed",
				"PROCESSING_FAILED",
				"Database timeout",
				"email-456",
				{
					topic: "lattice.mail.raw.v1",
					partition: 2,
					offset: "12345",
					traceId: "trace-abc",
					spanId: "span-def",
				},
			);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.message.dlq");
			expect(context).toMatchObject({
				event: "lattice.message.dlq",
				"dd.forward": true,
				message_id: "msg-123",
				reason: "processing failed",
				error_code: "PROCESSING_FAILED",
				error_message: "Database timeout",
				dlq_topic: "lattice.dlq.mail.parse.v1",
				email_id: "email-456",
				input_topic: "lattice.mail.raw.v1",
				kafka_partition: 2,
				kafka_offset: "12345",
			});
		});

		it("should emit messageDLQ event without context fields when not provided", () => {
			eventLogger.messageDLQ(
				"msg-123",
				"parsing failed",
				"PARSE_ERROR",
				"Invalid MIME structure",
			);

			const [, context] = (mockLogger.info as ReturnType<typeof vi.fn>).mock
				.calls[0];

			expect(context.input_topic).toBeUndefined();
			expect(context.kafka_partition).toBeUndefined();
			expect(context.kafka_offset).toBeUndefined();
		});
	});

	describe("Kafka Events", () => {
		it("should emit kafkaConnected event", () => {
			eventLogger.kafkaConnected("localhost:9092");

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.kafka.connected");
			expect(context).toMatchObject({
				event: "lattice.kafka.connected",
				"dd.forward": true,
				broker: "localhost:9092",
				client_id: "test-client",
				group_id: "test-group",
			});
		});

		it("should emit kafkaDisconnected event", () => {
			eventLogger.kafkaDisconnected("localhost:9092", "connection timeout");

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.kafka.disconnected");
			expect(context).toMatchObject({
				event: "lattice.kafka.disconnected",
				"dd.forward": true,
				broker: "localhost:9092",
				reason: "connection timeout",
			});
		});

		it("should emit kafkaError event with optional fields", () => {
			eventLogger.kafkaError(
				"localhost:9092",
				"TOPIC_AUTH_FAILED",
				"Not authorized",
				{ topic: "lattice.mail.raw.v1", partition: 0 },
			);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.kafka.error");
			expect(context).toMatchObject({
				event: "lattice.kafka.error",
				"dd.forward": true,
				error_code: "TOPIC_AUTH_FAILED",
				error_message: "Not authorized",
				topic: "lattice.mail.raw.v1",
				partition: 0,
			});
		});

		it("should emit kafkaRebalance event", () => {
			eventLogger.kafkaRebalance("assign", "lattice.mail.raw.v1", [0, 1, 2]);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.kafka.rebalance");
			expect(context).toMatchObject({
				event: "lattice.kafka.rebalance",
				"dd.forward": true,
				action: "assign",
				topic: "lattice.mail.raw.v1",
				partitions: [0, 1, 2],
			});
		});
	});

	describe("Database Events", () => {
		it("should emit databaseError event", () => {
			eventLogger.databaseError(
				"postgres",
				"INSERT",
				"23505",
				"Duplicate key violation",
				150,
			);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.database.error");
			expect(context).toMatchObject({
				event: "lattice.database.error",
				"dd.forward": true,
				database: "postgres",
				operation: "INSERT",
				error_code: "23505",
				error_message: "Duplicate key violation",
				query_duration_ms: 150,
			});
		});

		it("should emit databaseSlowQuery event", () => {
			eventLogger.databaseSlowQuery("postgres", "SELECT", 5000, 1000);

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.database.slow_query");
			expect(context).toMatchObject({
				event: "lattice.database.slow_query",
				"dd.forward": true,
				database: "postgres",
				operation: "SELECT",
				duration_ms: 5000,
				threshold_ms: 1000,
			});
		});
	});

	describe("Health Events", () => {
		it("should emit healthChanged event", () => {
			eventLogger.healthChanged("healthy", "unhealthy", "database timeout", {
				kafka: true,
				database: false,
			});

			const [message, context] = (mockLogger.info as ReturnType<typeof vi.fn>)
				.mock.calls[0];

			expect(message).toBe("lattice.health.changed");
			expect(context).toMatchObject({
				event: "lattice.health.changed",
				"dd.forward": true,
				service: "test-worker",
				previous_status: "healthy",
				current_status: "unhealthy",
				reason: "database timeout",
				checks: {
					kafka: true,
					database: false,
				},
			});
		});
	});

	describe("Event Structure", () => {
		it("should always include dd.forward: true", () => {
			eventLogger.workerStarted();
			eventLogger.messageProcessed("msg-1", 100);
			eventLogger.kafkaConnected("broker");
			eventLogger.databaseSlowQuery("db", "op", 1000, 500);
			eventLogger.healthChanged("unknown", "healthy", "startup", {});

			const calls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls).toHaveLength(5);

			for (const [, context] of calls) {
				expect(context["dd.forward"]).toBe(true);
			}
		});

		it("should always include timestamp in ISO 8601 format", () => {
			eventLogger.messageProcessed("msg-1", 100);

			const [, context] = (mockLogger.info as ReturnType<typeof vi.fn>).mock
				.calls[0];

			expect(context.timestamp).toBeDefined();
			expect(() => new Date(context.timestamp as string)).not.toThrow();
			expect(context.timestamp).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
			);
		});

		it("should include base service tags in all events", () => {
			eventLogger.messageProcessed("msg-1", 100);

			const [, context] = (mockLogger.info as ReturnType<typeof vi.fn>).mock
				.calls[0];

			expect(context.service).toBe("test-worker");
			expect(context.version).toBe("1.0.0");
			expect(context.env).toBe("test");
			expect(context.team).toBe("platform");
			expect(context.cloud).toBe("local");
			expect(context.region).toBe("us-east-1");
			expect(context.domain).toBe("mail");
			expect(context.stage).toBe("parse");
		});
	});
});
