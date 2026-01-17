/**
 * Kafka topic naming convention:
 * Primary topics: lattice.<domain>.<stage>.<version>
 * DLQ topics: lattice.dlq.<domain>.<stage>.<version>
 */
export const TOPICS = {
	// Mail pipeline topics
	MAIL_RAW: "lattice.mail.raw.v1",
	MAIL_PARSE: "lattice.mail.parse.v1",
	MAIL_CHUNK: "lattice.mail.chunk.v1",
	MAIL_EMBED: "lattice.mail.embed.v1",
	MAIL_UPSERT: "lattice.mail.upsert.v1",
	MAIL_DELETE: "lattice.mail.delete.v1",

	// Attachment pipeline topics
	MAIL_ATTACHMENT: "lattice.mail.attachment.v1",
	MAIL_ATTACHMENT_EXTRACTED: "lattice.mail.attachment.extracted.v1",
	MAIL_ATTACHMENT_TEXT: "lattice.mail.attachment.text.v1",

	// OCR pipeline topics (domain-agnostic)
	OCR_REQUEST: "lattice.ocr.request.v1",
	OCR_RESULT: "lattice.ocr.result.v1",

	// Audit topics
	AUDIT_EVENTS: "lattice.audit.events.v1",

	// DLQ topics - per-topic DLQs for lineage and operations
	DLQ_MAIL_PARSE: "lattice.dlq.mail.parse.v1",
	DLQ_MAIL_CHUNK: "lattice.dlq.mail.chunk.v1",
	DLQ_MAIL_EMBED: "lattice.dlq.mail.embed.v1",
	DLQ_MAIL_UPSERT: "lattice.dlq.mail.upsert.v1",
	DLQ_MAIL_DELETE: "lattice.dlq.mail.delete.v1",
	DLQ_MAIL_ATTACHMENT: "lattice.dlq.mail.attachment.v1",
	DLQ_MAIL_ATTACHMENT_CHUNK: "lattice.dlq.mail.attachment.chunk.v1",
	DLQ_MAIL_OCR: "lattice.dlq.mail.ocr.v1",
	DLQ_OCR: "lattice.dlq.ocr.v1",
	DLQ_AUDIT_EVENTS: "lattice.dlq.audit.events.v1",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/**
 * Get the DLQ topic for a given source topic.
 *
 * DLQ naming convention: lattice.dlq.<domain>.<stage>.v1
 *
 * Note: Workers typically configure their DLQ topic explicitly via
 * KAFKA_TOPIC_DLQ environment variable. This function provides a
 * deterministic fallback based on the input topic name.
 *
 * @example
 * getDLQTopic("lattice.mail.parse.v1") => "lattice.dlq.mail.parse.v1"
 * getDLQTopic("lattice.ocr.request.v1") => "lattice.dlq.ocr.request.v1"
 */
export function getDLQTopic(sourceTopic: string): string {
	// Parse the topic to extract domain, stage, version
	const parsed = parseTopicName(sourceTopic);

	if (parsed) {
		// Standard topic: lattice.<domain>.<stage>.v1 => lattice.dlq.<domain>.<stage>.v1
		return `lattice.dlq.${parsed.domain}.${parsed.stage}.${parsed.version}`;
	}

	// Handle nested topics like lattice.mail.attachment.text.v1
	// Pattern: lattice.<domain>.<sub>.<stage>.v<N>
	const nestedMatch = /^lattice\.(\w+)\.(\w+)\.(\w+)\.(v\d+)$/.exec(
		sourceTopic,
	);
	if (nestedMatch) {
		const [, domain, sub, stage, version] = nestedMatch;
		return `lattice.dlq.${domain}.${sub}.${stage}.${version}`;
	}

	// Fallback: append .dlq if we can't parse
	return `${sourceTopic}.dlq`;
}

/**
 * Parse topic name to extract domain and stage
 */
export function parseTopicName(topic: string): {
	domain: string;
	stage: string;
	version: string;
} | null {
	const match = /^lattice\.(\w+)\.(\w+)\.(v\d+)$/.exec(topic);
	if (!match) {
		return null;
	}
	const [, domain, stage, version] = match;
	return { domain: domain!, stage: stage!, version: version! };
}
