import {
	Injectable,
	type LoggerService as NestLoggerService,
} from "@nestjs/common";
import pino, { type Logger as PinoLogger } from "pino";
import type { WorkerConfig } from "../config/config.module.js";
import { EventLogger } from "./events.js";
import { LogTier, shouldForwardLog } from "./log-tier.js";

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

/**
 * Extended log context with tier information
 */
export interface TieredLogContext extends LogContext {
	tier?: LogTier;
}

@Injectable()
export class LoggerService implements NestLoggerService {
	private pino: PinoLogger;
	private baseTags: Record<string, string>;
	private config: WorkerConfig;

	constructor(config: WorkerConfig) {
		this.config = config;
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

		// Use JSON format by default for Datadog, pretty only if explicitly requested
		const logFormat = process.env["LOG_FORMAT"] ?? "json";
		const isPretty = logFormat === "pretty";

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

	private formatContext(
		context?: TieredLogContext,
		defaultTier: LogTier = LogTier.OPERATIONAL,
	): Record<string, unknown> {
		const base = { ...this.baseTags };

		if (!context) {
			// Default tier for logs without context
			const { forward } = shouldForwardLog(defaultTier, this.config.logging);
			return {
				...base,
				tier: defaultTier,
				"dd.forward": forward,
			};
		}

		const tier = context.tier ?? defaultTier;
		const { forward, sampled } = shouldForwardLog(
			tier,
			this.config.logging,
			context.trace_id,
		);

		// Destructure tier out before redacting, then spread the rest
		const { tier: _tier, ...contextWithoutTier } = context;
		const redacted = redactObject(
			contextWithoutTier as Record<string, unknown>,
		);

		return {
			...base,
			...redacted,
			tier,
			"dd.forward": forward,
			...(sampled !== undefined && { "dd.sampled": sampled }),
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
			this.pino.debug(this.formatContext(context, LogTier.DEBUG), message);
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

	// ==========================================================================
	// Tier-aware logging methods
	// ==========================================================================

	/**
	 * Log a CRITICAL tier message - always shipped to Datadog
	 * Use for: uncaught exceptions, DLQ events, data corruption
	 */
	critical(message: string, context?: LogContext): void {
		this.pino.error(
			this.formatContext(
				{ ...context, tier: LogTier.CRITICAL },
				LogTier.CRITICAL,
			),
			message,
		);
	}

	/**
	 * Log an OPERATIONAL tier message - always shipped to Datadog
	 * Use for: events, errors, significant state changes
	 */
	operational(message: string, context?: LogContext): void {
		this.pino.info(
			this.formatContext(
				{ ...context, tier: LogTier.OPERATIONAL },
				LogTier.OPERATIONAL,
			),
			message,
		);
	}

	/**
	 * Log a LIFECYCLE tier message - shipped on state changes only
	 * Use for: startup, shutdown, connection changes
	 */
	lifecycle(message: string, context?: LogContext): void {
		this.pino.info(
			this.formatContext(
				{ ...context, tier: LogTier.LIFECYCLE },
				LogTier.LIFECYCLE,
			),
			message,
		);
	}

	/**
	 * Log a DEBUG tier message - never shipped to Datadog unless sampled
	 * Use for: local debugging, verbose tracing
	 */
	debugTiered(message: string, context?: LogContext): void {
		this.pino.debug(
			this.formatContext({ ...context, tier: LogTier.DEBUG }, LogTier.DEBUG),
			message,
		);
	}

	/**
	 * Log with explicit tier
	 */
	tiered(tier: LogTier, message: string, context?: LogContext): void {
		const formattedContext = this.formatContext({ ...context, tier }, tier);

		switch (tier) {
			case LogTier.CRITICAL:
				this.pino.error(formattedContext, message);
				break;
			case LogTier.OPERATIONAL:
			case LogTier.LIFECYCLE:
				this.pino.info(formattedContext, message);
				break;
			case LogTier.DEBUG:
				this.pino.debug(formattedContext, message);
				break;
		}
	}

	/**
	 * Create an EventLogger for structured Datadog events
	 */
	createEventLogger(): EventLogger {
		return new EventLogger(this, this.config);
	}
}
