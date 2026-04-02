/* === VIVENTIUM START ===
 * Purpose: Coverage for Anthropic request-byte guard and overflow detection.
 * === VIVENTIUM END === */

const {
  compactAnthropicMessagesForSize,
  enforceAnthropicInlineDocumentLimits,
  isAnthropicRequestTooLargeError,
  estimateBase64DecodedBytes,
} = require('~/server/services/viventium/anthropicPayloadGuard');

describe('anthropicPayloadGuard', () => {
  test('enforces single-document size limit', () => {
    const documents = [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'A'.repeat(1200),
        },
      },
    ];

    const result = enforceAnthropicInlineDocumentLimits(documents, {
      maxSingleDocumentBytes: 500,
      maxTotalDocumentBytes: 5000,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('single_document_limit');
  });

  test('estimates base64 decoded bytes', () => {
    // "AAAA" decodes to 3 bytes.
    expect(estimateBase64DecodedBytes('AAAA')).toBe(3);
    expect(estimateBase64DecodedBytes('')).toBe(0);
    expect(estimateBase64DecodedBytes(null)).toBe(0);
  });

  test('compacts document blocks when payload exceeds byte budget', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this file' },
          {
            type: 'document',
            context: 'File: "pitch-deck.pdf"',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'A'.repeat(10_000),
            },
          },
        ],
      },
    ];

    const result = compactAnthropicMessagesForSize(messages, {
      maxRequestBytes: 1500,
    });

    expect(result.changed).toBe(true);
    expect(result.docPartsCompacted).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThanOrEqual(1500);
    expect(messages[0].content[1].type).toBe('text');
    expect(messages[0].content[1].text).toContain('Attached document omitted');
  });

  test('truncates oversized tool output in aggressive mode', () => {
    const messages = [
      { role: 'assistant', content: 'working...' },
      { role: 'tool', content: 'x'.repeat(6000) },
    ];

    const result = compactAnthropicMessagesForSize(messages, {
      maxRequestBytes: 1000,
      maxToolMessageChars: 120,
      aggressive: true,
    });

    expect(result.changed).toBe(true);
    expect(result.toolMessagesTruncated).toBeGreaterThan(0);
    expect(messages[1].content).toContain('Truncated to fit Anthropic request size limits');
  });

  test('detects Anthropic request-too-large errors and ignores TPM variants', () => {
    expect(
      isAnthropicRequestTooLargeError({
        status: 413,
        message: '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      }),
    ).toBe(true);

    expect(
      isAnthropicRequestTooLargeError({
        status: 413,
        message: '413 rate limit exceeded: tokens per minute',
      }),
    ).toBe(false);
  });
});
