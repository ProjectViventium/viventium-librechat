/* === VIVENTIUM START ===
 * Tests: Normalize persisted `type: "text"` blocks (provider-compat)
 *
 * Purpose:
 * - Prevent provider 400s when DB contains OpenAI Assistants-style text objects:
 *     { type: "text", text: { value: "..." } }
 *
 * Added: 2026-02-08
 * === VIVENTIUM END === */

const {
  coerceTextToString,
  normalizeTextContentParts,
  normalizeTextPartsInPayload,
  normalizeProviderKey,
  providerNeedsStrictTextSanitizer,
  sanitizeAnthropicFormattedMessages,
  sanitizeProviderFormattedMessages,
} = require('../normalizeTextContentParts');
const { HumanMessage, coerceMessageLikeToMessage } = require('@langchain/core/messages');
const { formatAgentMessages } = require('@librechat/agents');
const { filterMalformedContentParts } = require('@librechat/api');
const { ContentTypes } = require('librechat-data-provider');

describe('normalizeTextContentParts', () => {
  test('coerceTextToString unwraps { value }', () => {
    expect(coerceTextToString({ value: 'hi' })).toBe('hi');
  });

  test('coerceTextToString unwraps nested { text: { value } }', () => {
    expect(coerceTextToString({ text: { value: 'hi' } })).toBe('hi');
  });

  test('normalizeProviderKey trims and lowercases provider names', () => {
    expect(normalizeProviderKey(' Anthropic ')).toBe('anthropic');
    expect(normalizeProviderKey(null)).toBe('');
  });

  test('normalizeTextContentParts returns original reference when already valid', () => {
    const parts = [{ type: 'text', text: 'hello' }];
    const result = normalizeTextContentParts(parts);
    expect(result).toBe(parts);
  });

  test('normalizeTextContentParts unwraps OpenAI Assistants-style text objects', () => {
    const parts = [{ type: 'text', text: { value: 'hello', annotations: [] } }];
    const result = normalizeTextContentParts(parts);
    expect(result).not.toBe(parts);
    expect(result).toEqual([{ type: 'text', text: 'hello' }]);
    // Ensure we didn't mutate the original input in-place.
    expect(parts[0].text).toEqual({ value: 'hello', annotations: [] });
  });

  test('normalizeTextPartsInPayload unwraps message.content blocks', () => {
    const payload = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: { value: 'world' } },
          { type: 'tool_call', tool_call: { id: '1', name: 'x', args: '{}' } },
        ],
      },
    ];

    const result = normalizeTextPartsInPayload(payload);
    expect(result).not.toBe(payload);
    expect(result[0]).toBe(payload[0]); // unchanged message retains identity
    expect(result[1]).not.toBe(payload[1]); // changed message is copied
    expect(result[1].content[0]).toEqual({ type: 'text', text: 'world' });
    expect(result[1].content[1]).toBe(payload[1].content[1]); // non-text parts preserved by reference
  });

  test('normalizeTextContentParts drops null parts and preserves text strings', () => {
    const parts = [null, 'hello', { type: 'tool_call', tool_call: { id: '1', name: 'x' } }];
    const result = normalizeTextContentParts(parts);
    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_call', tool_call: { id: '1', name: 'x' } },
    ]);
  });

  test('normalizeTextPartsInPayload removes null content entries', () => {
    const payload = [
      {
        role: 'assistant',
        content: [null, { type: 'text', text: 'ok' }],
      },
    ];
    const result = normalizeTextPartsInPayload(payload);
    expect(result[0].content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  test('sanitizeAnthropicFormattedMessages removes null and empty text blocks from arrays', () => {
    const messages = [
      {
        content: [
          null,
          { type: 'text', text: '' },
          { type: 'text', text: '  keep me  ' },
          { type: 'tool_use', id: 'tool-1', name: 'web_search' },
        ],
      },
    ];

    const result = sanitizeAnthropicFormattedMessages(messages);
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].content)).toBe(true);
    expect(result[0].content).toEqual([
      { type: 'text', text: '  keep me  ', [ContentTypes.TEXT]: '  keep me  ' },
      { type: 'tool_use', id: 'tool-1', name: 'web_search' },
    ]);
  });

  test('sanitizeAnthropicFormattedMessages injects non-empty content for tool-call-only message', () => {
    const messages = [
      {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'web_search', args: {} }],
      },
    ];

    const result = sanitizeAnthropicFormattedMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Tool call context.');
  });

  test('sanitizeAnthropicFormattedMessages injects fallback for empty message without tool calls', () => {
    const messages = [{ content: '' }];
    const result = sanitizeAnthropicFormattedMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Context message.');
  });

  test('sanitizeAnthropicFormattedMessages preserves LangChain prototype when a message is rewritten', () => {
    const messages = [
      new HumanMessage({
        content: [{ type: ContentTypes.TEXT, text: { value: 'Hi' } }],
      }),
    ];

    const result = sanitizeAnthropicFormattedMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toBe(messages[0]);
    expect(typeof result[0]._getType).toBe('function');
    expect(typeof result[0].getType).toBe('function');
    expect(result[0]._getType()).toBe('human');
    expect(result[0].content).toEqual([{ type: ContentTypes.TEXT, text: 'Hi', [ContentTypes.TEXT]: 'Hi' }]);
    expect(() => coerceMessageLikeToMessage(result[0])).not.toThrow();
  });

  test('sanitizeAnthropicFormattedMessages keeps unchanged LangChain messages as-is', () => {
    const { messages } = formatAgentMessages([{ role: 'user', content: 'Hi' }], {}, new Set());
    const result = sanitizeAnthropicFormattedMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(messages[0]);
    expect(typeof result[0]._getType).toBe('function');
    expect(() => coerceMessageLikeToMessage(result[0])).not.toThrow();
  });

  test('providerNeedsStrictTextSanitizer defaults to anthropic only', () => {
    expect(providerNeedsStrictTextSanitizer('anthropic')).toBe(true);
    expect(providerNeedsStrictTextSanitizer('google')).toBe(false);
  });

  test('providerNeedsStrictTextSanitizer supports env override', () => {
    process.env.VIVENTIUM_STRICT_TEXT_SANITIZER_PROVIDERS = 'anthropic, google';
    expect(providerNeedsStrictTextSanitizer('google')).toBe(true);
    delete process.env.VIVENTIUM_STRICT_TEXT_SANITIZER_PROVIDERS;
  });

  test('sanitizeProviderFormattedMessages is no-op for providers without strict policy', () => {
    const messages = [{ content: [{ type: ContentTypes.TEXT, text: '' }] }];
    const result = sanitizeProviderFormattedMessages('google', messages);
    expect(result).toBe(messages);
  });

  test('sanitizeProviderFormattedMessages applies strict policy for anthropic', () => {
    const messages = [{ content: [{ type: ContentTypes.TEXT, text: '' }] }];
    const result = sanitizeProviderFormattedMessages('anthropic', messages);
    expect(result).not.toBe(messages);
    expect(result[0].content).toBe('Context message.');
  });

  test('end-to-end pipeline hardens historical null/tool-call content for Anthropic', () => {
    const payload = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          null,
          { type: ContentTypes.THINK, think: 'internal' },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'tool-1', name: 'web_search', args: '{}' },
          },
          { type: ContentTypes.TEXT, text: '' },
        ],
      },
    ];

    const normalized = normalizeTextPartsInPayload(payload).map((message) => {
      if (!Array.isArray(message.content)) {
        return message;
      }
      return {
        ...message,
        content: filterMalformedContentParts(message.content),
      };
    });

    const { messages: formatted } = formatAgentMessages(normalized, {}, new Set(['web_search']));
    const hardened = sanitizeProviderFormattedMessages('anthropic', formatted);

    expect(hardened.length).toBeGreaterThan(0);
    for (const message of hardened) {
      expect(typeof message._getType).toBe('function');
      expect(() => coerceMessageLikeToMessage(message)).not.toThrow();
      if (typeof message.content === 'string') {
        expect(message.content.trim().length).toBeGreaterThan(0);
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === ContentTypes.TEXT) {
            expect(typeof part.text).toBe('string');
            expect(part.text.trim().length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
