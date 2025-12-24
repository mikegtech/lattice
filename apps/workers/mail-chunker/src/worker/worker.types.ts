import type { MailParsePayload, MailChunkPayload } from '@lattice/core-contracts';

/**
 * Input type for the mail-chunker worker
 */
export type MailChunkerInput = MailParsePayload;

/**
 * Output type for the mail-chunker worker
 * We emit individual chunks as separate messages
 */
export type MailChunkerOutput = MailChunkPayload;
