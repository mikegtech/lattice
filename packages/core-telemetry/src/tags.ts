import type { ServiceIdentity } from '@lattice/core-config';

/**
 * Required tags for all telemetry (metrics, logs, traces)
 * These MUST be present on every emission
 */
export const REQUIRED_TAGS = [
  'env',
  'service',
  'version',
] as const;

/**
 * Optional but recommended tags for context
 */
export const OPTIONAL_TAGS = [
  'team',
  'cloud',
  'region',
  'domain',
  'pipeline',
  'stage',
] as const;

/**
 * High-cardinality tags that should NEVER be used as metric tags
 * These are acceptable in logs and trace attributes only
 */
export const HIGH_CARDINALITY_TAGS = [
  'account_id',
  'tenant_id',
  'email_id',
  'provider_message_id',
  'chunk_id',
  'trace_id',
  'span_id',
  'message_id',
  'user_id',
] as const;

export type RequiredTag = (typeof REQUIRED_TAGS)[number];
export type OptionalTag = (typeof OPTIONAL_TAGS)[number];
export type HighCardinalityTag = (typeof HIGH_CARDINALITY_TAGS)[number];

export interface ServiceTags {
  env: string;
  service: string;
  version: string;
  team?: string;
  cloud?: string;
  region?: string;
  domain?: string;
  pipeline?: string;
  stage?: string;
}

export interface MetricTags extends ServiceTags {
  // Metric tags must NOT include high-cardinality fields
  // This type enforces that at compile time
}

export interface LogTags extends ServiceTags {
  // Log tags CAN include high-cardinality fields
  account_id?: string;
  tenant_id?: string;
  email_id?: string;
  provider_message_id?: string;
  chunk_id?: string;
  trace_id?: string;
  span_id?: string;
}

/**
 * Sanitize a tag value for Datadog
 * - Lowercase
 * - Replace spaces/special chars with underscores
 * - Truncate to 200 chars
 */
export function sanitizeTagValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_\-./]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200);
}

/**
 * Validate that required tags are present
 */
export function validateTags(
  tags: Record<string, string | undefined>,
  context: string
): void {
  const missing = REQUIRED_TAGS.filter((tag) => !tags[tag]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required tags in ${context}: ${missing.join(', ')}`
    );
  }
}

/**
 * Check if a tag is high-cardinality (should not be used for metrics)
 */
export function isHighCardinality(tagName: string): boolean {
  return HIGH_CARDINALITY_TAGS.includes(tagName as HighCardinalityTag);
}

/**
 * Filter out high-cardinality tags for metric emissions
 */
export function filterMetricTags(
  tags: Record<string, string | undefined>
): MetricTags {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && !isHighCardinality(key)) {
      filtered[key] = value;
    }
  }
  return filtered as MetricTags;
}

/**
 * Create a tag builder from service identity
 */
export function createTagBuilder(identity: ServiceIdentity) {
  const baseTags: ServiceTags = {
    env: identity.name.includes('prod') ? 'prod' : 'dev',
    service: identity.name,
    version: identity.version,
    team: identity.team,
    cloud: identity.cloud,
    region: identity.region,
    domain: identity.domain,
    pipeline: identity.pipeline,
  };

  return {
    /**
     * Get base service tags (safe for metrics)
     */
    getServiceTags(): ServiceTags {
      return { ...baseTags };
    },

    /**
     * Build tags for metrics (no high-cardinality)
     */
    forMetric(extra?: Partial<ServiceTags>): MetricTags {
      const tags = { ...baseTags, ...extra };
      return filterMetricTags(tags);
    },

    /**
     * Build tags for logs (can include high-cardinality)
     */
    forLog(extra?: Record<string, string | undefined>): LogTags {
      return { ...baseTags, ...extra } as LogTags;
    },

    /**
     * Build tags for a specific pipeline stage
     */
    forStage(stage: string, extra?: Record<string, string | undefined>): LogTags {
      return { ...baseTags, stage, ...extra } as LogTags;
    },
  };
}
