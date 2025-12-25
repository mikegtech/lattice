#!/usr/bin/env npx tsx
/**
 * Telemetry Lint Script
 *
 * Scans TypeScript code for disallowed high-cardinality tags in metric calls.
 * This script enforces the telemetry tagging policy defined in docs/telemetry-tags.md.
 *
 * Usage: npx tsx tools/scripts/telemetry-lint.ts
 *
 * Exit codes:
 *   0 - No violations found
 *   1 - Violations found (outputs file:line details)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * High-cardinality tags that MUST NOT be used in metrics
 */
const FORBIDDEN_METRIC_TAGS = [
	"account_id",
	"tenant_id",
	"email_id",
	"provider_message_id",
	"chunk_id",
	"trace_id",
	"span_id",
	"message_id",
	"user_id",
];

/**
 * Patterns that indicate metric calls
 * These are the functions where high-cardinality tags are forbidden
 */
const METRIC_CALL_PATTERNS = [
	/\.increment\s*\(/,
	/\.gauge\s*\(/,
	/\.histogram\s*\(/,
	/\.timing\s*\(/,
	/forMetric\s*\(/,
	/telemetry\.increment\s*\(/,
	/telemetry\.gauge\s*\(/,
	/telemetry\.histogram\s*\(/,
	/telemetry\.timing\s*\(/,
	/this\.telemetry\.increment\s*\(/,
	/this\.telemetry\.gauge\s*\(/,
	/this\.telemetry\.histogram\s*\(/,
	/this\.telemetry\.timing\s*\(/,
];

interface Violation {
	file: string;
	line: number;
	column: number;
	tag: string;
	context: string;
}

/**
 * Check if a line contains a metric call
 */
function isMetricCall(line: string): boolean {
	return METRIC_CALL_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Find forbidden tags in a code block
 */
function findForbiddenTags(code: string): { tag: string; column: number }[] {
	const found: { tag: string; column: number }[] = [];

	for (const tag of FORBIDDEN_METRIC_TAGS) {
		// Match patterns like: tag: value, tag : value, "tag": value, 'tag': value
		const patterns = [
			new RegExp(`\\b${tag}\\s*:`, "g"),
			new RegExp(`["']${tag}["']\\s*:`, "g"),
		];

		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(code)) !== null) {
				found.push({ tag, column: match.index });
			}
		}
	}

	return found;
}

/**
 * Scan a file for violations
 */
function scanFile(filePath: string): Violation[] {
	const violations: Violation[] = [];
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n");

	// Track if we're inside a multi-line metric call
	let inMetricCall = false;
	let metricCallStartLine = 0;
	let metricCallBuffer = "";
	let openBraces = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Check if this line starts a metric call
		if (!inMetricCall && isMetricCall(line)) {
			inMetricCall = true;
			metricCallStartLine = lineNum;
			metricCallBuffer = line;

			// Count braces to determine if call spans multiple lines
			openBraces =
				(line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

			// If braces are balanced, process immediately
			if (openBraces <= 0) {
				const forbiddenTags = findForbiddenTags(metricCallBuffer);
				for (const { tag, column } of forbiddenTags) {
					violations.push({
						file: filePath,
						line: lineNum,
						column: column + 1,
						tag,
						context: line.trim().substring(0, 100),
					});
				}
				inMetricCall = false;
				metricCallBuffer = "";
			}
		} else if (inMetricCall) {
			// Continue accumulating the metric call
			metricCallBuffer += "\n" + line;
			openBraces +=
				(line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

			// Check for closing parenthesis or balanced braces
			if (openBraces <= 0 || line.includes(");")) {
				const forbiddenTags = findForbiddenTags(metricCallBuffer);
				for (const { tag } of forbiddenTags) {
					violations.push({
						file: filePath,
						line: metricCallStartLine,
						column: 1,
						tag,
						context: metricCallBuffer.split("\n")[0].trim().substring(0, 100),
					});
				}
				inMetricCall = false;
				metricCallBuffer = "";
			}
		}
	}

	return violations;
}

/**
 * Recursively find TypeScript files
 */
function findTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];

	// Skip node_modules and dist directories
	const skipDirs = ["node_modules", "dist", ".git", "coverage"];

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (!skipDirs.includes(entry.name)) {
				files.push(...findTypeScriptFiles(fullPath));
			}
		} else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		) {
			// Skip test files and declaration files
			if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

/**
 * Main function
 */
function main(): number {
	const rootDir = process.cwd();
	console.log(
		"\n🔍 Telemetry Lint: Scanning for high-cardinality metric tags...\n",
	);
	console.log(`Root directory: ${rootDir}`);
	console.log(`Forbidden tags: ${FORBIDDEN_METRIC_TAGS.join(", ")}\n`);

	// Find all TypeScript files in apps and packages
	const scanDirs = ["apps", "packages"].filter((dir) =>
		fs.existsSync(path.join(rootDir, dir)),
	);

	const allFiles: string[] = [];
	for (const dir of scanDirs) {
		const files = findTypeScriptFiles(path.join(rootDir, dir));
		allFiles.push(...files);
	}

	console.log(`Found ${allFiles.length} TypeScript files to scan\n`);

	// Scan all files
	const allViolations: Violation[] = [];
	for (const file of allFiles) {
		const violations = scanFile(file);
		allViolations.push(...violations);
	}

	// Report results
	if (allViolations.length === 0) {
		console.log("✅ No telemetry violations found!\n");
		return 0;
	}

	console.log(`❌ Found ${allViolations.length} violation(s):\n`);

	// Group by file
	const byFile = new Map<string, Violation[]>();
	for (const v of allViolations) {
		const relativePath = path.relative(rootDir, v.file);
		if (!byFile.has(relativePath)) {
			byFile.set(relativePath, []);
		}
		byFile.get(relativePath)!.push(v);
	}

	// Output violations
	for (const [file, violations] of byFile) {
		console.log(`📁 ${file}`);
		for (const v of violations) {
			console.log(
				`   Line ${v.line}:${v.column} - Forbidden tag "${v.tag}" in metric call`,
			);
			console.log(`   Context: ${v.context}`);
		}
		console.log("");
	}

	console.log(
		"\n💡 Fix: Use forLog() or forTrace() instead of forMetric() for high-cardinality tags.",
	);
	console.log("   See docs/telemetry-tags.md for the full policy.\n");

	return 1;
}

// Run
process.exit(main());
