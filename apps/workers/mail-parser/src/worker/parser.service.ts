import { Injectable } from '@nestjs/common';
import { simpleParser, type AddressObject } from 'mailparser';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  MailRawPayload,
  MailParsePayload,
  EmailAddress,
  EmailHeaders,
  EmailBody,
  Attachment,
} from '@lattice/core-contracts';

export interface ParseResult {
  payload: MailParsePayload;
  contentHash: string;
}

@Injectable()
export class ParserService {
  async parse(raw: MailRawPayload): Promise<ParseResult> {
    // Decode base64url to buffer
    const buffer = Buffer.from(raw.raw_payload, 'base64url');

    // Parse the email
    const parsed = await simpleParser(buffer);

    // Extract addresses
    const from = this.extractAddress(parsed.from);
    const to = this.extractAddresses(parsed.to);
    const cc = this.extractAddresses(parsed.cc);
    const bcc = this.extractAddresses(parsed.bcc);
    const replyTo = parsed.replyTo ? this.extractAddress(parsed.replyTo) : undefined;

    // Extract body
    const textPlain = parsed.text ?? '';
    const textHtml = parsed.html ?? '';
    const textNormalized = this.normalizeText(textPlain || this.stripHtml(textHtml));

    // Calculate content hash
    const contentHash = this.calculateContentHash(
      parsed.subject ?? '',
      textNormalized,
      from.address,
    );

    // Extract attachments
    const attachments = (parsed.attachments ?? []).map((att): Attachment => ({
      attachment_id: uuidv4(),
      filename: att.filename ?? 'unnamed',
      mime_type: att.contentType ?? 'application/octet-stream',
      size_bytes: att.size ?? 0,
      content_hash: this.calculateHash(att.content),
      storage_uri: undefined,
      extracted_text: undefined,
      extraction_status: 'pending',
    }));

    // Build headers
    const headers: EmailHeaders = {
      message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo,
      references: parsed.references
        ? Array.isArray(parsed.references)
          ? parsed.references
          : [parsed.references]
        : undefined,
      subject: parsed.subject ?? '(no subject)',
      from,
      to,
      cc,
      bcc,
      reply_to: replyTo,
      date: (parsed.date ?? new Date()).toISOString(),
    };

    // Build body
    const body: EmailBody = {
      text_plain: textPlain,
      text_html: textHtml,
      text_normalized: textNormalized,
    };

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
      return { address: 'unknown@unknown.com' };
    }
    const first = addr.value[0];
    return {
      name: first?.name,
      address: first?.address ?? 'unknown@unknown.com',
    };
  }

  private extractAddresses(addr: AddressObject | AddressObject[] | undefined): EmailAddress[] {
    if (!addr) return [];

    const addrs = Array.isArray(addr) ? addr : [addr];
    const result: EmailAddress[] = [];

    for (const a of addrs) {
      if (a.value) {
        for (const v of a.value) {
          result.push({
            name: v.name,
            address: v.address ?? 'unknown@unknown.com',
          });
        }
      }
    }

    return result;
  }

  private normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private calculateContentHash(subject: string, body: string, from: string): string {
    const content = `${subject}|${from}|${body}`;
    return createHash('sha256').update(content).digest('hex');
  }

  private calculateHash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }
}
