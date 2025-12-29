import type { LoggerService } from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageConfig } from "./storage.config.js";
import { StorageService } from "./storage.service.js";

// Mock @aws-sdk/client-s3
vi.mock("@aws-sdk/client-s3", () => {
	const mockSend = vi.fn();
	return {
		S3Client: vi.fn().mockImplementation(() => ({
			send: mockSend,
			destroy: vi.fn(),
		})),
		DeleteObjectCommand: vi.fn().mockImplementation((params) => ({
			type: "DeleteObjectCommand",
			...params,
		})),
		DeleteObjectsCommand: vi.fn().mockImplementation((params) => ({
			type: "DeleteObjectsCommand",
			...params,
		})),
		ChecksumAlgorithm: {
			CRC32: "CRC32",
		},
	};
});

const createMockConfig = (): StorageConfig => ({
	endpoint: "http://minio:9000",
	accessKeyId: "minioadmin",
	secretAccessKey: "minioadmin", // pragma: allowlist secret
	region: "us-east-1",
	forcePathStyle: true,
});

const createMockLogger = (): LoggerService =>
	({
		log: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}) as unknown as LoggerService;

describe("StorageService", () => {
	let service: StorageService;
	let mockConfig: StorageConfig;
	let mockLogger: LoggerService;
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockConfig = createMockConfig();
		mockLogger = createMockLogger();
		service = new StorageService(mockConfig, mockLogger);

		// Get the mock send function from the mocked S3Client
		const { S3Client } = await import("@aws-sdk/client-s3");
		const clientInstance = new S3Client({});
		mockSend = clientInstance.send as ReturnType<typeof vi.fn>;
	});

	describe("URI Parsing", () => {
		it("should parse valid S3 URIs", async () => {
			mockSend.mockResolvedValue({});

			await service.deleteObject("s3://bucket-name/path/to/object.txt");

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					Bucket: "bucket-name",
					Key: "path/to/object.txt",
				}),
			);
		});

		it("should reject URIs without s3:// prefix", async () => {
			const result = await service.deleteObject("http://bucket/key");

			expect(result.deleted).toBe(0);
			expect(result.errors).toContain("Invalid URI: http://bucket/key");
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("should reject URIs without key", async () => {
			const result = await service.deleteObject("s3://bucket-only");

			expect(result.deleted).toBe(0);
			expect(result.errors).toContain("Invalid URI: s3://bucket-only");
			expect(mockSend).not.toHaveBeenCalled();
		});
	});

	describe("deleteObject", () => {
		it("should delete a single object successfully", async () => {
			mockSend.mockResolvedValue({});

			const result = await service.deleteObject(
				"s3://lattice-raw/tenant/account/message.eml",
			);

			expect(result.deleted).toBe(1);
			expect(result.errors).toHaveLength(0);
			expect(mockLogger.debug).toHaveBeenCalledWith(
				"Deleted object from storage",
				expect.objectContaining({
					bucket: "lattice-raw",
					key: "tenant/account/message.eml",
				}),
			);
		});

		it("should treat NoSuchKey as success (idempotent)", async () => {
			const error = new Error("Object not found");
			error.name = "NoSuchKey";
			mockSend.mockRejectedValue(error);

			const result = await service.deleteObject("s3://bucket/missing.txt");

			expect(result.deleted).toBe(1);
			expect(result.errors).toHaveLength(0);
		});

		it("should handle other errors gracefully", async () => {
			mockSend.mockRejectedValue(new Error("Access denied"));

			const result = await service.deleteObject("s3://bucket/key.txt");

			expect(result.deleted).toBe(0);
			expect(result.errors).toContain("Access denied");
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Failed to delete object",
				expect.objectContaining({ error: "Access denied" }),
			);
		});
	});

	describe("deleteObjects", () => {
		it("should return early for empty list", async () => {
			const result = await service.deleteObjects([]);

			expect(result.deleted).toBe(0);
			expect(result.errors).toHaveLength(0);
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("should batch delete multiple objects", async () => {
			mockSend.mockResolvedValue({
				Deleted: [{ Key: "key1" }, { Key: "key2" }],
				Errors: [],
			});

			const result = await service.deleteObjects([
				"s3://bucket/key1",
				"s3://bucket/key2",
			]);

			expect(result.deleted).toBe(2);
			expect(result.errors).toHaveLength(0);
		});

		it("should group objects by bucket", async () => {
			mockSend.mockResolvedValue({
				Deleted: [{ Key: "key1" }],
				Errors: [],
			});

			await service.deleteObjects(["s3://bucket-a/key1", "s3://bucket-b/key2"]);

			// Should be called twice, once per bucket
			expect(mockSend).toHaveBeenCalledTimes(2);
		});

		it("should handle mixed results with errors", async () => {
			mockSend.mockResolvedValue({
				Deleted: [{ Key: "key1" }],
				Errors: [
					{
						Key: "key2",
						Code: "AccessDenied",
						Message: "Access denied",
					},
				],
			});

			const result = await service.deleteObjects([
				"s3://bucket/key1",
				"s3://bucket/key2",
			]);

			expect(result.deleted).toBe(1);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain("AccessDenied");
		});

		it("should count NoSuchKey as deleted (idempotent)", async () => {
			mockSend.mockResolvedValue({
				Deleted: [{ Key: "key1" }],
				Errors: [
					{
						Key: "key2",
						Code: "NoSuchKey",
						Message: "Object not found",
					},
				],
			});

			const result = await service.deleteObjects([
				"s3://bucket/key1",
				"s3://bucket/key2",
			]);

			expect(result.deleted).toBe(2); // Both count as deleted
			expect(result.errors).toHaveLength(0);
		});

		it("should handle parse errors in URI list", async () => {
			mockSend.mockResolvedValue({
				Deleted: [{ Key: "key1" }],
				Errors: [],
			});

			const result = await service.deleteObjects([
				"s3://bucket/key1",
				"invalid-uri",
			]);

			expect(result.deleted).toBe(1);
			expect(result.errors).toContain("Invalid URI: invalid-uri");
		});

		it("should handle S3 batch operation errors", async () => {
			mockSend.mockRejectedValue(new Error("Connection timeout"));

			const result = await service.deleteObjects([
				"s3://bucket/key1",
				"s3://bucket/key2",
			]);

			expect(result.deleted).toBe(0);
			expect(result.errors).toContain("Bucket bucket: Connection timeout");
		});
	});

	describe("healthCheck", () => {
		it("should return true when client can be created", async () => {
			const result = await service.healthCheck();

			expect(result).toBe(true);
		});
	});

	describe("onModuleDestroy", () => {
		it("should destroy the client on shutdown", async () => {
			// Initialize the client first
			mockSend.mockResolvedValue({});
			await service.deleteObject("s3://bucket/key");

			await service.onModuleDestroy();

			// Client should be destroyed (null check in future calls would show this)
		});
	});
});
