import { createHash } from "crypto";
import type {
	Attachment,
	EmailAddress,
	EmailBody,
	EmailHeaders,
	MailParsePayload,
	MailRawPayload,
} from "@lattice/core-contracts";
import { Injectable } from "@nestjs/common";
import { type AddressObject, simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";

export interface ParseResult {
	payload: MailParsePayload;
	contentHash: string;
}

@Injectable()
export class ParserService {
	async parse(raw: MailRawPayload): Promise<ParseResult> {
		// Decode base64url to buffer
		const buffer = Buffer.from(raw.raw_payload, "base64url");

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

		// Extract attachments
		const attachments: Attachment[] = (parsed.attachments ?? []).map((att) => {
			const attachment: Attachment = {
				attachment_id: uuidv4(),
				filename: att.filename ?? "unnamed",
				mime_type: att.contentType ?? "application/octet-stream",
				size_bytes: att.size ?? 0,
				content_hash: this.calculateHash(att.content),
				extraction_status: "pending",
			};
			return attachment;
		});

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

		return { payload, contentHash };
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
