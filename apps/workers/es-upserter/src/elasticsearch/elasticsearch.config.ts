import { Injectable } from "@nestjs/common";

export const ELASTICSEARCH_CONFIG = "ELASTICSEARCH_CONFIG";

export interface ElasticsearchConfig {
	readonly node: string;
	readonly index: string;
	readonly apiKey?: string;
	readonly cloudId?: string;
	readonly requestTimeoutMs: number;
	readonly aliasPattern?: string;
}

/**
 * Load Elasticsearch configuration from environment variables
 */
export function loadElasticsearchConfig(): ElasticsearchConfig {
	return {
		node: process.env["ELASTICSEARCH_NODE"] ?? "http://localhost:9200",
		index: process.env["ELASTICSEARCH_INDEX"] ?? "email_chunks_v1",
		apiKey: process.env["ELASTICSEARCH_API_KEY"] || undefined,
		cloudId: process.env["ELASTICSEARCH_CLOUD_ID"] || undefined,
		requestTimeoutMs: Number.parseInt(
			process.env["ELASTICSEARCH_TIMEOUT_MS"] ?? "30000",
			10,
		),
		aliasPattern: process.env["ES_UPSERTER_ALIAS_PATTERN"] || undefined,
	};
}

/**
 * Match an alias against a glob-style pattern with single `*` wildcard.
 * Case-insensitive.
 */
export function matchAlias(alias: string, pattern: string): boolean {
	const lowerAlias = alias.toLowerCase();
	const lowerPattern = pattern.toLowerCase();

	if (!lowerPattern.includes("*")) {
		return lowerAlias === lowerPattern;
	}

	const parts = lowerPattern.split("*");
	if (parts.length !== 2) {
		// Only single wildcard supported
		return false;
	}

	const [prefix, suffix] = parts;
	return lowerAlias.startsWith(prefix!) && lowerAlias.endsWith(suffix!);
}
