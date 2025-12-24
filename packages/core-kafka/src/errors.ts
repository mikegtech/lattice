export class KafkaError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly retryable: boolean,
	) {
		super(message);
		this.name = "KafkaError";
	}
}

export class RetryableError extends KafkaError {
	constructor(message: string, code: string) {
		super(message, code, true);
		this.name = "RetryableError";
	}
}

export class NonRetryableError extends KafkaError {
	constructor(message: string, code: string) {
		super(message, code, false);
		this.name = "NonRetryableError";
	}
}

export class SchemaValidationError extends NonRetryableError {
	constructor(
		message: string,
		public readonly schemaVersion: string,
		public readonly validationErrors: string[],
	) {
		super(message, "SCHEMA_VALIDATION_FAILED");
		this.name = "SchemaValidationError";
	}
}
