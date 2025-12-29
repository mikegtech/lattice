import { v4 as uuidv4 } from "uuid";
import { SchemaValidationError } from "./errors.js";

export interface EnvelopeSource {
	service: string;
	version: string;
	instance_id?: string;
}

export interface PiiInfo {
	contains_pii: boolean;
	pii_fields?: string[];
}

export interface ProviderSource {
	provider: "gmail" | "imap";
	account_id: string;
	alias: string;
	provider_message_id?: string;
	provider_thread_id?: string;
	scope?: string;
}

export interface Envelope<T = unknown> {
	message_id: string;
	trace_id?: string;
	span_id?: string;
	tenant_id: string;
	account_id: string;
	alias?: string;
	domain: "mail" | "calendar" | "drive" | "contacts";
	stage: "raw" | "parse" | "chunk" | "embed" | "upsert" | "delete" | "audit";
	schema_version: string;
	created_at: string;
	source: EnvelopeSource;
	provider_source?: ProviderSource;
	data_classification: "public" | "internal" | "confidential" | "restricted";
	pii: PiiInfo;
	payload: T;
}

export interface CreateEnvelopeOptions<T> {
	tenant_id: string;
	account_id: string;
	domain: Envelope["domain"];
	stage: Envelope["stage"];
	schema_version: string;
	source: EnvelopeSource;
	payload: T;
	trace_id?: string;
	span_id?: string;
	data_classification?: Envelope["data_classification"];
	pii?: PiiInfo;
}

export function createEnvelope<T>(
	options: CreateEnvelopeOptions<T>,
): Envelope<T> {
	const envelope: Envelope<T> = {
		message_id: uuidv4(),
		tenant_id: options.tenant_id,
		account_id: options.account_id,
		domain: options.domain,
		stage: options.stage,
		schema_version: options.schema_version,
		created_at: new Date().toISOString(),
		source: options.source,
		data_classification: options.data_classification ?? "confidential",
		pii: options.pii ?? { contains_pii: true, pii_fields: ["payload"] },
		payload: options.payload,
	};
	if (options.trace_id) envelope.trace_id = options.trace_id;
	if (options.span_id) envelope.span_id = options.span_id;
	return envelope;
}

const REQUIRED_ENVELOPE_FIELDS = [
	"message_id",
	"tenant_id",
	"account_id",
	"domain",
	"stage",
	"schema_version",
	"created_at",
	"source",
	"data_classification",
	"pii",
	"payload",
] as const;

const VALID_DOMAINS = ["mail", "calendar", "drive", "contacts"];
const VALID_STAGES = [
	"raw",
	"parse",
	"chunk",
	"embed",
	"upsert",
	"delete",
	"audit",
];

export function validateEnvelope(
	data: unknown,
	expectedVersion?: string,
): Envelope {
	if (!data || typeof data !== "object") {
		throw new SchemaValidationError(
			"Envelope must be an object",
			expectedVersion ?? "unknown",
			["Envelope is not an object"],
		);
	}

	const envelope = data as Record<string, unknown>;
	const errors: string[] = [];

	// Check required fields
	for (const field of REQUIRED_ENVELOPE_FIELDS) {
		if (!(field in envelope)) {
			errors.push(`Missing required field: ${field}`);
		}
	}

	// Validate domain
	if (
		envelope["domain"] &&
		!VALID_DOMAINS.includes(envelope["domain"] as string)
	) {
		errors.push(`Invalid domain: ${envelope["domain"]}`);
	}

	// Validate stage
	if (
		envelope["stage"] &&
		!VALID_STAGES.includes(envelope["stage"] as string)
	) {
		errors.push(`Invalid stage: ${envelope["stage"]}`);
	}

	// Validate schema_version format
	if (
		envelope["schema_version"] &&
		typeof envelope["schema_version"] === "string"
	) {
		if (!/^v\d+$/.test(envelope["schema_version"])) {
			errors.push(
				`Invalid schema_version format: ${envelope["schema_version"]}`,
			);
		}
	}

	// Check version match if expected
	if (expectedVersion && envelope["schema_version"] !== expectedVersion) {
		errors.push(
			`Schema version mismatch: expected ${expectedVersion}, got ${envelope["schema_version"]}`,
		);
	}

	// Validate source object
	if (envelope["source"]) {
		const source = envelope["source"] as Record<string, unknown>;
		if (!source["service"] || !source["version"]) {
			errors.push("Source must have service and version fields");
		}
	}

	// Validate pii object
	if (envelope["pii"]) {
		const pii = envelope["pii"] as Record<string, unknown>;
		if (typeof pii["contains_pii"] !== "boolean") {
			errors.push("PII must have contains_pii boolean field");
		}
	}

	if (errors.length > 0) {
		throw new SchemaValidationError(
			`Envelope validation failed: ${errors.join("; ")}`,
			(envelope["schema_version"] as string) ?? "unknown",
			errors,
		);
	}

	return envelope as unknown as Envelope;
}
