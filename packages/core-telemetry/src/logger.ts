import pino from 'pino';
import type { ServiceTags, LogTags } from './tags.js';
import { validateTags } from './tags.js';

export interface LogContext extends Record<string, unknown> {
  trace_id?: string;
  span_id?: string;
  account_id?: string;
  email_id?: string;
  provider_message_id?: string;
  stage?: string;
  error_code?: string;
}

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level?: string;
  serviceTags: ServiceTags;
  pretty?: boolean;
}

/**
 * Redact sensitive fields from log context
 */
const REDACTED_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api_?key/i,
  /auth/i,
  /credential/i,
  /private/i,
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Check if key matches sensitive patterns
    if (REDACTED_PATTERNS.some((p) => p.test(key))) {
      result[key] = '[REDACTED]';
      continue;
    }

    // Recursively handle objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>);
      continue;
    }

    // Redact email addresses in string values (PII protection)
    if (typeof value === 'string') {
      result[key] = value.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]');
      continue;
    }

    result[key] = value;
  }

  return result;
}

class PinoLogger implements Logger {
  private pino: pino.Logger;
  private baseTags: ServiceTags;

  constructor(pinoInstance: pino.Logger, baseTags: ServiceTags) {
    this.pino = pinoInstance;
    this.baseTags = baseTags;
  }

  private formatContext(context?: LogContext): Record<string, unknown> {
    if (!context) {
      return { ...this.baseTags };
    }

    const redacted = redactSensitive(context as Record<string, unknown>);
    return {
      ...this.baseTags,
      ...redacted,
      // Datadog log-trace correlation fields
      dd: {
        trace_id: context.trace_id,
        span_id: context.span_id,
      },
    };
  }

  debug(msg: string, context?: LogContext): void {
    this.pino.debug(this.formatContext(context), msg);
  }

  info(msg: string, context?: LogContext): void {
    this.pino.info(this.formatContext(context), msg);
  }

  warn(msg: string, context?: LogContext): void {
    this.pino.warn(this.formatContext(context), msg);
  }

  error(msg: string, context?: LogContext): void {
    this.pino.error(this.formatContext(context), msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const redactedBindings = redactSensitive(bindings);
    return new PinoLogger(
      this.pino.child(redactedBindings),
      this.baseTags
    );
  }
}

export function createLogger(options: LoggerOptions): Logger {
  validateTags(options.serviceTags as unknown as Record<string, string | undefined>, 'logger');

  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: {
      // Datadog unified service tags
      env: options.serviceTags.env,
      service: options.serviceTags.service,
      version: options.serviceTags.version,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (options.pretty) {
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  const pinoInstance = (pino as unknown as (opts: pino.LoggerOptions) => pino.Logger)(pinoOptions);
  return new PinoLogger(pinoInstance, options.serviceTags);
}
