import { Providers, Run, getChatModelClass } from '@librechat/agents';
import { ToolMessage, AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  applyDeclaredProviderTransport,
  createRun,
  extractDiscoveredToolsFromHistory,
} from './run';

/* === VIVENTIUM START ===
 * Regression: capability-declared Chat Completions must beat SDK model-name heuristics.
 * === VIVENTIUM END === */
describe('applyDeclaredProviderTransport', () => {
  it('keeps the exact wire model while preventing SDK model-name heuristics from forcing Responses', () => {
    const wireModel = 'codex-cli:gpt-5.6-sol';
    const clientOptions = applyDeclaredProviderTransport(
      {
        model: wireModel,
        apiKey: 'synthetic-test-key',
        configuration: { baseURL: 'http://127.0.0.1:8766/v1' },
      },
      { mode: 'chat_completions', reasoningEffort: 'medium' },
      Providers.OPENAI,
    );
    const ChatModel = getChatModelClass(Providers.OPENAI);
    const model = new ChatModel(clientOptions as never) as unknown as {
      _useResponsesApi: (options?: unknown) => boolean;
      invocationParams: (options?: unknown) => { model?: string; reasoning_effort?: string };
    };

    expect(model._useResponsesApi()).toBe(false);
    expect(model.invocationParams().model).toBe(wireModel);
    expect(model.invocationParams().reasoning_effort).toBe('medium');
  });

  it('preserves the SDK Responses default when no provider transport is declared', () => {
    const wireModel = 'codex-cli:gpt-5.6-sol';
    const ChatModel = getChatModelClass(Providers.OPENAI);
    const model = new ChatModel(
      applyDeclaredProviderTransport(
        {
          model: wireModel,
          apiKey: 'synthetic-test-key',
        },
        undefined,
        Providers.OPENAI,
      ) as never,
    ) as unknown as {
      _useResponsesApi: (options?: unknown) => boolean;
      invocationParams: (options?: unknown) => { model?: string };
    };

    expect(model._useResponsesApi()).toBe(true);
    expect(model.invocationParams().model).toBe(wireModel);
  });

  it('fails loudly when a non-OpenAI provider declares the Chat Completions transport', () => {
    expect(() =>
      applyDeclaredProviderTransport(
        { model: 'claude-code:opus' },
        { mode: 'chat_completions' },
        Providers.ANTHROPIC,
      ),
    ).toThrow('requires an OpenAI-compatible provider');
  });

  it('consumes the initialized-agent transport contract at Run creation', async () => {
    const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
    try {
      await createRun({
        agents: [
          {
            id: 'agent-transport-linkage',
            provider: Providers.OPENAI,
            endpoint: 'glasshive-harness',
            model: 'codex-cli:gpt-5.6-sol',
            model_parameters: { model: 'codex-cli:gpt-5.6-sol' },
            tools: [],
            maxContextTokens: 200000,
            useLegacyContent: false,
            declaredProviderTransport: {
              mode: 'chat_completions',
              reasoningEffort: 'medium',
            },
          },
        ],
        signal: new AbortController().signal,
      } as never);

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          graphConfig: expect.objectContaining({
            agents: [
              expect.objectContaining({
                clientOptions: expect.objectContaining({
                  provider: Providers.OPENAI,
                  model: 'viventium-chat-completions',
                  useResponsesApi: false,
                  modelKwargs: expect.objectContaining({
                    model: 'codex-cli:gpt-5.6-sol',
                    reasoning_effort: 'medium',
                  }),
                }),
              }),
            ],
          }),
        }),
      );
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe('extractDiscoveredToolsFromHistory', () => {
  it('extracts tool names from tool_search JSON output', () => {
    const toolSearchOutput = JSON.stringify({
      found: 3,
      tools: [
        { name: 'tool_a', score: 1.0 },
        { name: 'tool_b', score: 0.8 },
        { name: 'tool_c', score: 0.5 },
      ],
    });

    const messages = [
      new HumanMessage('Find tools'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'tool_search', args: {} }] }),
      new ToolMessage({ content: toolSearchOutput, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(3);
    expect(discovered.has('tool_a')).toBe(true);
    expect(discovered.has('tool_b')).toBe(true);
    expect(discovered.has('tool_c')).toBe(true);
  });

  it('extracts tool names from legacy tool_search format', () => {
    const legacyOutput = `Found 2 tools:
- tool_x (score: 0.95)
- tool_y (score: 0.80)`;

    const messages = [
      new ToolMessage({ content: legacyOutput, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(2);
    expect(discovered.has('tool_x')).toBe(true);
    expect(discovered.has('tool_y')).toBe(true);
  });

  it('returns empty set when no tool_search messages exist', () => {
    const messages = [new HumanMessage('Hello'), new AIMessage('Hi there!')];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('ignores non-tool_search ToolMessages', () => {
    const messages = [
      new ToolMessage({
        content: '[{"sha": "abc123"}]',
        tool_call_id: 'call_1',
        name: 'list_commits_mcp_github',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('handles multiple tool_search calls in history', () => {
    const firstOutput = JSON.stringify({
      tools: [{ name: 'tool_1' }, { name: 'tool_2' }],
    });
    const secondOutput = JSON.stringify({
      tools: [{ name: 'tool_2' }, { name: 'tool_3' }],
    });

    const messages = [
      new ToolMessage({ content: firstOutput, tool_call_id: 'call_1', name: 'tool_search' }),
      new AIMessage('Using discovered tools'),
      new ToolMessage({ content: secondOutput, tool_call_id: 'call_2', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(3);
    expect(discovered.has('tool_1')).toBe(true);
    expect(discovered.has('tool_2')).toBe(true);
    expect(discovered.has('tool_3')).toBe(true);
  });

  it('handles malformed JSON in tool_search output', () => {
    const messages = [
      new ToolMessage({
        content: 'This is not valid JSON',
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    // Should not throw, just return empty set
    expect(discovered.size).toBe(0);
  });

  it('handles tool_search output with empty tools array', () => {
    const output = JSON.stringify({
      found: 0,
      tools: [],
    });

    const messages = [
      new ToolMessage({ content: output, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('handles non-string content in ToolMessage', () => {
    const messages = [
      new ToolMessage({
        content: [{ type: 'text', text: 'array content' }],
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    // Should handle gracefully
    expect(discovered.size).toBe(0);
  });
});
