/**
 * Kafka topic naming convention:
 * lattice.<domain>.<stage>.<version>
 */
export const TOPICS = {
	// Mail pipeline topics
	MAIL_RAW: "lattice.mail.raw.v1",
	MAIL_PARSE: "lattice.mail.parse.v1",
	MAIL_CHUNK: "lattice.mail.chunk.v1",
	MAIL_EMBED: "lattice.mail.embed.v1",
	MAIL_UPSERT: "lattice.mail.upsert.v1",
	MAIL_DELETE: "lattice.mail.delete.v1",

	// Attachment text pipeline (convergence point for extraction + OCR)
	MAIL_ATTACHMENT_TEXT: "lattice.mail.attachment.text.v1",

	// OCR pipeline topics (domain-agnostic)
	OCR_REQUEST: "lattice.ocr.request.v1",
	OCR_RESULT: "lattice.ocr.result.v1",
	OCR_DLQ: "lattice.dlq.ocr.v1",

	// DLQ topics
	MAIL_DLQ: "lattice.mail.dlq.v1",

	// Audit topics
	AUDIT_EVENTS: "lattice.audit.events.v1",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/**
 * Get the DLQ topic for a given source topic
 */
export function getDLQTopic(sourceTopic: string): string {
	// OCR topics have their own DLQ
	if (sourceTopic.startsWith("lattice.ocr.")) {
		return TOPICS.OCR_DLQ;
	}
	// For now, all mail topics go to the same DLQ
	if (sourceTopic.startsWith("lattice.mail.")) {
		return TOPICS.MAIL_DLQ;
	}
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
