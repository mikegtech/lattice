#!/usr/bin/env npx tsx
/**
 * Docker Compose Validation Script
 *
 * Validates that all worker services in lattice-workers.yml have the required
 * telemetry environment variables defined.
 *
 * Required env vars (per docs/telemetry-tags.md):
 *   - DD_ENV, DD_SERVICE, DD_VERSION
 *   - LATTICE_TEAM, LATTICE_CLOUD, LATTICE_REGION, LATTICE_DOMAIN, LATTICE_STAGE
 *
 * Usage: npx tsx tools/scripts/compose-validate.ts
 *
 * Exit codes:
 *   0 - All services have required env vars
 *   1 - Missing env vars found (outputs details)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Required telemetry environment variables
 */
const REQUIRED_ENV_VARS = [
	"DD_ENV",
	"DD_SERVICE",
	"DD_VERSION",
	"LATTICE_TEAM",
	"LATTICE_CLOUD",
	"LATTICE_REGION",
	"LATTICE_DOMAIN",
	"LATTICE_STAGE",
];

interface ServiceEnv {
	name: string;
	envVars: Set<string>;
	missingVars: string[];
}

/**
 * Parse YAML-style environment variables from a compose file
 * This is a simple parser that handles the specific format of our compose files
 */
function parseComposeFile(content: string): Map<string, ServiceEnv> {
	const services = new Map<string, ServiceEnv>();
	const lines = content.split("\n");

	let currentService: string | null = null;
	let inEnvironment = false;
	let inServices = false;
	let currentEnvVars = new Set<string>();

	// Track x-* anchors for YAML merging
	const anchors = new Map<string, Set<string>>();
	let currentAnchor: string | null = null;
	let inAnchor = false;

	for (const line of lines) {
		const trimmed = line.trimStart();
		const indent = line.length - trimmed.length;

		// Detect x-* anchors (YAML aliases)
		if (trimmed.startsWith("x-") && trimmed.includes(": &")) {
			const match = trimmed.match(/x-[\w-]+:\s*&([\w-]+)/);
			if (match) {
				currentAnchor = match[1];
				inAnchor = true;
				anchors.set(currentAnchor, new Set());
				continue;
			}
		}

		// End of anchor block (next top-level key)
		if (inAnchor && indent === 0 && !trimmed.startsWith("x-")) {
			inAnchor = false;
			currentAnchor = null;
		}

		// Capture env vars in anchor
		if (inAnchor && currentAnchor) {
			const envMatch = trimmed.match(/^(\w+):/);
			if (envMatch) {
				anchors.get(currentAnchor)?.add(envMatch[1]);
			}
		}

		// Detect services: section
		if (trimmed === "services:") {
			inServices = true;
			continue;
		}

		// Detect networks: or volumes: section (end of services)
		if (indent === 0 && (trimmed === "networks:" || trimmed === "volumes:")) {
			// Save current service before leaving services section
			if (currentService) {
				services.set(currentService, {
					name: currentService,
					envVars: currentEnvVars,
					missingVars: [],
				});
				currentService = null;
			}
			inServices = false;
			inEnvironment = false;
			continue;
		}

		// Detect a new service (2-space indent under services:)
		if (inServices && indent === 2 && trimmed.match(/^[\w-]+:$/)) {
			// Save previous service
			if (currentService) {
				services.set(currentService, {
					name: currentService,
					envVars: currentEnvVars,
					missingVars: [],
				});
			}
			currentService = trimmed.replace(":", "");
			currentEnvVars = new Set();
			inEnvironment = false;
			continue;
		}

		// Detect environment: section
		if (currentService && trimmed === "environment:") {
			inEnvironment = true;
			continue;
		}

		// End of environment section (another top-level service key)
		if (
			inEnvironment &&
			indent === 6 &&
			!trimmed.startsWith("-") &&
			!trimmed.startsWith("#") &&
			trimmed.match(/^[\w-]+:/) &&
			!trimmed.includes("<<:")
		) {
			// Check if it's actually an env var (has value after colon)
			const parts = trimmed.split(":");
			if (parts.length >= 2 && parts[1].trim()) {
				// It's an env var
				currentEnvVars.add(parts[0].trim());
			} else {
				// It's a new section, end environment
				inEnvironment = false;
			}
			continue;
		}

		// Detect YAML merge key <<: [*anchor1, *anchor2]
		if (inEnvironment && trimmed.startsWith("<<:")) {
			const mergeMatch = trimmed.match(/\*(\w[\w-]*)/g);
			if (mergeMatch) {
				for (const ref of mergeMatch) {
					const anchorName = ref.substring(1);
					const anchorVars = anchors.get(anchorName);
					if (anchorVars) {
						for (const v of anchorVars) {
							currentEnvVars.add(v);
						}
					}
				}
			}
			continue;
		}

		// Parse environment variables
		if (inEnvironment && currentService) {
			// Format: VAR_NAME: value or VAR_NAME: "${VAR:-default}"
			const envMatch = trimmed.match(/^(\w+):/);
			if (envMatch) {
				currentEnvVars.add(envMatch[1]);
			}
		}
	}

	// Save last service (only if we're still in services section)
	if (currentService && inServices) {
		services.set(currentService, {
			name: currentService,
			envVars: currentEnvVars,
			missingVars: [],
		});
	}

	return services;
}

/**
 * Validate services have required env vars
 */
function validateServices(services: Map<string, ServiceEnv>): ServiceEnv[] {
	const violations: ServiceEnv[] = [];

	for (const [name, service] of services) {
		const missing = REQUIRED_ENV_VARS.filter((v) => !service.envVars.has(v));

		if (missing.length > 0) {
			service.missingVars = missing;
			violations.push(service);
		}
	}

	return violations;
}

/**
 * Main function
 */
function main(): number {
	const rootDir = process.cwd();
	const composeFile = path.join(
		rootDir,
		"infra/local/compose/lattice-workers.yml",
	);

	console.log("\n🔍 Compose Validation: Checking telemetry env vars...\n");
	console.log(`Compose file: ${composeFile}`);
	console.log(`Required env vars: ${REQUIRED_ENV_VARS.join(", ")}\n`);

	// Check if file exists
	if (!fs.existsSync(composeFile)) {
		console.log(`⚠️  Compose file not found: ${composeFile}`);
		console.log(`   This is OK if workers haven't been set up yet.\n`);
		return 0;
	}

	// Parse compose file
	const content = fs.readFileSync(composeFile, "utf-8");
	const services = parseComposeFile(content);

	console.log(
		`Found ${services.size} service(s): ${[...services.keys()].join(", ")}\n`,
	);

	// Validate each service
	const violations = validateServices(services);

	if (violations.length === 0) {
		console.log("✅ All services have required telemetry env vars!\n");

		// Show summary
		for (const [name, service] of services) {
			console.log(`   ${name}: ${service.envVars.size} env vars configured`);
		}
		console.log("");
		return 0;
	}

	console.log(
		`❌ Found ${violations.length} service(s) with missing env vars:\n`,
	);

	for (const service of violations) {
		console.log(`📦 ${service.name}`);
		console.log(`   Missing: ${service.missingVars.join(", ")}`);
		console.log(`   Has: ${[...service.envVars].join(", ")}`);
		console.log("");
	}

	console.log(
		`\n💡 Fix: Add the missing env vars to the service's environment section.`,
	);
	console.log("   See docs/telemetry-tags.md for required telemetry tags.\n");

	return 1;
}

// Run
process.exit(main());
