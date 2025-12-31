export { createKafkaClient, type KafkaClientOptions } from "./client.js";
export {
	createProducer,
	type LatticeProducer,
	type ProduceOptions,
} from "./producer.js";
export {
	createConsumer,
	type LatticeConsumer,
	type ConsumerOptions,
	type MessageHandler,
	type ProcessResult,
} from "./consumer.js";
export {
	createDLQPublisher,
	type DLQPublisher,
	type DLQMessage,
} from "./dlq.js";
export {
	createEnvelope,
	validateEnvelope,
	type Envelope,
	type EnvelopeSource,
	type PiiInfo,
	type ProviderSource,
	type CreateEnvelopeOptions,
} from "./envelope.js";
export { TOPICS, type TopicName } from "./topics.js";
export {
	KafkaError,
	RetryableError,
	NonRetryableError,
	SchemaValidationError,
} from "./errors.js";
