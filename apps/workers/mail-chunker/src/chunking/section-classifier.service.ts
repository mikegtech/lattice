import { Injectable } from '@nestjs/common';
import type { SectionType } from '@lattice/core-contracts';

/**
 * Email section classification service.
 * Identifies semantic sections within email body text.
 */
@Injectable()
export class SectionClassifierService {
  /**
   * Common signature indicators
   */
  private readonly SIGNATURE_PATTERNS = [
    /^--\s*$/m,
    /^_{3,}\s*$/m,
    /^best\s*(regards|wishes)?,?\s*$/im,
    /^sincerely,?\s*$/im,
    /^regards,?\s*$/im,
    /^thanks,?\s*$/im,
    /^thank\s+you,?\s*$/im,
    /^cheers,?\s*$/im,
    /^sent\s+from\s+(my\s+)?(iphone|android|mobile)/im,
  ];

  /**
   * Quote indicators
   */
  private readonly QUOTE_PATTERNS = [
    /^>+\s*/m,
    /^On\s+.+wrote:$/im,
    /^From:\s+.+$/im,
    /^-{3,}\s*Original\s+Message\s*-{3,}/im,
    /^-{3,}\s*Forwarded\s+message\s*-{3,}/im,
  ];

  /**
   * Greeting patterns
   */
  private readonly GREETING_PATTERNS = [
    /^(hi|hello|hey|dear|good\s+(morning|afternoon|evening)),?\s*/im,
  ];

  /**
   * Classify a text segment into a section type
   */
  classify(text: string): SectionType {
    const trimmed = text.trim();

    // Check for quoted content
    if (this.isQuotedContent(trimmed)) {
      return 'quote';
    }

    // Check for signature
    if (this.isSignature(trimmed)) {
      return 'signature';
    }

    // Check for greeting (usually at the start)
    if (this.isGreeting(trimmed)) {
      return 'greeting';
    }

    // Default to body
    return 'body';
  }

  /**
   * Check if text appears to be quoted content
   */
  isQuotedContent(text: string): boolean {
    return this.QUOTE_PATTERNS.some((pattern) => pattern.test(text));
  }

  /**
   * Check if text appears to be a signature
   */
  isSignature(text: string): boolean {
    // Short text with signature patterns
    if (text.length < 500) {
      return this.SIGNATURE_PATTERNS.some((pattern) => pattern.test(text));
    }
    return false;
  }

  /**
   * Check if text starts with a greeting
   */
  isGreeting(text: string): boolean {
    // Only first line or short text
    const firstLine = text.split('\n')[0] ?? '';
    return this.GREETING_PATTERNS.some((pattern) => pattern.test(firstLine));
  }

  /**
   * Split email body into sections.
   * Returns sections with their types and positions.
   */
  splitIntoSections(text: string): Array<{ text: string; type: SectionType; startOffset: number }> {
    const sections: Array<{ text: string; type: SectionType; startOffset: number }> = [];
    let currentOffset = 0;

    // Split by common section delimiters
    const parts = this.splitByDelimiters(text);

    for (const part of parts) {
      if (part.trim().length === 0) {
        currentOffset += part.length;
        continue;
      }

      const type = this.classify(part);
      sections.push({
        text: part.trim(),
        type,
        startOffset: currentOffset,
      });

      currentOffset += part.length;
    }

    return sections;
  }

  /**
   * Split text by common email delimiters
   */
  private splitByDelimiters(text: string): string[] {
    // Split on signature delimiters and quote markers
    const delimiterPattern = /(^--\s*$|^_{3,}\s*$|^-{3,}\s*Original\s+Message\s*-{3,}|^On\s+.+wrote:\s*$)/gim;

    const parts: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = delimiterPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      parts.push(match[0]);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : [text];
  }
}
