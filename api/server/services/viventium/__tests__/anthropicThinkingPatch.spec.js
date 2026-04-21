/* === VIVENTIUM START ===
 * Tests: Anthropic thinking-block runtime patch.
 *
 * Purpose:
 * - Ensure incomplete Anthropic `thinking` blocks are removed or repaired
 *   before `ensureThinkingBlockInMessages()` decides whether a tool chain is
 *   valid for a thinking-enabled continuation.
 * - Prevent Anthropic 400s during tool-follow-up requests while preserving
 *   valid reasoning blocks.
 *
 * Added: 2026-04-21
 * === VIVENTIUM END === */

const {
  sanitizeAnthropicThinkingBlocks,
  sanitizeMessagesForAnthropicThinking,
} = require('../anthropicThinkingPatch');
const { AIMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { Providers, ensureThinkingBlockInMessages } = require('@librechat/agents');

describe('anthropicThinkingPatch', () => {
  test('merges partial Anthropic thinking blocks for the same index into one valid block', () => {
    const content = [
      { type: 'thinking', index: 0, signature: 'sig-' },
      { type: 'thinking', index: 0, thinking: 'plan' },
      { type: 'tool_use', id: 'toolu_1', name: 'file_search', input: {} },
    ];

    expect(sanitizeAnthropicThinkingBlocks(content)).toEqual([
      { type: 'thinking', index: 0, thinking: 'plan', signature: 'sig-' },
      { type: 'tool_use', id: 'toolu_1', name: 'file_search', input: {} },
    ]);
  });

  test('drops incomplete Anthropic thinking blocks so handoff logic can treat the chain as non-thinking', () => {
    const messages = [
      new HumanMessage({ content: 'Recall what we discussed earlier today.' }),
      new AIMessage({
        content: [
          { type: 'thinking', index: 0, signature: 'sig-only' },
          { type: 'tool_use', id: 'toolu_1', name: 'file_search', input: {} },
        ],
        tool_calls: [
          {
            id: 'toolu_1',
            name: 'file_search',
            args: { query: 'earlier today' },
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({
        content: 'Result',
        tool_call_id: 'toolu_1',
      }),
    ];

    const result = ensureThinkingBlockInMessages(
      sanitizeMessagesForAnthropicThinking(messages),
      Providers.ANTHROPIC,
    );

    expect(result[1]).toBeInstanceOf(HumanMessage);
    expect(result[1].content).toContain('[Previous agent context]');
  });

  test('preserves valid Anthropic thinking blocks so genuine thinking turns are not downgraded', () => {
    const messages = [
      new HumanMessage({ content: 'Search and explain.' }),
      new AIMessage({
        content: [
          { type: 'thinking', index: 0, thinking: 'Let me check recall.', signature: 'sig-ok' },
          { type: 'tool_use', id: 'toolu_1', name: 'file_search', input: {} },
        ],
        tool_calls: [
          {
            id: 'toolu_1',
            name: 'file_search',
            args: { query: 'recall' },
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({
        content: 'Result',
        tool_call_id: 'toolu_1',
      }),
    ];

    const result = ensureThinkingBlockInMessages(
      sanitizeMessagesForAnthropicThinking(messages),
      Providers.ANTHROPIC,
    );

    expect(result[1]).toBeInstanceOf(AIMessage);
    expect(result[1].content[0]).toEqual({
      type: 'thinking',
      index: 0,
      thinking: 'Let me check recall.',
      signature: 'sig-ok',
    });
  });
});
