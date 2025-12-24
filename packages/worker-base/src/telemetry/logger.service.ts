import {
	Injectable,
	type LoggerService as NestLoggerService,
} from "@nestjs/common";
import pino, { type Logger as PinoLogger } from "pino";
import type { WorkerConfig } from "../config/config.module.js";

export const LOGGER = "LOGGER";

/**
 * PII patterns that MUST be redacted from logs
 */
const PII_PATTERNS = [
	/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
];

const SENSITIVE_KEYS = [
	/password/i,
	/secret/i,
	/token/i,
	/api_?key/i,
	/auth/i,
	/credential/i,
	/private/i,
	/body/i, // Never log email bodies
	/raw_payload/i,
	/text_plain/i,
	/text_html/i,
];

function redactValue(value: unknown): unknown {
	if (typeof value === "string") {
		let result = value;
		for (const pattern of PII_PATTERNS) {
			result = result.replace(pattern, "[PII_REDACTED]");
		}
		return result;
	}

	if (Array.isArray(value)) {
		return value.map(redactValue);
	}

	if (value && typeof value === "object") {
		return redactObject(value as Record<string, unknown>);
	}

	return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		// Check if key is sensitive
		if (SENSITIVE_KEYS.some((p) => p.test(key))) {
			result[key] = "[REDACTED]";
			continue;
		}

		result[key] = redactValue(value);
	}

	return result;
}

export interface LogContext {
	trace_id?: string;
	span_id?: string;
	email_id?: string;
	provider_message_id?: string;
	stage?: string;
	error_code?: string;
	duration_ms?: number;
	[key: string]: unknown;
}

@Injectable()
export class LoggerService implements NestLoggerService {
	private pino: PinoLogger;
	private baseTags: Record<string, string>;

	constructor(config: WorkerConfig) {
		this.baseTags = {
			env: config.env,
			service: config.service,
			version: config.version,
			team: config.team,
			cloud: config.cloud,
			region: config.region,
			domain: config.domain,
			stage: config.stage,
		};

		const isPretty = config.env === "dev" || config.env === "local";

		const options: pino.LoggerOptions = {
			level: config.logLevel,
			base: {
				env: config.env,
				service: config.service,
				version: config.version,
			},
			formatters: {
				level: (label: string) => ({ level: label }),
			},
			timestamp: pino.stdTimeFunctions.isoTime,
		};

		if (isPretty) {
			options.transport = {
				target: "pino-pretty",
				options: {
					colorize: true,
					translateTime: "SYS:standard",
					ignore: "pid,hostname",
				},
			};
		}

		this.pino = pino(options);
	}

	private formatContext(context?: LogContext): Record<string, unknown> {
		const base = { ...this.baseTags };

		if (!context) {
			return base;
		}

		const redacted = redactObject(context as Record<string, unknown>);

		return {
			...base,
			...redacted,
			// Datadog log-trace correlation
			dd: {
				trace_id: context.trace_id,
				span_id: context.span_id,
			},
		};
	}

	log(message: string, context?: LogContext | string): void {
		if (typeof context === "string") {
			this.pino.info({ ...this.baseTags, nestContext: context }, message);
		} else {
			this.pino.info(this.formatContext(context), message);
		}
	}

	error(message: string, trace?: string, context?: string): void {
		this.pino.error(
			{ ...this.baseTags, nestContext: context, stack: trace },
			message,
		);
	}

	warn(message: string, context?: LogContext | string): void {
		if (typeof context === "string") {
			this.pino.warn({ ...this.baseTags, nestContext: context }, message);
		} else {
			this.pino.warn(this.formatContext(context), message);
		}
	}

	debug(message: string, context?: LogContext | string): void {
		if (typeof context === "string") {
			this.pino.debug({ ...this.baseTags, nestContext: context }, message);
		} else {
			this.pino.debug(this.formatContext(context), message);
		}
	}

	verbose(message: string, context?: LogContext | string): void {
		if (typeof context === "string") {
			this.pino.trace({ ...this.baseTags, nestContext: context }, message);
		} else {
			this.pino.trace(this.formatContext(context), message);
		}
	}

	/**
	 * Create a child logger with additional context
	 */
	child(bindings: Record<string, unknown>): LoggerService {
		const childLogger = Object.create(this);
		childLogger.pino = this.pino.child(redactObject(bindings));
		return childLogger;
	}

	/**
	 * Log with explicit context (preferred method for business logic)
	 */
	info(message: string, context?: LogContext): void {
		this.pino.info(this.formatContext(context), message);
	}
}
