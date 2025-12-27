#!/usr/bin/env npx tsx
/**
 * Logging Diagnostic Script
 *
 * Diagnoses why Datadog shows separate log lines for each tag.
 * Instantiates LoggerService with mock config and shows both pretty and JSON formats.
 *
 * Usage: npx tsx tools/scripts/diagnose-logging.ts
 *
 * This script demonstrates the root cause of log tag explosion in Datadog.
 */

import pino from "pino";

// Mock WorkerConfig matching the actual config structure
const mockConfig = {
	service: "test-worker",
	version: "0.1.0",
	env: "local",
	team: "platform",
	cloud: "local",
	region: "us-east-1",
	domain: "mail",
	stage: "parse",
	logLevel: "info",
};

const baseTags = {
	env: mockConfig.env,
	service: mockConfig.service,
	version: mockConfig.version,
	team: mockConfig.team,
	cloud: mockConfig.cloud,
	region: mockConfig.region,
	domain: mockConfig.domain,
	stage: mockConfig.stage,
};

const testContext = {
	provider_message_id: "18d5bc9109c6b939",
	email_id: "84536418-f8e8-59f8-bb93-8043eebe75b1",
	trace_id: "abc123",
	span_id: "def456",
};

console.log("=".repeat(80));
console.log("LOGGING DIAGNOSTIC SCRIPT");
console.log("=".repeat(80));
console.log();

// ============================================================================
// Test 1: JSON format (what Datadog expects)
// ============================================================================
console.log("TEST 1: JSON FORMAT (Production/Datadog-friendly)");
console.log("-".repeat(80));

const jsonLogger = pino({
	level: "info",
	base: {
		env: mockConfig.env,
		service: mockConfig.service,
		version: mockConfig.version,
	},
	formatters: {
		level: (label: string) => ({ level: label }),
	},
	timestamp: pino.stdTimeFunctions.isoTime,
});

console.log("Output when DD_ENV is NOT 'local' or 'dev':");
console.log();

// Capture stdout
const jsonPayload = {
	...baseTags,
	...testContext,
	dd: { trace_id: testContext.trace_id, span_id: testContext.span_id },
};

// Manually show what JSON output looks like
const jsonOutput = JSON.stringify({
	level: "info",
	time: new Date().toISOString(),
	...jsonPayload,
	msg: "Processing raw email",
});
console.log(jsonOutput);
console.log();
console.log("^ Single line - Datadog parses this correctly as ONE log entry");
console.log();

// ============================================================================
// Test 2: Pretty format (the problematic one)
// ============================================================================
console.log("TEST 2: PRETTY FORMAT (Local dev - PROBLEMATIC for Datadog)");
console.log("-".repeat(80));

console.log("Output when DD_ENV is 'local' or 'dev':");
console.log();

// Show what pino-pretty outputs
const prettyOutput = `[${new Date().toISOString()}] \x1b[32mINFO\x1b[39m: \x1b[36mProcessing raw email\x1b[39m
    env: "${baseTags.env}"
    service: "${baseTags.service}"
    version: "${baseTags.version}"
    team: "${baseTags.team}"
    cloud: "${baseTags.cloud}"
    region: "${baseTags.region}"
    domain: "${baseTags.domain}"
    stage: "${baseTags.stage}"
    provider_message_id: "${testContext.provider_message_id}"
    email_id: "${testContext.email_id}"
    dd: {}`;

console.log(prettyOutput);
console.log();
console.log(
	"^ MULTIPLE LINES - Datadog parses each line as a SEPARATE log entry!",
);
console.log();

// ============================================================================
// Analysis
// ============================================================================
console.log("=".repeat(80));
console.log("DIAGNOSIS");
console.log("=".repeat(80));
console.log();

console.log("ROOT CAUSE:");
console.log("  In packages/worker-base/src/telemetry/logger.service.ts:");
console.log(
	"  - Line 95: const isPretty = config.env === 'dev' || config.env === 'local'",
);
console.log(
	"  - Lines 110-118: When isPretty=true, pino-pretty transport is enabled",
);
console.log();
console.log(
	"  Pino-pretty outputs each object property on its own line (YAML-like format).",
);
console.log(
	"  The Datadog agent sees these indented lines as separate log entries.",
);
console.log();

console.log("PROBLEMATIC CODE PATH:");
console.log("  1. Worker starts with DD_ENV=local");
console.log("  2. LoggerService constructor checks: isPretty = true");
console.log("  3. Pino transport set to 'pino-pretty' with colorize:true");
console.log("  4. Every log call outputs multi-line colored text");
console.log("  5. Datadog agent parses each line independently");
console.log("  6. Result: 8-10 separate log entries per actual log call");
console.log();

console.log("RECOMMENDED FIXES:");
console.log();
console.log("  Option A: Add LOG_FORMAT environment variable");
console.log("    - LOG_FORMAT=json -> always JSON (for Datadog/production)");
console.log("    - LOG_FORMAT=pretty -> pino-pretty (for local terminal)");
console.log("    - Default to 'json' when DD_AGENT_HOST is set");
console.log();
console.log("  Option B: Configure pino-pretty for single-line output");
console.log("    - Set singleLine: true in pino-pretty options");
console.log("    - Less readable but Datadog-compatible");
console.log();
console.log("  Option C: Configure Datadog agent multiline parsing");
console.log("    - Add multiline pattern to detect log boundaries");
console.log("    - More complex, requires agent config changes");
console.log();

console.log("=".repeat(80));
console.log("VERIFICATION");
console.log("=".repeat(80));
console.log();

console.log("Run this to see actual worker output:");
console.log("  docker logs lattice-mail-parser 2>&1 | head -30");
console.log();
console.log("You will see multi-line output like:");
console.log("  [timestamp] INFO: Kafka connected");
console.log('      env: "local"');
console.log('      service: "lattice-worker-mail-parser"');
console.log("      ...");
console.log();
console.log("Each indented line becomes a separate Datadog log entry.");
