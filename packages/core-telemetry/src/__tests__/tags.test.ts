import { describe, expect, it } from "vitest";
import {
	ALLOWED_METRIC_KEYS,
	APPROVED_METRIC_DIMENSIONS,
	HIGH_CARDINALITY_TAGS,
	HighCardinalityMetricError,
	OPTIONAL_TAGS,
	REQUIRED_TAGS,
	createTagBuilder,
	isAllowedMetricKey,
	isHighCardinality,
	sanitizeTagValue,
	validateMetricTags,
	validateTags,
} from "../tags.js";

describe("tags", () => {
	describe("constants", () => {
		it("should have required tags: env, service, version", () => {
			expect(REQUIRED_TAGS).toContain("env");
			expect(REQUIRED_TAGS).toContain("service");
			expect(REQUIRED_TAGS).toContain("version");
		});

		it("should have optional tags for context", () => {
			expect(OPTIONAL_TAGS).toContain("team");
			expect(OPTIONAL_TAGS).toContain("cloud");
			expect(OPTIONAL_TAGS).toContain("region");
			expect(OPTIONAL_TAGS).toContain("domain");
			expect(OPTIONAL_TAGS).toContain("pipeline");
			expect(OPTIONAL_TAGS).toContain("stage");
		});

		it("should have approved metric dimensions", () => {
			expect(APPROVED_METRIC_DIMENSIONS).toContain("error_code");
			expect(APPROVED_METRIC_DIMENSIONS).toContain("reason");
			expect(APPROVED_METRIC_DIMENSIONS).toContain("status");
			expect(APPROVED_METRIC_DIMENSIONS).toContain("operation");
			expect(APPROVED_METRIC_DIMENSIONS).toContain("topic");
		});

		it("should have high-cardinality tags that are forbidden in metrics", () => {
			expect(HIGH_CARDINALITY_TAGS).toContain("account_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("tenant_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("email_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("provider_message_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("chunk_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("trace_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("span_id");
			expect(HIGH_CARDINALITY_TAGS).toContain("message_id");
		});

		it("should have ALLOWED_METRIC_KEYS combining required, optional, and dimensions", () => {
			// Required tags
			expect(ALLOWED_METRIC_KEYS).toContain("env");
			expect(ALLOWED_METRIC_KEYS).toContain("service");
			expect(ALLOWED_METRIC_KEYS).toContain("version");
			// Optional tags
			expect(ALLOWED_METRIC_KEYS).toContain("stage");
			// Approved dimensions
			expect(ALLOWED_METRIC_KEYS).toContain("error_code");
			expect(ALLOWED_METRIC_KEYS).toContain("reason");
		});
	});

	describe("validateTags", () => {
		it("should pass when all required tags are present", () => {
			const tags = { env: "dev", service: "test", version: "1.0.0" };
			expect(() => validateTags(tags, "test")).not.toThrow();
		});

		it("should throw when env is missing", () => {
			const tags = { service: "test", version: "1.0.0" };
			expect(() => validateTags(tags, "test")).toThrow(
				"Missing required tags in test: env",
			);
		});

		it("should throw when service is missing", () => {
			const tags = { env: "dev", version: "1.0.0" };
			expect(() => validateTags(tags, "test")).toThrow(
				"Missing required tags in test: service",
			);
		});

		it("should throw when version is missing", () => {
			const tags = { env: "dev", service: "test" };
			expect(() => validateTags(tags, "test")).toThrow(
				"Missing required tags in test: version",
			);
		});

		it("should throw when multiple required tags are missing", () => {
			const tags = { service: "test" };
			expect(() => validateTags(tags, "test")).toThrow(/env/);
			expect(() => validateTags(tags, "test")).toThrow(/version/);
		});
	});

	describe("validateMetricTags", () => {
		it("should pass when no high-cardinality tags are present", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				stage: "parse",
				error_code: "E001",
			};
			expect(() => validateMetricTags(tags)).not.toThrow();
		});

		it("should throw HighCardinalityMetricError when account_id is present", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				account_id: "123",
			};
			expect(() => validateMetricTags(tags)).toThrow(
				HighCardinalityMetricError,
			);
			expect(() => validateMetricTags(tags)).toThrow(/account_id/);
		});

		it("should throw HighCardinalityMetricError when email_id is present", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				email_id: "uuid-123",
			};
			expect(() => validateMetricTags(tags)).toThrow(
				HighCardinalityMetricError,
			);
			expect(() => validateMetricTags(tags)).toThrow(/email_id/);
		});

		it("should throw HighCardinalityMetricError when trace_id is present", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				trace_id: "abc123",
			};
			expect(() => validateMetricTags(tags)).toThrow(
				HighCardinalityMetricError,
			);
			expect(() => validateMetricTags(tags)).toThrow(/trace_id/);
		});

		it("should throw with multiple forbidden keys listed", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				account_id: "123",
				email_id: "uuid-123",
				tenant_id: "tenant-1",
			};
			expect(() => validateMetricTags(tags)).toThrow(/account_id/);
			expect(() => validateMetricTags(tags)).toThrow(/email_id/);
			expect(() => validateMetricTags(tags)).toThrow(/tenant_id/);
		});

		it("should include context in error message when provided", () => {
			const tags = {
				env: "dev",
				service: "test",
				version: "1.0.0",
				email_id: "uuid",
			};
			expect(() => validateMetricTags(tags, "myContext")).toThrow(/myContext/);
		});
	});

	describe("isHighCardinality", () => {
		it("should return true for high-cardinality tags", () => {
			expect(isHighCardinality("account_id")).toBe(true);
			expect(isHighCardinality("tenant_id")).toBe(true);
			expect(isHighCardinality("email_id")).toBe(true);
			expect(isHighCardinality("provider_message_id")).toBe(true);
			expect(isHighCardinality("chunk_id")).toBe(true);
			expect(isHighCardinality("trace_id")).toBe(true);
			expect(isHighCardinality("span_id")).toBe(true);
			expect(isHighCardinality("message_id")).toBe(true);
		});

		it("should return false for low-cardinality tags", () => {
			expect(isHighCardinality("env")).toBe(false);
			expect(isHighCardinality("service")).toBe(false);
			expect(isHighCardinality("version")).toBe(false);
			expect(isHighCardinality("stage")).toBe(false);
			expect(isHighCardinality("error_code")).toBe(false);
			expect(isHighCardinality("reason")).toBe(false);
		});
	});

	describe("isAllowedMetricKey", () => {
		it("should return true for required tags", () => {
			expect(isAllowedMetricKey("env")).toBe(true);
			expect(isAllowedMetricKey("service")).toBe(true);
			expect(isAllowedMetricKey("version")).toBe(true);
		});

		it("should return true for optional tags", () => {
			expect(isAllowedMetricKey("team")).toBe(true);
			expect(isAllowedMetricKey("stage")).toBe(true);
			expect(isAllowedMetricKey("domain")).toBe(true);
		});

		it("should return true for approved metric dimensions", () => {
			expect(isAllowedMetricKey("error_code")).toBe(true);
			expect(isAllowedMetricKey("reason")).toBe(true);
			expect(isAllowedMetricKey("status")).toBe(true);
		});

		it("should return false for high-cardinality tags", () => {
			expect(isAllowedMetricKey("account_id")).toBe(false);
			expect(isAllowedMetricKey("email_id")).toBe(false);
			expect(isAllowedMetricKey("trace_id")).toBe(false);
		});
	});

	describe("sanitizeTagValue", () => {
		it("should lowercase values", () => {
			expect(sanitizeTagValue("HelloWorld")).toBe("helloworld");
		});

		it("should replace special chars with underscores", () => {
			expect(sanitizeTagValue("hello world")).toBe("hello_world");
			expect(sanitizeTagValue("foo@bar")).toBe("foo_bar");
		});

		it("should allow hyphens and dots", () => {
			expect(sanitizeTagValue("hello-world.test")).toBe("hello-world.test");
		});

		it("should truncate to 200 chars", () => {
			const longValue = "a".repeat(250);
			expect(sanitizeTagValue(longValue).length).toBe(200);
		});
	});

	describe("createTagBuilder", () => {
		const mockIdentity = {
			name: "test-service",
			version: "1.0.0",
			team: "platform",
			cloud: "gcp",
			region: "us-central1",
			domain: "mail",
			pipeline: "mail-indexing",
		};

		describe("getServiceTags", () => {
			it("should return base service tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.getServiceTags();
				expect(tags.env).toBe("dev");
				expect(tags.service).toBe("test-service");
				expect(tags.version).toBe("1.0.0");
				expect(tags.team).toBe("platform");
			});
		});

		describe("forMetric", () => {
			it("should return valid metric tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forMetric({ stage: "parse" });
				expect(tags.env).toBe("dev");
				expect(tags.service).toBe("test-service");
				expect(tags.stage).toBe("parse");
			});

			it("should allow approved metric dimensions", () => {
				const builder = createTagBuilder(mockIdentity);
				expect(() =>
					builder.forMetric({ error_code: "E001", reason: "timeout" }),
				).not.toThrow();
			});

			it("should throw when high-cardinality tag is passed", () => {
				const builder = createTagBuilder(mockIdentity);
				// TypeScript won't allow this, but we test runtime behavior
				expect(() =>
					builder.forMetric({ email_id: "uuid-123" } as Record<string, string>),
				).toThrow(HighCardinalityMetricError);
			});

			it("should throw when account_id is passed", () => {
				const builder = createTagBuilder(mockIdentity);
				expect(() =>
					builder.forMetric({ account_id: "123" } as Record<string, string>),
				).toThrow(HighCardinalityMetricError);
			});
		});

		describe("forLog", () => {
			it("should allow high-cardinality tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forLog({
					email_id: "uuid-123",
					account_id: "acc-123",
					trace_id: "trace-abc",
				});
				expect(tags.email_id).toBe("uuid-123");
				expect(tags.account_id).toBe("acc-123");
				expect(tags.trace_id).toBe("trace-abc");
			});

			it("should include base service tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forLog({ email_id: "uuid-123" });
				expect(tags.env).toBe("dev");
				expect(tags.service).toBe("test-service");
			});
		});

		describe("forTrace", () => {
			it("should allow high-cardinality tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forTrace({
					email_id: "uuid-123",
					span_id: "span-123",
				});
				expect(tags.email_id).toBe("uuid-123");
				expect(tags.span_id).toBe("span-123");
			});

			it("should include base service tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forTrace({});
				expect(tags.env).toBe("dev");
				expect(tags.service).toBe("test-service");
				expect(tags.version).toBe("1.0.0");
			});
		});

		describe("forStage", () => {
			it("should set stage tag", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forStage("chunk");
				expect(tags.stage).toBe("chunk");
			});

			it("should allow high-cardinality extra tags", () => {
				const builder = createTagBuilder(mockIdentity);
				const tags = builder.forStage("chunk", { email_id: "uuid" });
				expect(tags.stage).toBe("chunk");
				expect(tags.email_id).toBe("uuid");
			});
		});
	});

	describe("HighCardinalityMetricError", () => {
		it("should have correct name", () => {
			const error = new HighCardinalityMetricError(["email_id"]);
			expect(error.name).toBe("HighCardinalityMetricError");
		});

		it("should include forbidden keys", () => {
			const error = new HighCardinalityMetricError(["email_id", "account_id"]);
			expect(error.forbiddenKeys).toEqual(["email_id", "account_id"]);
		});

		it("should have helpful message", () => {
			const error = new HighCardinalityMetricError(["email_id"]);
			expect(error.message).toContain("email_id");
			expect(error.message).toContain("High-cardinality");
			expect(error.message).toContain("forLog()");
		});
	});
});
