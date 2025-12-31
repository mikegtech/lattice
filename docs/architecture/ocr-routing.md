# OCR Routing Architecture

## Overview

The OCR routing system enables intelligent handling of attachments that cannot be directly text-extracted. When the mail-extractor encounters PDFs with no embedded text (scanned documents), low-quality text extraction, or image attachments, it routes these to an OCR pipeline for processing.

## Flow Diagram

```
                    +-------------------+
                    |   mail-extractor  |
                    +-------------------+
                            |
            +---------------+---------------+
            |                               |
            v                               v
  [extraction success]             [needs_ocr = true]
            |                               |
            v                               v
+---------------------------+    +-------------------+
| lattice.mail.attachment.  |    | lattice.ocr.      |
| text.v1                   |    | request.v1        |
+---------------------------+    +-------------------+
            |                               |
            v                               v
+---------------------------+    +-------------------+
|  attachment-chunker       |    |    ocr-worker     |
+---------------------------+    |   (future)        |
                                 +-------------------+
                                         |
                                         v
                                 +-------------------+
                                 | lattice.ocr.      |
                                 | result.v1         |
                                 +-------------------+
                                         |
                                         v
                                 +-------------------+
                                 | ocr-result-router |
                                 |   (future)        |
                                 +-------------------+
                                         |
                                         v
                              +---------------------------+
                              | lattice.mail.attachment.  |
                              | text.v1                   |
                              +---------------------------+
                                         |
                                         v
                              +---------------------------+
                              |  attachment-chunker       |
                              +---------------------------+
```

## Kafka Topics

### OCR Pipeline Topics

| Topic | Purpose | Producer | Consumer |
|-------|---------|----------|----------|
| `lattice.ocr.request.v1` | OCR processing requests | mail-extractor | ocr-worker |
| `lattice.ocr.result.v1` | OCR processing results | ocr-worker | ocr-result-router |
| `lattice.dlq.ocr.v1` | Failed OCR processing | ocr-worker | manual review |

### Convergence Topic

| Topic | Purpose | Producers | Consumer |
|-------|---------|-----------|----------|
| `lattice.mail.attachment.text.v1` | Text ready for chunking | mail-extractor, ocr-result-router | attachment-chunker |

## OCR Reasons

The `ocr_reason` field indicates why OCR processing is needed:

| Reason | Description |
|--------|-------------|
| `image_attachment` | Direct image file (JPEG, PNG, TIFF, etc.) |
| `pdf_no_text` | PDF with no embedded text or text < 10 chars |
| `pdf_low_quality_text` | PDF text extraction yielded garbage (low letter ratio, non-printable chars) |
| `unsupported_format` | Format not supported for direct extraction |

## Text Quality Metrics

The extraction service evaluates text quality using these thresholds:

| Metric | Threshold | Description |
|--------|-----------|-------------|
| `MIN_TEXT_LENGTH` | 10 chars | Minimum text length for valid extraction |
| `MIN_PRINTABLE_RATIO` | 0.8 | Ratio of printable ASCII characters |
| `MIN_LETTER_RATIO` | 0.3 | Ratio of letter characters (A-Z, a-z) |

## Message Contracts

### OcrRequestPayload

```typescript
interface OcrRequestPayload {
  request_id: string;           // Unique request ID
  source_domain: "mail" | "property" | "other";
  document_id: string;          // email_id for mail
  part_id: string;              // attachment_id for mail
  object_uri: string;           // S3 URI for content
  content_type: string;         // MIME type
  ocr_reason: OcrReason;        // Why OCR is needed
  language_hint?: string;       // ISO 639-1 code
  priority?: "low" | "normal" | "high";
  correlation?: OcrCorrelation;
  created_at: string;
}
```

### OcrResultPayload

```typescript
interface OcrResultPayload {
  request_id: string;
  source_domain: "mail" | "property" | "other";
  document_id: string;
  part_id: string;
  status: "success" | "failed" | "partial";
  extracted_text?: string;
  extracted_text_length: number;
  ocr_model_id?: string;
  ocr_version?: string;
  confidence?: number;          // 0-1 confidence score
  page_count?: number;
  processing_time_ms?: number;
  error?: string;
  correlation?: OcrCorrelation;
  completed_at: string;
}
```

### AttachmentTextReadyPayload

```typescript
interface AttachmentTextReadyPayload {
  email_id: string;
  attachment_id: string;
  text_source: "extraction" | "ocr";
  text_length: number;
  mime_type: string;
  filename?: string;
  storage_uri?: string;
  text_quality?: {
    confidence?: number;
    source_model?: string;
  };
  ocr_request_id?: string;      // Set if text came from OCR
  ready_at: string;
}
```

## Domain Agnostic Design

The OCR pipeline is designed to be domain-agnostic. While currently used for mail attachments, the same infrastructure can support:

- **Property domain**: Document scans, inspection reports
- **Other domains**: Any future document processing needs

The `source_domain` field in OCR requests allows the ocr-result-router to dispatch results back to the appropriate domain-specific text-ready topic.

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| JSON Schemas | Implemented | `contracts/kafka/ocr/` |
| TypeScript Contracts | Implemented | `packages/core-contracts/src/ocr.ts` |
| Topic Definitions | Implemented | `packages/core-kafka/src/topics.ts` |
| mail-extractor routing | Implemented | Emits to OCR or text-ready topics |
| attachment-chunker | Implemented | Consumes `AttachmentTextReadyPayload` |
| ocr-worker | Planned | Requires OCR library (Tesseract, Google Vision) |
| ocr-result-router | Planned | Routes results to domain-specific topics |

## Future Work

1. **ocr-worker**: Implement OCR processing using Tesseract or cloud OCR (Google Vision, AWS Textract)
2. **ocr-result-router**: Route OCR results back to domain-specific text-ready topics
3. **Priority queue**: Implement priority-based OCR processing
4. **Language detection**: Auto-detect document language for better OCR accuracy
5. **Cost optimization**: Cache OCR results for duplicate documents (by content hash)
