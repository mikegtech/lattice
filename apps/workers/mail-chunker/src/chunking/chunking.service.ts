import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { LOGGER, type LoggerService } from '@lattice/worker-base';
import type { SectionType, ChunkSourceType } from '@lattice/core-contracts';
import { ChunkingConfig } from './chunking.config.js';
import { TokenizerService } from './tokenizer.service.js';
import { SectionClassifierService } from './section-classifier.service.js';

export interface ChunkInput {
  emailId: string;
  contentHash: string;
  textNormalized: string;
  subject?: string;
  attachments?: Array<{
    attachmentId: string;
    extractedText: string;
  }>;
}

export interface GeneratedChunk {
  chunkId: string;
  chunkHash: string;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
  charCount: number;
  tokenCountEstimate: number;
  sourceType: ChunkSourceType;
  attachmentId?: string;
  sectionType: SectionType;
  chunkingVersion: string;
  normalizationVersion: string;
}

/**
 * Service for chunking email content into embedding-ready segments.
 *
 * Algorithm:
 * 1. Split email into semantic sections (body, quote, signature)
 * 2. Exclude quoted content by default
 * 3. Chunk each section with overlap for context preservation
 * 4. Generate deterministic hashes for deduplication
 */
@Injectable()
export class ChunkingService {
  constructor(
    private readonly config: ChunkingConfig,
    private readonly tokenizer: TokenizerService,
    private readonly classifier: SectionClassifierService,
    @Inject(LOGGER) private readonly logger: LoggerService,
  ) {}

  /**
   * Chunk email content into embedding-ready segments.
   * Returns chunks with deterministic hashes for idempotency.
   */
  chunkEmail(input: ChunkInput): GeneratedChunk[] {
    const allChunks: GeneratedChunk[] = [];

    // Chunk body content
    if (input.textNormalized && input.textNormalized.trim().length > 0) {
      const bodyChunks = this.chunkBody(input.emailId, input.textNormalized);
      allChunks.push(...bodyChunks);
    }

    // Chunk subject as a separate small chunk if present and meaningful
    if (input.subject && input.subject.trim().length > 10) {
      const subjectChunk = this.createSubjectChunk(input.emailId, input.subject);
      if (subjectChunk) {
        allChunks.push(subjectChunk);
      }
    }

    // Chunk attachments
    // TODO: Implement attachment text chunking when extraction pipeline is complete
    if (input.attachments && input.attachments.length > 0) {
      for (const attachment of input.attachments) {
        if (attachment.extractedText && attachment.extractedText.trim().length > 0) {
          const attachmentChunks = this.chunkAttachment(
            input.emailId,
            attachment.attachmentId,
            attachment.extractedText,
          );
          allChunks.push(...attachmentChunks);
        }
      }
    }

    // Update total_chunks for each source
    this.updateTotalChunks(allChunks);

    this.logger.debug('Chunking complete', {
      email_id: input.emailId,
      chunk_count: allChunks.length,
      body_chunks: allChunks.filter((c) => c.sourceType === 'body').length,
      attachment_chunks: allChunks.filter((c) => c.sourceType === 'attachment').length,
    });

    return allChunks;
  }

  /**
   * Chunk email body with section classification
   */
  private chunkBody(emailId: string, text: string): GeneratedChunk[] {
    const chunks: GeneratedChunk[] = [];

    // Split into semantic sections
    const sections = this.classifier.splitIntoSections(text);

    for (const section of sections) {
      // Skip quoted content by default
      if (section.type === 'quote') {
        this.logger.debug('Skipping quoted section', { email_id: emailId });
        continue;
      }

      // Skip very short sections
      if (section.text.length < 20) {
        continue;
      }

      // Chunk the section
      const sectionChunks = this.chunkText(
        emailId,
        section.text,
        'body',
        section.type,
        undefined,
      );
      chunks.push(...sectionChunks);
    }

    return chunks;
  }

  /**
   * Create a subject chunk
   */
  private createSubjectChunk(emailId: string, subject: string): GeneratedChunk | null {
    const trimmed = subject.trim();
    if (trimmed.length < 5) return null;

    const chunkId = uuidv4();
    const chunkHash = this.calculateChunkHash(trimmed);
    const tokenEstimate = this.tokenizer.estimateTokens(trimmed);

    return {
      chunkId,
      chunkHash,
      chunkIndex: 0,
      totalChunks: 1,
      chunkText: trimmed,
      charCount: trimmed.length,
      tokenCountEstimate: tokenEstimate,
      sourceType: 'subject',
      sectionType: 'header',
      chunkingVersion: this.config.chunkingVersion,
      normalizationVersion: this.config.normalizationVersion,
    };
  }

