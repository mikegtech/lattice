import { createHash } from "crypto";
import type {
	Attachment,
	EmailAddress,
	EmailBody,
	EmailHeaders,
	ExtractableAttachment,
	MailParsePayload,
	MailRawPayload,
} from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import { type AddressObject, simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";

export interface ParseResult {
	payload: MailParsePayload;
	contentHash: string;
	extractableAttachments: ExtractableAttachment[];
}

export interface EnvelopeContext {
	tenant_id: string;
	account_id: string;
	alias: string;
	provider: string;
}

// MIME types that support text extraction
const EXTRACTABLE_MIME_TYPES = [
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"text/plain",
	"text/csv",
	"text/markdown",
];

@Injectable()
export class ParserService {
	constructor(
		@Inject(STORAGE_SERVICE) private readonly storage: StorageService,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	async parse(
		raw: MailRawPayload,
		envelope: EnvelopeContext,
	): Promise<ParseResult> {
		// ===== CLAIM CHECK PATTERN =====
		let buffer: Buffer;

		if (raw.raw_payload) {
			// Fast path: inline payload (email ≤ 256 KB)
			buffer = Buffer.from(raw.raw_payload, "base64url");
			this.logger.debug("Using inline payload", {
				email_id: raw.email_id,
				size_bytes: buffer.length,
			});
		} else if (raw.raw_object_uri) {
			// Claim check: fetch from object storage (email > 256 KB)
			buffer = await this.storage.getBytes(raw.raw_object_uri);
			this.logger.debug("Fetched from storage", {
				email_id: raw.email_id,
				uri: raw.raw_object_uri,
				size_bytes: buffer.length,
			});
		} else {
			throw new Error(
				`No raw_payload or raw_object_uri provided for email ${raw.email_id}`,
			);
		}

		// Parse the email
		const parsed = await simpleParser(buffer);

		// Extract addresses
		const from = this.extractAddress(parsed.from);
		const to = this.extractAddresses(parsed.to);
		const cc = this.extractAddresses(parsed.cc);
		const bcc = this.extractAddresses(parsed.bcc);
		const replyTo = parsed.replyTo
			? this.extractAddress(parsed.replyTo)
			: undefined;

		// Extract body
		const textPlain = parsed.text ?? "";
		const textHtml = parsed.html ?? "";
		const textNormalized = this.normalizeText(
			textPlain ||
				(typeof textHtml === "string" ? this.stripHtml(textHtml) : ""),
		);

		// Calculate content hash
		const contentHash = this.calculateContentHash(
			parsed.subject ?? "",
			textNormalized,
			from.address,
		);

		// ===== ATTACHMENT STORAGE =====
		const attachments: Attachment[] = [];
		const extractableAttachments: ExtractableAttachment[] = [];

		for (const att of parsed.attachments ?? []) {
			const attachmentId = uuidv4();
			const contentHashAtt = this.calculateHash(att.content);
			const mimeType = att.contentType ?? "application/octet-stream";
			const filename = att.filename ?? "unnamed";
			const sizeBytes = att.size ?? att.content.length;

			// Build storage key for attachment
			const storageKey = this.buildAttachmentKey(
				envelope.tenant_id,
				envelope.account_id,
				envelope.alias,
				envelope.provider,
				raw.provider_message_id,
				attachmentId,
				filename,
			);

			// Store attachment to object storage
			const storageUri = await this.storage.putBytes(
				storageKey,
				att.content,
				mimeType,
			);

			this.logger.debug("Stored attachment", {
				email_id: raw.email_id,
				attachment_id: attachmentId,
				filename,
				mime_type: mimeType,
				size_bytes: sizeBytes,
				storage_uri: storageUri,
			});

			// Determine extraction status
			const extractionStatus = this.getExtractionStatus(mimeType);

			attachments.push({
				attachment_id: attachmentId,
				filename,
				mime_type: mimeType,
				size_bytes: sizeBytes,
				content_hash: contentHashAtt,
				storage_uri: storageUri,
				extraction_status: extractionStatus,
			});

			// Track extractable attachments for downstream processing
			if (extractionStatus === "pending") {
				extractableAttachments.push({
					email_id: raw.email_id,
					attachment_id: attachmentId,
					storage_uri: storageUri,
					mime_type: mimeType,
					filename,
					size_bytes: sizeBytes,
				});
			}
		}

		// Build headers
		const headers: EmailHeaders = {
			subject: parsed.subject ?? "(no subject)",
			from,
			date: (parsed.date ?? new Date()).toISOString(),
		};
		if (parsed.messageId) headers.message_id = parsed.messageId;
		if (parsed.inReplyTo) headers.in_reply_to = parsed.inReplyTo;
		if (parsed.references) {
			headers.references = Array.isArray(parsed.references)
				? parsed.references
				: [parsed.references];
		}
		if (to.length > 0) headers.to = to;
		if (cc.length > 0) headers.cc = cc;
		if (bcc.length > 0) headers.bcc = bcc;
		if (replyTo) headers.reply_to = replyTo;

		// Build body
		const body: EmailBody = {};
		if (textPlain) body.text_plain = textPlain;
		if (typeof textHtml === "string" && textHtml) body.text_html = textHtml;
		if (textNormalized) body.text_normalized = textNormalized;

		// Build payload
		const payload: MailParsePayload = {
			provider_message_id: raw.provider_message_id,
			email_id: raw.email_id,
			thread_id: raw.thread_id,
			content_hash: contentHash,
			headers,
			body,
			attachments,
			parsed_at: new Date().toISOString(),
		};

		return { payload, contentHash, extractableAttachments };
	}

	private getExtractionStatus(
		mimeType: string,
	): "pending" | "success" | "failed" | "unsupported" {
		return EXTRACTABLE_MIME_TYPES.includes(mimeType)
			? "pending"
			: "unsupported";
	}

	private buildAttachmentKey(
		tenantId: string,
		accountId: string,
		alias: string,
		provider: string,
		providerMessageId: string,
		attachmentId: string,
		filename: string,
	): string {
		const safeMsgId = providerMessageId.replace(/[/:]/g, "_");
		const safeAlias = alias.replace(/[/:]/g, "_");
		const safeAttId = attachmentId.replace(/[/:]/g, "_");
		const safeFilename = filename.replace(/\//g, "_");

		return `tenant/${tenantId}/account/${accountId}/alias/${safeAlias}/provider/${provider}/message/${safeMsgId}/attachments/${safeAttId}/${safeFilename}`;
	}

	private extractAddress(addr: AddressObject | undefined): EmailAddress {
		if (!addr || !addr.value || addr.value.length === 0) {
			return { address: "unknown@unknown.com" };
		}
		const first = addr.value[0];
		const result: EmailAddress = {
			address: first?.address ?? "unknown@unknown.com",
		};
		if (first?.name) result.name = first.name;
		return result;
	}

	private extractAddresses(
		addr: AddressObject | AddressObject[] | undefined,
	): EmailAddress[] {
		if (!addr) return [];

		const addrs = Array.isArray(addr) ? addr : [addr];
		const result: EmailAddress[] = [];

		for (const a of addrs) {
			if (a.value) {
				for (const v of a.value) {
					const emailAddr: EmailAddress = {
						address: v.address ?? "unknown@unknown.com",
					};
					if (v.name) emailAddr.name = v.name;
					result.push(emailAddr);
				}
			}
		}

		return result;
	}

	private normalizeText(text: string): string {
		return text
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+/g, " ")
			.trim();
	}

	private stripHtml(html: string): string {
		return html
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/\s+/g, " ")
			.trim();
	}

	private calculateContentHash(
		subject: string,
		body: string,
		from: string,
	): string {
		const content = `${subject}|${from}|${body}`;
		return createHash("sha256").update(content).digest("hex");
	}

	private calculateHash(data: Buffer): string {
		return createHash("sha256").update(data).digest("hex");
	}
}
