import { describe, expect, it } from "vitest";
import { matchAlias } from "./elasticsearch.config.js";

describe("matchAlias", () => {
	it("should match exact alias (no wildcard)", () => {
		expect(matchAlias("user@example.com", "user@example.com")).toBe(true);
	});

	it("should be case insensitive", () => {
		expect(matchAlias("User@Example.COM", "user@example.com")).toBe(true);
		expect(matchAlias("user@example.com", "User@Example.COM")).toBe(true);
	});

	it("should match wildcard prefix pattern", () => {
		expect(matchAlias("realty-abc@woodcreek.me", "realty-*@woodcreek.me")).toBe(
			true,
		);
		expect(
			matchAlias("realty-xyz-123@woodcreek.me", "realty-*@woodcreek.me"),
		).toBe(true);
		expect(matchAlias("realty-@woodcreek.me", "realty-*@woodcreek.me")).toBe(
			true,
		);
	});

	it("should not match non-matching aliases", () => {
		expect(matchAlias("other@woodcreek.me", "realty-*@woodcreek.me")).toBe(
			false,
		);
		expect(matchAlias("realty-abc@other.com", "realty-*@woodcreek.me")).toBe(
			false,
		);
		expect(matchAlias("user@example.com", "realty-*@woodcreek.me")).toBe(false);
	});

	it("should match trailing wildcard", () => {
		expect(matchAlias("realty-abc@woodcreek.me", "realty-*")).toBe(true);
		expect(matchAlias("realty-", "realty-*")).toBe(true);
	});

	it("should match leading wildcard", () => {
		expect(matchAlias("user@woodcreek.me", "*@woodcreek.me")).toBe(true);
		expect(matchAlias("anything@woodcreek.me", "*@woodcreek.me")).toBe(true);
	});

	it("should handle empty alias", () => {
		expect(matchAlias("", "realty-*@woodcreek.me")).toBe(false);
		expect(matchAlias("", "*")).toBe(true);
		expect(matchAlias("", "")).toBe(true);
	});
});