  /**
   * Chunk attachment text
   */
  private chunkAttachment(
    emailId: string,
    attachmentId: string,
    text: string,
  ): GeneratedChunk[] {
    return this.chunkText(emailId, text, 'attachment', 'attachment_text', attachmentId);
  }

  /**
   * Core chunking algorithm with overlap
   */
  private chunkText(
    emailId: string,
    text: string,
    sourceType: ChunkSourceType,
    sectionType: SectionType,
    attachmentId?: string,
  ): GeneratedChunk[] {
    const chunks: GeneratedChunk[] = [];
    let remaining = text;
    let chunkIndex = 0;

    while (remaining.length > 0) {
      // Calculate target size
      const tokenEstimate = this.tokenizer.estimateTokens(remaining);

      if (tokenEstimate <= this.config.maxTokens) {
        // Remaining text fits in one chunk
        const chunk = this.createChunk(
          remaining,
          chunkIndex,
          sourceType,
          sectionType,
          attachmentId,
        );
        chunks.push(chunk);
        break;
      }

      // Split at target boundary
      const { chunk: chunkText, remaining: rest } = this.tokenizer.splitAtTokenBoundary(
        remaining,
        this.config.targetTokens,
      );

      if (chunkText.length === 0) {
        // Couldn't split, take what we can
        const forcedSplit = remaining.substring(
          0,
          this.tokenizer.tokensToChars(this.config.maxTokens),
        );
        const chunk = this.createChunk(
          forcedSplit.trim(),
          chunkIndex,
          sourceType,
          sectionType,
          attachmentId,
        );
        chunks.push(chunk);
        remaining = remaining.substring(forcedSplit.length).trim();
      } else {
        const chunk = this.createChunk(
          chunkText,
          chunkIndex,
          sourceType,
          sectionType,
          attachmentId,
        );
        chunks.push(chunk);

        // Apply overlap - take last N tokens from current chunk and prepend to remaining
        if (rest.length > 0 && this.config.overlapTokens > 0) {
          const overlapChars = this.tokenizer.tokensToChars(this.config.overlapTokens);
          const overlap = chunkText.slice(-overlapChars);
          remaining = overlap + ' ' + rest;
        } else {
          remaining = rest;
        }
      }

      chunkIndex++;

      // Safety limit to prevent infinite loops
      if (chunkIndex > 1000) {
        this.logger.warn('Chunk limit reached', { email_id: emailId, chunk_index: chunkIndex });
        break;
      }
    }

    return chunks;
  }

  /**
   * Create a chunk object
   */
  private createChunk(
    text: string,
    index: number,
    sourceType: ChunkSourceType,
    sectionType: SectionType,
    attachmentId?: string,
  ): GeneratedChunk {
    const chunkId = uuidv4();
    const chunkHash = this.calculateChunkHash(text);
    const tokenEstimate = this.tokenizer.estimateTokens(text);

    return {
      chunkId,
      chunkHash,
      chunkIndex: index,
      totalChunks: 0, // Updated later
      chunkText: text,
      charCount: text.length,
      tokenCountEstimate: tokenEstimate,
      sourceType,
      sectionType,
      attachmentId,
      chunkingVersion: this.config.chunkingVersion,
      normalizationVersion: this.config.normalizationVersion,
    };
  }

  /**
   * Calculate deterministic chunk hash for deduplication.
   * Hash includes text + versions to ensure different algorithm versions produce different hashes.
   */
  calculateChunkHash(text: string): string {
    const content = [
      text,
      this.config.normalizationVersion,
      this.config.chunkingVersion,
    ].join('|');

    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Update totalChunks for each source type group
   */
  private updateTotalChunks(chunks: GeneratedChunk[]): void {
    // Group by source type and attachment ID
    const groups = new Map<string, GeneratedChunk[]>();

    for (const chunk of chunks) {
      const key = chunk.attachmentId
        ? `${chunk.sourceType}:${chunk.attachmentId}`
        : chunk.sourceType;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(chunk);
    }

    // Update total counts
    for (const group of groups.values()) {
      const total = group.length;
      for (const chunk of group) {
        chunk.totalChunks = total;
      }
    }
  }
}
