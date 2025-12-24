/**
 * Error classification for DLQ routing decisions
 */
export type ErrorClassification = 'retryable' | 'non_retryable' | 'poison';

export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly classification: ErrorClassification,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export class RetryableWorkerError extends WorkerError {
  constructor(message: string, code: string) {
    super(message, code, 'retryable');
    this.name = 'RetryableWorkerError';
  }
}

export class NonRetryableWorkerError extends WorkerError {
  constructor(message: string, code: string) {
    super(message, code, 'non_retryable');
    this.name = 'NonRetryableWorkerError';
  }
}

/**
 * Patterns that indicate retryable errors
 */
const RETRYABLE_PATTERNS = [
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /connection.*terminated/i,
  /connection.*reset/i,
  /timeout/i,
  /temporarily unavailable/i,
  /too many connections/i,
  /deadlock/i,
  /lock wait timeout/i,
  /broker/i,
  /leader not available/i,
  /request timed out/i,
  /network/i,
];

/**
 * Patterns that indicate poison messages (malformed data)
 */
const POISON_PATTERNS = [
  /JSON/i,
  /parse/i,
  /unexpected token/i,
  /invalid.*format/i,
  /schema.*validation/i,
  /missing.*required/i,
];

/**
 * Classify an error for DLQ routing
 */
export function classifyError(error: Error): ErrorClassification {
  // If already classified, use that
  if (error instanceof WorkerError) {
    return error.classification;
  }

  const message = error.message;

  // Check for poison message patterns first
  for (const pattern of POISON_PATTERNS) {
    if (pattern.test(message)) {
      return 'poison';
    }
  }

  // Check for retryable patterns
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return 'retryable';
    }
  }

  // Default to non-retryable
  return 'non_retryable';
}

/**
 * Create a retryable error result
 */
export function retryable(reason: string): {
  status: 'retry';
  reason: string;
} {
  return { status: 'retry', reason };
}

/**
 * Create a DLQ error result
 */
export function dlq(
  reason: string,
  error: Error,
): { status: 'dlq'; reason: string; error: Error } {
  return { status: 'dlq', reason, error };
}

/**
 * Create a skip result
 */
export function skip(reason: string): { status: 'skip'; reason: string } {
  return { status: 'skip', reason };
}

/**
 * Create a success result
 */
export function success<T>(output?: T): { status: 'success'; output?: T } {
  const result: { status: 'success'; output?: T } = { status: 'success' };
  if (output !== undefined) result.output = output;
  return result;
}
