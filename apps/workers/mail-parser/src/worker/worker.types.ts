import type { MailParsePayload, MailRawPayload } from "@lattice/core-contracts";

/**
 * Input type for the mail-parser worker
 */
export type MailParserInput = MailRawPayload;

/**
 * Output type for the mail-parser worker
 */
export type MailParserOutput = MailParsePayload;

/**
 * Worker-specific context extensions
 */
export interface MailParserContext {
	/** Provider-specific message ID */
	providerMessageId: string;
	/** Lattice email ID */
	emailId: string;
	/** Account ID */
	accountId: string;
	/** Tenant ID */
	tenantId: string;
}
