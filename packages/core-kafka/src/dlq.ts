import type { Logger } from "@lattice/core-telemetry";
import { v4 as uuidv4 } from "uuid";
import { type EnvelopeSource, createEnvelope } from "./envelope.js";
import type { LatticeProducer } from "./producer.js";
import { TOPICS, getDLQTopic } from "./topics.js";

export interface DLQMessage {
	originalTopic: string;
	originalPartition?: number;
	originalOffset?: string;
	originalKey?: string;
	originalMessage: unknown;
	failureStage: string;
	errorClassification: "retryable" | "non_retryable" | "poison";
	errorCode: string;
	errorMessage: string;
	errorStack?: string;
	retryCount: number;
	processingService: string;
	processingInstance?: string;
}

export interface DLQPublisher {
	publish(message: DLQMessage): Promise<void>;
}

interface DLQPublisherOptions {
	producer: LatticeProducer;
	logger: Logger;
	source: EnvelopeSource;
	tenantId: string;
	accountId?: string;
}

class DLQPublisherImpl implements DLQPublisher {
	private producer: LatticeProducer;
	private logger: Logger;
	private source: EnvelopeSource;
	private tenantId: string;
	private defaultAccountId: string;

	constructor(options: DLQPublisherOptions) {
		this.producer = options.producer;
		this.logger = options.logger;
		this.source = options.source;
		this.tenantId = options.tenantId;
		this.defaultAccountId = options.accountId ?? "system";
	}

	async publish(message: DLQMessage): Promise<void> {
		const now = new Date().toISOString();

		// Try to extract account_id from original message if it's an envelope
		let accountId = this.defaultAccountId;
		if (
			message.originalMessage &&
			typeof message.originalMessage === "object" &&
			"account_id" in message.originalMessage
		) {
			accountId = (message.originalMessage as { account_id: string })
				.account_id;
		}

		const dlqPayload = {
			dlq_id: uuidv4(),
			original_topic: message.originalTopic,
			original_partition: message.originalPartition,
			original_offset: message.originalOffset,
			original_key: message.originalKey,
			original_message: message.originalMessage,
			failure_stage: message.failureStage,
			error_classification: message.errorClassification,
			error_code: message.errorCode,
			error_message: message.errorMessage,
			error_stack: message.errorStack,
			retry_count: message.retryCount,
			first_failed_at: now,
			last_failed_at: now,
			dlq_at: now,
			processing_service: message.processingService,
			processing_instance: message.processingInstance,
		};

		const envelope = createEnvelope({
			tenant_id: this.tenantId,
			account_id: accountId,
			domain: "mail",
			stage: "raw", // DLQ messages are considered raw for reprocessing
			schema_version: "v1",
			source: this.source,
			payload: dlqPayload,
			data_classification: "confidential",
			pii: { contains_pii: true, pii_fields: ["original_message"] },
		});

		const dlqTopic = getDLQTopic(message.originalTopic);

		try {
			await this.producer.send(dlqTopic, envelope);

			this.logger.info("Message published to DLQ", {
				dlq_id: dlqPayload.dlq_id,
				original_topic: message.originalTopic,
				error_classification: message.errorClassification,
				error_code: message.errorCode,
			});
		} catch (error) {
			// Log but don't throw - DLQ publishing should not block processing
			this.logger.error("Failed to publish to DLQ", {
				dlq_id: dlqPayload.dlq_id,
				original_topic: message.originalTopic,
				error_message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export function createDLQPublisher(options: DLQPublisherOptions): DLQPublisher {
	return new DLQPublisherImpl(options);
}
