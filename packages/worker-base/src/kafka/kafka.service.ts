import {
	type Envelope,
	createEnvelope,
	validateEnvelope,
} from "@lattice/core-kafka";
import {
	Injectable,
	type OnModuleDestroy,
	type OnModuleInit,
} from "@nestjs/common";
import {
	type Consumer,
	type EachMessagePayload,
	Kafka,
	type Producer,
} from "kafkajs";
import { v4 as uuidv4 } from "uuid";
import type { WorkerConfig } from "../config/config.module.js";
import type { LifecycleService } from "../lifecycle/lifecycle.service.js";
import type { EventLogger } from "../telemetry/events.js";
import type { LoggerService } from "../telemetry/logger.service.js";
import type { TelemetryService } from "../telemetry/telemetry.service.js";
import type { WorkerContext } from "./types.js";

export interface KafkaMessage<T = unknown> {
	envelope: Envelope<T>;
	topic: string;
	partition: number;
	offset: string;
	timestamp: string;
	headers: Record<string, string | undefined>;
	traceId?: string;
	spanId?: string;
}

export type MessageHandler<T> = (
	message: KafkaMessage<T>,
) => Promise<ProcessResult>;

export type ProcessResult =
	| { status: "success" }
	| { status: "skip"; reason: string }
	| { status: "retry"; reason: string; delay?: number }
	| { status: "dlq"; reason: string; error: Error };

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
	private kafka: Kafka;
	private producer: Producer;
	private consumer: Consumer;
	private isConnected = false;
	private isRunning = false;
	private isShuttingDown = false;
	private inFlightCount = 0;
	private readonly expectedSchemaVersion?: string;

	constructor(
		private readonly config: WorkerConfig,
		private readonly options: { expectedSchemaVersion?: string },
		private readonly telemetry: TelemetryService,
		private readonly logger: LoggerService,
		private readonly eventLogger: EventLogger,
		private readonly lifecycle?: LifecycleService,
	) {
		if (options.expectedSchemaVersion) {
			this.expectedSchemaVersion = options.expectedSchemaVersion;
		}

		const kafkaConfig: import("kafkajs").KafkaConfig = {
			clientId: config.kafka.clientId,
			brokers: config.kafka.brokers,
			ssl: config.kafka.ssl,
			retry: {
				retries: config.kafka.maxRetries,
				initialRetryTime: config.kafka.retryBackoffMs,
			},
		};
		if (config.kafka.sasl) {
			const mechanism = config.kafka.sasl.mechanism;
			if (mechanism === "plain") {
				kafkaConfig.sasl = {
					mechanism: "plain" as const,
					username: config.kafka.sasl.username,
					password: config.kafka.sasl.password,
				};
			} else if (mechanism === "scram-sha-256") {
				kafkaConfig.sasl = {
					mechanism: "scram-sha-256" as const,
					username: config.kafka.sasl.username,
					password: config.kafka.sasl.password,
				};
			} else if (mechanism === "scram-sha-512") {
				kafkaConfig.sasl = {
					mechanism: "scram-sha-512" as const,
					username: config.kafka.sasl.username,
					password: config.kafka.sasl.password,
				};
			}
		}
		this.kafka = new Kafka(kafkaConfig);

		this.producer = this.kafka.producer({
			idempotent: true,
			maxInFlightRequests: 5,
		});

		this.consumer = this.kafka.consumer({
			groupId: config.kafka.groupId,
			sessionTimeout: 30000,
			heartbeatInterval: 3000,
		});
	}

	async onModuleInit(): Promise<void> {
		await this.connect();
	}

	async onModuleDestroy(): Promise<void> {
		await this.disconnect();
	}

	async connect(): Promise<void> {
		if (this.isConnected) return;

		await this.producer.connect();
		await this.consumer.connect();
		await this.consumer.subscribe({
			topic: this.config.kafka.topicIn,
			fromBeginning: false,
		});

		this.isConnected = true;
		this.eventLogger.kafkaConnected();
	}

	async disconnect(): Promise<void> {
		if (!this.isConnected) return;

		this.isShuttingDown = true;

		// Wait for in-flight messages to complete (max 30s)
		const deadline = Date.now() + 30000;
		while (this.inFlightCount > 0 && Date.now() < deadline) {
			await this.sleep(1000);
		}

		await this.consumer.disconnect();
		await this.producer.disconnect();
		this.isConnected = false;
		this.isRunning = false;

		this.eventLogger.kafkaDisconnected(
			this.config.kafka.brokers.join(","),
			this.inFlightCount > 0 ? "forced" : "graceful",
		);
	}

	/**
	 * Start consuming messages with the provided handler
	 */
	async run<T>(handler: MessageHandler<T>): Promise<void> {
		if (this.isRunning) {
			throw new Error("Consumer already running");
		}
		this.isRunning = true;
		this.telemetry.increment("worker.started");

		await this.consumer.run({
			eachMessage: async (payload: EachMessagePayload) => {
				this.inFlightCount++;
				this.lifecycle?.setInFlightCount(this.inFlightCount);
				try {
					await this.handleMessage(payload, handler);
				} finally {
					this.inFlightCount--;
					this.lifecycle?.setInFlightCount(this.inFlightCount);
				}
			},
		});
	}

	private async handleMessage<T>(
		payload: EachMessagePayload,
		handler: MessageHandler<T>,
	): Promise<void> {
		const { topic, partition, message } = payload;
		const startTime = Date.now();

		const headers = this.extractHeaders(
			message as { headers?: Record<string, Buffer | string | undefined> },
		);
		const traceId = headers["x-datadog-trace-id"];
		const spanId = headers["x-datadog-parent-id"];

		const logContext: Record<string, unknown> = {
			topic,
			partition,
			offset: message.offset,
		};
		if (traceId) logContext["trace_id"] = traceId;

		// Build worker context for DLQ events
		const workerContext: WorkerContext = {
			topic,
			partition,
			offset: message.offset,
		};
		if (traceId) workerContext.traceId = traceId;
		if (spanId) workerContext.spanId = spanId;

		try {
			const rawValue = message.value?.toString();
			if (!rawValue) {
				this.logger.warn("Empty message received, skipping", logContext);
				return;
			}

			const parsed = JSON.parse(rawValue);
			const envelope = validateEnvelope(parsed, this.expectedSchemaVersion);

			const kafkaMessage: KafkaMessage<T> = {
				envelope: envelope as Envelope<T>,
				topic,
				partition,
				offset: message.offset,
				timestamp: message.timestamp,
				headers,
			};
			if (traceId) kafkaMessage.traceId = traceId;
			if (spanId) kafkaMessage.spanId = spanId;

			this.telemetry.increment("messages.received");

			const result = await this.processWithRetries(kafkaMessage, handler);
			const duration = Date.now() - startTime;

			// Extract emailId from payload if available
			const emailId = this.extractEmailId(envelope.payload);

			switch (result.status) {
				case "success":
					this.telemetry.increment("messages.success");
					this.telemetry.timing("messages.duration_ms", duration);
					this.eventLogger.messageProcessed(envelope.message_id, duration, {
						emailId,
						outputTopic: this.config.kafka.topicOut,
					});
					break;

				case "skip":
					this.telemetry.increment("messages.skipped");
					this.eventLogger.messageSkipped(
						envelope.message_id,
						result.reason,
						emailId,
					);
					break;

				case "dlq":
					this.telemetry.increment("messages.dlq");
					await this.sendToDLQ(
						envelope,
						result.error,
						logContext,
						emailId,
						workerContext,
					);
					break;
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error");
			this.logger.error(
				"Failed to process message",
				err.stack,
				JSON.stringify(logContext),
			);
			await this.sendRawToDLQ(message, err, logContext, workerContext);
		}
	}

	private async processWithRetries<T>(
		message: KafkaMessage<T>,
		handler: MessageHandler<T>,
	): Promise<ProcessResult> {
		let lastError: Error | undefined;
		let retryCount = 0;
		const maxRetries = this.config.kafka.maxRetries;
		const messageId = message.envelope.message_id;
		const emailId = this.extractEmailId(message.envelope.payload);

		while (retryCount <= maxRetries) {
			try {
				const result = await handler(message);

				if (result.status === "retry") {
					if (retryCount >= maxRetries) {
						return {
							status: "dlq",
							reason: `Max retries exceeded: ${result.reason}`,
							error: lastError ?? new Error(result.reason),
						};
					}

					const delay =
						result.delay ??
						this.config.kafka.retryBackoffMs * Math.pow(2, retryCount);

					// Emit retry event
					this.eventLogger.messageRetry(
						messageId,
						retryCount + 1,
						maxRetries,
						result.reason,
						delay,
						emailId,
					);

					await this.sleep(delay);
					retryCount++;
					continue;
				}

				return result;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (retryCount < maxRetries && this.isRetryableError(lastError)) {
					const delay =
						this.config.kafka.retryBackoffMs * Math.pow(2, retryCount);

					// Emit retry event for error-based retry
					this.eventLogger.messageRetry(
						messageId,
						retryCount + 1,
						maxRetries,
						lastError.message,
						delay,
						emailId,
					);

					await this.sleep(delay);
					retryCount++;
					continue;
				}

				return {
					status: "dlq",
					reason: lastError.message,
					error: lastError,
				};
			}
		}

		return {
			status: "dlq",
			reason: "Max retries exceeded",
			error: lastError ?? new Error("Unknown error"),
		};
	}

	/**
	 * Produce a message to a topic
	 */
	async produce<T>(
		topic: string,
		payload: T,
		options: {
			tenantId: string;
			accountId: string;
			domain: "mail" | "calendar" | "drive" | "contacts";
			stage: string;
			schemaVersion: string;
		},
	): Promise<void> {
		const traceContext = this.telemetry.getTraceContext();

		const envelopeOptions: Parameters<typeof createEnvelope<T>>[0] = {
			tenant_id: options.tenantId,
			account_id: options.accountId,
			domain: options.domain,
			stage: options.stage as
				| "raw"
				| "parse"
				| "chunk"
				| "embed"
				| "upsert"
				| "delete"
				| "audit",
			schema_version: options.schemaVersion,
			source: {
				service: this.config.service,
				version: this.config.version,
			},
			payload,
			data_classification: "confidential",
			pii: { contains_pii: true },
		};
		if (traceContext.trace_id) envelopeOptions.trace_id = traceContext.trace_id;
		if (traceContext.span_id) envelopeOptions.span_id = traceContext.span_id;
		const envelope = createEnvelope(envelopeOptions);

		const headers: Record<string, string> = {
			"x-lattice-service": this.config.service,
			"x-lattice-version": this.config.version,
			"x-lattice-schema-version": options.schemaVersion,
			"x-lattice-message-id": envelope.message_id,
		};

		if (traceContext.trace_id) {
			headers["x-datadog-trace-id"] = traceContext.trace_id;
		}
		if (traceContext.span_id) {
			headers["x-datadog-parent-id"] = traceContext.span_id;
		}

		await this.producer.send({
			topic,
			messages: [
				{
					key: options.accountId,
					value: JSON.stringify(envelope),
					headers,
				},
			],
		});

		this.telemetry.increment("messages.produced", 1, { topic });
	}

	private async sendToDLQ(
		envelope: Envelope,
		error: Error,
		logContext: Record<string, unknown>,
		emailId?: string,
		context?: WorkerContext,
	): Promise<void> {
		const errorCode = "PROCESSING_FAILED";

		try {
			const dlqPayload: Record<string, unknown> = {
				dlq_id: uuidv4(),
				original_topic: this.config.kafka.topicIn,
				original_message: envelope,
				failure_stage: this.config.stage,
				error_classification: this.isRetryableError(error)
					? "retryable"
					: "non_retryable",
				error_code: errorCode,
				error_message: error.message,
				error_stack: error.stack,
				retry_count: this.config.kafka.maxRetries,
				processing_service: this.config.service,
				dlq_at: new Date().toISOString(),
			};

			// Add context fields if available
			if (context?.partition !== undefined) {
				dlqPayload["original_partition"] = context.partition;
			}
			if (context?.offset) {
				dlqPayload["original_offset"] = context.offset;
			}

			await this.producer.send({
				topic: this.config.kafka.topicDlq,
				messages: [
					{
						key: envelope.account_id,
						value: JSON.stringify({
							...createEnvelope({
								tenant_id: envelope.tenant_id,
								account_id: envelope.account_id,
								domain: envelope.domain,
								stage: "raw",
								schema_version: "v1",
								source: {
									service: this.config.service,
									version: this.config.version,
								},
								payload: dlqPayload,
								data_classification: "confidential",
								pii: { contains_pii: true },
							}),
						}),
					},
				],
			});

			// Emit DLQ event with context
			this.eventLogger.messageDLQ(
				envelope.message_id,
				"Processing failed after max retries",
				errorCode,
				error.message,
				emailId,
				context,
			);
		} catch (dlqError) {
			this.logger.error(
				"Failed to send to DLQ",
				dlqError instanceof Error ? dlqError.stack : String(dlqError),
				JSON.stringify(logContext),
			);
		}
	}

	private async sendRawToDLQ(
		message: { key?: Buffer | null; value: Buffer | null },
		error: Error,
		logContext: Record<string, unknown>,
		context?: WorkerContext,
	): Promise<void> {
		const dlqId = uuidv4();
		const errorCode = "PARSE_ERROR";

		// For malformed messages, send raw to DLQ
		try {
			const dlqPayload: Record<string, unknown> = {
				dlq_id: dlqId,
				original_topic: this.config.kafka.topicIn,
				original_message: {
					key: message.key?.toString(),
					value: message.value?.toString(),
				},
				failure_stage: this.config.stage,
				error_classification: "poison",
				error_code: errorCode,
				error_message: error.message,
				processing_service: this.config.service,
				dlq_at: new Date().toISOString(),
			};

			// Add context fields if available
			if (context?.partition !== undefined) {
				dlqPayload["original_partition"] = context.partition;
			}
			if (context?.offset) {
				dlqPayload["original_offset"] = context.offset;
			}

			await this.producer.send({
				topic: this.config.kafka.topicDlq,
				messages: [
					{
						value: JSON.stringify(dlqPayload),
					},
				],
			});

			// Emit DLQ event for poison message with context
			this.eventLogger.messageDLQ(
				dlqId, // Use dlqId as messageId since original is unparseable
				"Malformed message",
				errorCode,
				error.message,
				undefined,
				context,
			);
		} catch (dlqError) {
			this.logger.error(
				"Failed to send raw to DLQ",
				dlqError instanceof Error ? dlqError.stack : String(dlqError),
			);
		}
	}

	private extractHeaders(message: {
		headers?: Record<string, Buffer | string | undefined>;
	}): Record<string, string | undefined> {
		const headers: Record<string, string | undefined> = {};
		if (message.headers) {
			for (const [key, value] of Object.entries(message.headers)) {
				headers[key] = value?.toString();
			}
		}
		return headers;
	}

	private isRetryableError(error: Error): boolean {
		const message = error.message.toLowerCase();
		return (
			message.includes("econnrefused") ||
			message.includes("connection terminated") ||
			message.includes("timeout") ||
			message.includes("broker")
		);
	}

	/**
	 * Extract email_id from payload if available
	 * Handles various payload structures across different stages
	 */
	private extractEmailId(payload: unknown): string | undefined {
		if (!payload || typeof payload !== "object") {
			return undefined;
		}

		const p = payload as Record<string, unknown>;

		// Direct email_id field (common in parsed/chunk/embed stages)
		if (typeof p["email_id"] === "string") {
			return p["email_id"];
		}

		// Nested in email object (raw stage)
		if (p["email"] && typeof p["email"] === "object") {
			const email = p["email"] as Record<string, unknown>;
			if (typeof email["email_id"] === "string") {
				return email["email_id"];
			}
		}

		return undefined;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Check if the service is ready to process messages
	 */
	isReady(): boolean {
		return this.isConnected && this.isRunning && !this.isShuttingDown;
	}

	/**
	 * Check if the service is alive (connected)
	 */
	isAlive(): boolean {
		return this.isConnected;
	}
}
