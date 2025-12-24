/**
 * Current schema versions for all event types
 */
export const SCHEMA_VERSIONS = {
	ENVELOPE: "v1",
	MAIL_RAW: "v1",
	MAIL_PARSE: "v1",
	MAIL_CHUNK: "v1",
	MAIL_EMBED: "v1",
	MAIL_UPSERT: "v1",
	MAIL_DELETE: "v1",
	MAIL_DLQ: "v1",
	AUDIT_EVENTS: "v1",
} as const;

export type SchemaVersion =
	(typeof SCHEMA_VERSIONS)[keyof typeof SCHEMA_VERSIONS];
