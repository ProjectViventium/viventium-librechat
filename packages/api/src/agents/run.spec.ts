// VIVENTIUM START: verify Viventium graph routing, fallback, and handoff contracts.
import { ToolMessage, AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { MultiAgentGraph, Providers, Run } from '@librechat/agents';
import { installUnifiedSchemaToolBindingPatch } from '../../../../api/server/services/viventium/agentSchemaToolBindingPatch';
import {
  createRun,
  extractDiscoveredToolsFromHistory,
  projectGraphLlmFallbacks,
  requestBodyForAgent,
} from './run';

installUnifiedSchemaToolBindingPatch();

describe('requestBodyForAgent', () => {
  it('selects a stable agent-scoped GlassHive key while preserving the primary key', () => {
    const requestBody = {
      viventiumGlassHiveIdempotencyKey: 'main:response-1',
      viventiumGlassHiveAgentIdempotencyKeys: {
        main: 'main:response-1',
        reality: 'main:reality:response-1',
      },
    } as never;

    expect(requestBodyForAgent(requestBody, 'main')).toMatchObject({
      viventiumGlassHiveIdempotencyKey: 'main:response-1',
    });
    expect(requestBodyForAgent(requestBody, 'reality')).toMatchObject({
      viventiumGlassHiveIdempotencyKey: 'main:reality:response-1',
    });
    expect(requestBodyForAgent(requestBody, 'reality')).toEqual(
      requestBodyForAgent(requestBody, 'reality'),
    );
  });
});
// VIVENTIUM END

describe('projectGraphLlmFallbacks', () => {
  it('projects an initialized participant fallback with that participant request identity', async () => {
    const capabilityRefresh = jest.fn(async () => ({
      attached: true,
      defaultHeaders: {
        'X-GlassHive-Idempotency-Key': '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVEIDEMPOTENCYKEY}}',
        'X-GlassHive-Bootstrap-Timestamp': 'fresh-timestamp',
      },
      instructionAppend: 'Fresh signed capability boundary.',
    }));
    const fallbackRoutes = [
      {
        id: 'red',
        endpoint: 'glasshive-harness',
        provider: 'openAI',
        model_parameters: {
          model: 'synthetic-fallback-model',
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Idempotency-Key': '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVEIDEMPOTENCYKEY}}',
            },
          },
        },
        viventiumConversationProviderInstructionAppend:
          'Synthetic signed capability boundary for this fallback route.',
        viventiumConversationProviderCapabilityRefresh: capabilityRefresh,
      },
    ] as never;
    const requestBody = {
      viventiumGlassHiveIdempotencyKey: 'main:response-1',
      viventiumGlassHiveAgentIdempotencyKeys: {
        red: 'main:red:response-1',
      },
    };

    const projected = projectGraphLlmFallbacks({
      routes: fallbackRoutes,
      agentId: 'red',
      requestBody: requestBody as never,
      user: { id: 'user-synthetic' } as never,
      streaming: true,
      streamUsage: true,
    });

    expect(projected).toEqual([
      {
        provider: Providers.OPENAI,
        clientOptions: expect.objectContaining({
          model: 'synthetic-fallback-model',
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Idempotency-Key': 'main:red:response-1',
            },
          },
        }),
      },
    ]);
    expect(requestBody.viventiumGlassHiveIdempotencyKey).toBe('main:response-1');
    expect(
      projected[0].clientOptions[
        Symbol.for('viventium.agent.graph.fallback.runtime.context.v1') as never
      ],
    ).toEqual({
      endpoint: 'glasshive-harness',
      model: 'synthetic-fallback-model',
      provider: Providers.OPENAI,
      reasoningKey: 'reasoning_content',
      systemInstructionAppend: 'Synthetic signed capability boundary for this fallback route.',
    });
    const clientOptions = projected[0].clientOptions as unknown as Record<PropertyKey, unknown>;
    const refreshSymbol = Symbol.for('viventium.agent.model.route.capability.refresh.v1');
    const projectedRefresh = clientOptions[refreshSymbol] as () => Promise<{
      defaultHeaders: Record<string, string>;
      instructionAppend: string;
    }>;
    expect(Object.getOwnPropertyDescriptor(clientOptions, refreshSymbol)).toMatchObject({
      enumerable: false,
      writable: false,
    });
    await expect(projectedRefresh()).resolves.toMatchObject({
      instructionAppend: 'Fresh signed capability boundary.',
      defaultHeaders: {
        'X-GlassHive-Idempotency-Key': 'main:red:response-1',
        'X-GlassHive-Bootstrap-Timestamp': 'fresh-timestamp',
      },
    });
    expect(capabilityRefresh).toHaveBeenCalledTimes(1);
    expect(capabilityRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        viventiumGlassHiveIdempotencyKey: 'main:red:response-1',
      }),
    );
    expect(JSON.stringify(projected[0])).not.toContain('CapabilityRefresh');
  });

  it('applies the same Anthropic and stream-usage normalization as a primary participant', () => {
    const projected = projectGraphLlmFallbacks({
      routes: [
        {
          id: 'specialist',
          endpoint: 'anthropic',
          provider: 'anthropic',
          model_parameters: {
            model: 'synthetic-anthropic-model',
            thinking: false,
            thinkingBudget: 4096,
            thinkingLevel: 'high',
            effort: 'high',
          },
        },
      ] as never,
      agentId: 'specialist',
      streaming: true,
      streamUsage: false,
    });

    expect(projected[0]).toEqual({
      provider: Providers.ANTHROPIC,
      clientOptions: {
        provider: Providers.ANTHROPIC,
        streaming: true,
        streamUsage: false,
        model: 'synthetic-anthropic-model',
      },
    });
  });

  it('places the hidden initialized routes on the owning Agent Builder graph participant', async () => {
    const createSpy = jest.spyOn(Run, 'create').mockReturnValue({ synthetic: true } as never);
    const abortController = new AbortController();

    await createRun({
      agents: [
        {
          id: 'red',
          provider: 'openAI',
          endpoint: 'openAI',
          model_parameters: { model: 'synthetic-red-primary-model' },
          edges: [],
          viventiumGraphLlmFallbacks: [
            {
              id: 'red',
              provider: 'openAI',
              endpoint: 'glasshive-harness',
              model_parameters: {
                model: 'synthetic-red-fallback-model',
                configuration: {
                  defaultHeaders: {
                    'X-GlassHive-Idempotency-Key':
                      '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVEIDEMPOTENCYKEY}}',
                  },
                },
              },
            },
          ],
        },
      ] as never,
      signal: abortController.signal,
      requestBody: {
        viventiumGlassHiveAgentIdempotencyKeys: { red: 'main:red:response-2' },
      } as never,
      customHandlers: {},
      indexTokenCountMap: {},
      tokenCounter: jest.fn(),
    });

    const graphAgent = createSpy.mock.calls[0]?.[0].graphConfig.agents[0];
    expect(graphAgent.agentId).toBe('red');
    expect(graphAgent.clientOptions.fallbacks).toEqual([
      {
        provider: Providers.OPENAI,
        clientOptions: expect.objectContaining({
          model: 'synthetic-red-fallback-model',
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Idempotency-Key': 'main:red:response-2',
            },
          },
        }),
      },
    ]);
    createSpy.mockRestore();
  });

  it('keeps initialization-time authority out of the real system pipe and injects only refreshed truth', async () => {
    const oldAuthority = 'Old authorized capability claim.';
    const unavailableAuthority = 'The host capability broker is unavailable for this run.';
    const capabilityRefresh = jest.fn(async () => ({
      attached: false,
      defaultHeaders: {},
      previousInstructionAppend: oldAuthority,
      instructionAppend: unavailableAuthority,
    }));
    const run = await createRun({
      runId: 'synthetic-primary-authority-refresh-run',
      agents: [
        {
          id: 'main',
          provider: 'openAI',
          endpoint: 'glasshive-harness',
          instructions: `Stable Main instructions.\n\n${oldAuthority}`,
          viventiumConversationProviderInstructionAppend: oldAuthority,
          viventiumConversationProviderCapabilityRefresh: capabilityRefresh,
          model_parameters: { model: 'synthetic-main-model' },
          edges: [],
        },
      ] as never,
      signal: new AbortController().signal,
      customHandlers: {},
      indexTokenCountMap: {},
    });
    const graph = run.Graph as MultiAgentGraph;
    const observedSystemMessages: string[] = [];
    graph.initializeModel = (() =>
      RunnableLambda.from(async (messages: Array<{ getType(): string; content: unknown }>) => {
        observedSystemMessages.push(
          messages
            .filter((message) => message.getType() === 'system')
            .map((message) => String(message.content))
            .join('\n'),
        );
        return new AIMessageChunk({ content: 'Synthetic answer.' });
      })) as never;

    await run.processStream(
      { messages: [new HumanMessage('Use only current capability truth.')] },
      {
        version: 'v2',
        recursionLimit: 4,
        configurable: { thread_id: 'synthetic-primary-authority-refresh-thread' },
      },
    );

    expect(capabilityRefresh).toHaveBeenCalledTimes(1);
    expect(observedSystemMessages[0]).toContain('Stable Main instructions.');
    expect(observedSystemMessages[0]).toContain(unavailableAuthority);
    expect(observedSystemMessages[0]).not.toContain(oldAuthority);
  });

  it('clears a prior participant fallback receipt before the same Run serves a healthy turn', async () => {
    const abortController = new AbortController();
    const run = await createRun({
      runId: 'synthetic-fallback-reentry-run',
      agents: [
        {
          id: 'main',
          provider: 'openAI',
          endpoint: 'openAI',
          model_parameters: { model: 'synthetic-primary-model' },
          viventiumGraphLlmFallbacks: [
            {
              id: 'main',
              provider: 'openAI',
              endpoint: 'glasshive-harness',
              model_parameters: {
                model: 'synthetic-fallback-model',
                apiKey: 'synthetic-test-key',
                configuration: { baseURL: 'https://synthetic.invalid/v1' },
              },
            },
          ],
          edges: [],
        },
      ] as never,
      signal: abortController.signal,
      customHandlers: {},
      indexTokenCountMap: {},
    });
    const graph = run.Graph as MultiAgentGraph;
    let invocationCount = 0;
    const scriptedModel = {
      async *stream() {
        invocationCount += 1;
        if (invocationCount === 1) {
          throw Object.assign(new Error('synthetic first-turn rate limit'), { status: 429 });
        }
        if (invocationCount === 2) {
          yield new AIMessageChunk({ content: 'First turn recovered.' });
          return;
        }
        yield new AIMessageChunk({ content: 'Second turn used the healthy primary.' });
      },
    };
    const process = (threadId: string, message: string) =>
      run.processStream(
        { messages: [new HumanMessage(message)] },
        {
          version: 'v2',
          recursionLimit: 4,
          configurable: { thread_id: threadId, requestBody: {} },
        },
      );

    graph.overrideModel = scriptedModel as never;
    await process('synthetic-fallback-reentry-thread-1', 'First turn.');
    expect(graph.viventiumGraphFallbackRecoveryReceipt).toEqual({
      provider: Providers.OPENAI,
      model: 'synthetic-fallback-model',
    });

    graph.overrideModel = scriptedModel as never;
    await process('synthetic-fallback-reentry-thread-2', 'Second healthy turn.');
    expect(invocationCount).toBe(3);
    expect(graph.viventiumGraphFallbackRecoveryReceipt).toBeUndefined();
  });
});

describe('zero-input graph handoffs', () => {
  it('creates transfer tools with no manual context payload schema', () => {
    const graph = new MultiAgentGraph({
      runId: 'synthetic-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
        {
          agentId: 'reality',
          name: 'Reality',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
      ],
      edges: [
        {
          from: 'main',
          to: 'reality',
          edgeType: 'handoff',
          description: 'Consult the evidence specialist using shared graph state.',
        },
      ],
    });

    const [transferTool] = graph.agentContexts.get('main')?.graphTools ?? [];
    expect(transferTool?.name).toBe('lc_transfer_to_reality');
    expect(transferTool?.schema).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('executes a provider-format tool call, returns through shared graph state, and leaves Main final', async () => {
    const graph = new MultiAgentGraph({
      runId: 'synthetic-provider-bridge-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
        {
          agentId: 'specialist',
          name: 'Specialist',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
      ],
      edges: [
        {
          from: 'main',
          to: 'specialist',
          edgeType: 'handoff',
          description: 'Consult the specialist using shared graph state.',
        },
        {
          from: 'specialist',
          to: 'main',
          edgeType: 'handoff',
          description: 'Return the result to Main using shared graph state.',
        },
      ],
    });
    const calls: string[] = [];
    const scriptedProviderModel = {
      async *stream() {
        if (calls.length === 0) {
          calls.push('main-transfer');
          yield new AIMessageChunk({
            content: '',
            tool_call_chunks: [
              {
                id: 'call-main-specialist',
                name: 'lc_transfer_to_specialist',
                args: '{}',
                index: 0,
                type: 'tool_call_chunk',
              },
            ],
          });
          return;
        }
        if (calls.length === 1) {
          calls.push('specialist-return');
          yield new AIMessageChunk({
            content: 'Specialist evidence returned through shared graph state.',
            tool_call_chunks: [
              {
                id: 'call-specialist-main',
                name: 'lc_transfer_to_main',
                args: '{}',
                index: 0,
                type: 'tool_call_chunk',
              },
            ],
          });
          return;
        }
        calls.push('main-final');
        yield new AIMessageChunk({ content: 'Main final after specialist return.' });
      },
    };
    graph.overrideModel = scriptedProviderModel as never;
    const workflow = graph.createWorkflow();

    const result = await workflow.invoke(
      {
        messages: [new HumanMessage('Use a specialist if it improves the answer.')],
        agentMessages: [],
      },
      {
        recursionLimit: 12,
        metadata: {
          run_id: 'synthetic-provider-bridge-run',
          thread_id: 'synthetic-provider-bridge-thread',
        },
        configurable: { thread_id: 'synthetic-provider-bridge-thread' },
      },
    );

    expect(calls).toEqual(['main-transfer', 'specialist-return', 'main-final']);
    expect(
      result.messages
        .filter((message: { getType(): string }) => message.getType() === 'tool')
        .map((message: { name?: string }) => message.name),
    ).toEqual(['lc_transfer_to_specialist', 'lc_transfer_to_main']);
    expect(
      result.messages.some(
        (message: { content?: unknown }) =>
          message.content === 'Specialist evidence returned through shared graph state.',
      ),
    ).toBe(true);
    expect(result.messages.at(-1)?.content).toBe('Main final after specialist return.');
  });

  it('falls back only inside the failing participant, preserves its transfer tools, and still leaves Main final', async () => {
    const graph = new MultiAgentGraph({
      runId: 'synthetic-participant-fallback-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-main-model' },
        },
        {
          agentId: 'reality',
          name: 'Reality',
          provider: Providers.ANTHROPIC,
          clientOptions: { model: 'synthetic-reality-model' },
        },
        {
          agentId: 'red',
          name: 'Red',
          provider: Providers.XAI,
          clientOptions: {
            model: 'synthetic-red-primary-model',
            fallbacks: [
              {
                provider: Providers.GOOGLE,
                clientOptions: { model: 'synthetic-red-fallback-model' },
              },
            ],
          },
        },
      ],
      edges: [
        { from: 'main', to: 'reality', edgeType: 'handoff', description: 'Reality check.' },
        { from: 'reality', to: 'main', edgeType: 'handoff', description: 'Return evidence.' },
        { from: 'main', to: 'red', edgeType: 'handoff', description: 'Challenge result.' },
        { from: 'red', to: 'main', edgeType: 'handoff', description: 'Return challenge.' },
      ],
    });
    const calls: string[] = [];
    let mainCalls = 0;
    let realityCalls = 0;
    let redPrimaryCalls = 0;
    let redFallbackCalls = 0;
    const fallbackBoundToolNames: string[] = [];
    const invokeForProvider = async (provider: Providers) => {
      if (provider === Providers.OPENAI) {
        mainCalls += 1;
        if (mainCalls === 1) {
          calls.push('main-to-reality');
          return {
            messages: [
              new AIMessageChunk({
                content: '',
                tool_call_chunks: [
                  {
                    id: 'call-main-reality',
                    name: 'lc_transfer_to_reality',
                    args: '{}',
                    index: 0,
                    type: 'tool_call_chunk',
                  },
                ],
              }),
            ],
          };
        }
        if (mainCalls === 2) {
          calls.push('main-to-red');
          return {
            messages: [
              new AIMessageChunk({
                content: 'Reality evidence retained by Main.',
                tool_call_chunks: [
                  {
                    id: 'call-main-red',
                    name: 'lc_transfer_to_red',
                    args: '{}',
                    index: 0,
                    type: 'tool_call_chunk',
                  },
                ],
              }),
            ],
          };
        }
        calls.push('main-final');
        return {
          messages: [
            new AIMessageChunk({
              content: 'Main final uses both Reality evidence and the fallback Red challenge.',
            }),
          ],
        };
      }
      if (provider === Providers.ANTHROPIC) {
        realityCalls += 1;
        calls.push('reality-return');
        return {
          messages: [
            new AIMessageChunk({
              content: 'Reality found primary-source evidence.',
              tool_call_chunks: [
                {
                  id: 'call-reality-main',
                  name: 'lc_transfer_to_main',
                  args: '{}',
                  index: 0,
                  type: 'tool_call_chunk',
                },
              ],
            }),
          ],
        };
      }
      if (provider === Providers.XAI) {
        redPrimaryCalls += 1;
        calls.push('red-primary-error');
        throw Object.assign(new Error('synthetic provider rate limit'), { status: 429 });
      }
      redFallbackCalls += 1;
      calls.push('red-fallback-return');
      return {
        messages: [
          new AIMessageChunk({
            content: 'Fallback Red challenge uses the shared Reality evidence.',
            tool_call_chunks: [
              {
                id: 'call-red-main',
                name: 'lc_transfer_to_main',
                args: '{}',
                index: 0,
                type: 'tool_call_chunk',
              },
            ],
          }),
        ],
      };
    };
    const redFallbackModel = {
      bindTools(tools: Array<{ name?: string }>) {
        fallbackBoundToolNames.push(...tools.map((tool) => tool.name ?? ''));
        return redFallbackModel;
      },
    };
    graph.initializeModel = (() => ({})) as never;
    graph.getNewModel = (({ provider }: { provider: Providers }) => {
      if (provider === Providers.GOOGLE) {
        return redFallbackModel;
      }
      return {};
    }) as never;
    (
      graph as unknown as {
        attemptInvoke: (input: { provider: Providers }) => Promise<{ messages: AIMessageChunk[] }>;
      }
    ).attemptInvoke = ({ provider }) => invokeForProvider(provider);

    const result = await graph.createWorkflow().invoke(
      {
        messages: [new HumanMessage('Verify this decision, challenge it, and give me the answer.')],
        agentMessages: [],
      },
      {
        recursionLimit: 20,
        metadata: {
          run_id: 'synthetic-participant-fallback-run',
          thread_id: 'synthetic-participant-fallback-thread',
        },
        configurable: { thread_id: 'synthetic-participant-fallback-thread' },
      },
    );

    expect(calls).toEqual([
      'main-to-reality',
      'reality-return',
      'main-to-red',
      'red-primary-error',
      'red-fallback-return',
      'main-final',
    ]);
    expect(realityCalls).toBe(1);
    expect(redPrimaryCalls).toBe(1);
    expect(redFallbackCalls).toBe(1);
    expect(fallbackBoundToolNames).toContain('lc_transfer_to_main');
    expect(
      result.messages.some(
        (message: { content?: unknown }) =>
          message.content === 'Reality found primary-source evidence.',
      ),
    ).toBe(true);
    expect(
      result.messages.some(
        (message: { content?: unknown }) =>
          message.content === 'Fallback Red challenge uses the shared Reality evidence.',
      ),
    ).toBe(true);
    expect(result.messages.at(-1)?.content).toBe(
      'Main final uses both Reality evidence and the fallback Red challenge.',
    );
  });

  it('runs a Responses-style participant through its initialized GlassHive route context and returns to Main last', async () => {
    const startedAtMs = Date.parse('2026-08-10T18:52:15.000Z');
    let nowMs = startedAtMs;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const capabilityRefreshes: Array<{ route: string; atMs: number }> = [];
    const capabilityRefresh = (route: string, instructionAppend: string) =>
      jest.fn(async () => {
        capabilityRefreshes.push({ route, atMs: Date.now() });
        return {
          attached: true,
          defaultHeaders: {
            'X-GlassHive-Bootstrap-Timestamp': String(Math.floor(Date.now() / 1000)),
          },
          previousInstructionAppend: instructionAppend,
          instructionAppend,
        };
      });
    const mainCapabilityRefresh = capabilityRefresh(
      'main-primary',
      'Main freshly signed capability authority.',
    );
    const realityCapabilityRefresh = capabilityRefresh(
      'reality-primary',
      'Reality freshly signed capability authority.',
    );
    const redFallbackCapabilityRefresh = capabilityRefresh(
      'red-graph-fallback',
      'Signed capability boundary: use only the authorized brokered host evidence.',
    );
    const abortController = new AbortController();
    const run = await createRun({
      runId: 'synthetic-cross-route-run',
      agents: [
        {
          id: 'main',
          name: 'Main',
          provider: 'openAI',
          endpoint: 'glasshive-harness',
          instructions: 'Main owns the final synthesis.',
          model_parameters: { model: 'synthetic-main-model' },
          viventiumConversationProviderCapabilityRefresh: mainCapabilityRefresh,
          edges: [
            { from: 'main', to: 'reality', edgeType: 'handoff', description: 'Reality check.' },
            { from: 'reality', to: 'main', edgeType: 'handoff', description: 'Return evidence.' },
            { from: 'main', to: 'red', edgeType: 'handoff', description: 'Challenge result.' },
            { from: 'red', to: 'main', edgeType: 'handoff', description: 'Return challenge.' },
          ],
        },
        {
          id: 'reality',
          name: 'Reality',
          provider: 'openAI',
          endpoint: 'glasshive-harness',
          instructions: 'Reality evidence context.',
          model_parameters: { model: 'synthetic-reality-model' },
          viventiumConversationProviderCapabilityRefresh: realityCapabilityRefresh,
          edges: [],
        },
        {
          id: 'red',
          name: 'Red',
          provider: 'openAI',
          endpoint: 'openAI',
          instructions: 'Red dynamic context and shared evidence are already prepared.',
          model_parameters: {
            model: 'synthetic-red-responses-primary',
            useResponsesApi: true,
          },
          viventiumGraphLlmFallbacks: [
            {
              id: 'red',
              provider: 'openAI',
              endpoint: 'glasshive-harness',
              model_parameters: {
                model: 'synthetic-glasshive-worker',
                apiKey: 'synthetic-test-key',
                configuration: {
                  baseURL: 'https://synthetic.invalid/v1',
                  defaultHeaders: {
                    'X-GlassHive-Idempotency-Key':
                      '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVEIDEMPOTENCYKEY}}',
                    'X-GlassHive-Bootstrap-Signature': 'sha256=synthetic',
                  },
                },
              },
              viventiumConversationProviderInstructionAppend:
                'Signed capability boundary: use only the authorized brokered host evidence.',
              viventiumConversationProviderCapabilityRefresh: redFallbackCapabilityRefresh,
            },
          ],
          edges: [],
        },
      ] as never,
      signal: abortController.signal,
      requestBody: {
        viventiumGlassHiveAgentIdempotencyKeys: {
          red: 'main:red:synthetic-response',
        },
      } as never,
      customHandlers: {},
      indexTokenCountMap: {},
    });
    const graph = run.Graph as MultiAgentGraph;
    const calls: string[] = [];
    const fallbackSystemMessages: string[] = [];
    const fallbackReasoningKeys: string[] = [];
    let mainCalls = 0;
    let redCalls = 0;
    const reasoningDelta = jest.spyOn(graph, 'dispatchReasoningDelta');

    graph.overrideModel = {
      async *stream(messages: Array<{ getType(): string; content: unknown }>, config: never) {
        const node = String(
          (config as { metadata?: { langgraph_node?: string } })?.metadata?.langgraph_node,
        );
        if (node.endsWith('main')) {
          mainCalls += 1;
          if (mainCalls === 1) {
            calls.push('main-to-reality');
            nowMs = startedAtMs + 301_001;
            yield new AIMessageChunk({
              content: '',
              tool_call_chunks: [
                {
                  id: 'call-main-reality-context',
                  name: 'lc_transfer_to_reality',
                  args: '{}',
                  index: 0,
                  type: 'tool_call_chunk',
                },
              ],
            });
            return;
          }
          if (mainCalls === 2) {
            calls.push('main-to-red');
            nowMs = startedAtMs + 903_003;
            yield new AIMessageChunk({
              content: 'Main retained Reality evidence.',
              tool_call_chunks: [
                {
                  id: 'call-main-red-context',
                  name: 'lc_transfer_to_red',
                  args: '{}',
                  index: 0,
                  type: 'tool_call_chunk',
                },
              ],
            });
            return;
          }
          calls.push('main-final');
          yield new AIMessageChunk({ content: 'Main final after route-correct Red challenge.' });
          return;
        }
        if (node.endsWith('reality')) {
          calls.push('reality-return');
          nowMs = startedAtMs + 602_002;
          yield new AIMessageChunk({
            content: 'Reality evidence.',
            tool_call_chunks: [
              {
                id: 'call-reality-main-context',
                name: 'lc_transfer_to_main',
                args: '{}',
                index: 0,
                type: 'tool_call_chunk',
              },
            ],
          });
          return;
        }

        redCalls += 1;
        if (redCalls === 1) {
          calls.push('red-primary-429');
          throw Object.assign(new Error('synthetic pre-authoring rate limit'), { status: 429 });
        }
        calls.push('red-glasshive-return');
        nowMs = startedAtMs + 1_204_004;
        fallbackReasoningKeys.push(graph.agentContexts.get('red')?.reasoningKey ?? 'missing');
        fallbackSystemMessages.push(
          messages
            .filter((message) => message.getType() === 'system')
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
            )
            .join('\n'),
        );
        yield new AIMessageChunk({
          content: '',
          additional_kwargs: { reasoning_content: 'Fallback route reasoning.' },
        });
        yield new AIMessageChunk({
          content: 'Route-correct Red challenge.',
          tool_call_chunks: [
            {
              id: 'call-red-main-context',
              name: 'lc_transfer_to_main',
              args: '{}',
              index: 0,
              type: 'tool_call_chunk',
            },
          ],
        });
      },
    } as never;

    const result = await graph.createWorkflow().invoke(
      {
        messages: [new HumanMessage('Check reality, challenge it, and answer once.')],
        agentMessages: [],
      },
      {
        recursionLimit: 20,
        metadata: {
          run_id: 'synthetic-cross-route-run',
          thread_id: 'synthetic-cross-route-thread',
        },
        configurable: { thread_id: 'synthetic-cross-route-thread' },
      },
    );

    expect(calls).toEqual([
      'main-to-reality',
      'reality-return',
      'main-to-red',
      'red-primary-429',
      'red-glasshive-return',
      'main-final',
    ]);
    expect(fallbackReasoningKeys).toEqual(['reasoning_content']);
    expect(fallbackSystemMessages[0]).toContain(
      'Red dynamic context and shared evidence are already prepared.',
    );
    expect(fallbackSystemMessages[0]).toContain(
      'Signed capability boundary: use only the authorized brokered host evidence.',
    );
    expect(reasoningDelta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: [expect.objectContaining({ think: 'Fallback route reasoning.' })],
      }),
    );
    expect(graph.viventiumGraphFallbackRecoveryReceipt).toEqual({
      provider: Providers.OPENAI,
      model: 'synthetic-glasshive-worker',
    });
    expect(result.messages.at(-1)?.content).toBe('Main final after route-correct Red challenge.');
    expect(capabilityRefreshes).toEqual([
      { route: 'main-primary', atMs: startedAtMs },
      { route: 'reality-primary', atMs: startedAtMs + 301_001 },
      { route: 'main-primary', atMs: startedAtMs + 602_002 },
      { route: 'red-graph-fallback', atMs: startedAtMs + 903_003 },
      { route: 'main-primary', atMs: startedAtMs + 1_204_004 },
    ]);
    expect(capabilityRefreshes.some(({ route }) => route === 'red-primary')).toBe(false);
    dateNowSpy.mockRestore();
  });

  it('uses a participant fallback for a structured recoverable 429', async () => {
    const graph = new MultiAgentGraph({
      runId: 'synthetic-recoverable-fallback-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: {
            model: 'synthetic-primary-model',
            fallbacks: [
              {
                provider: Providers.GOOGLE,
                clientOptions: { model: 'synthetic-fallback-model' },
              },
            ],
          },
        },
      ],
      edges: [],
    });
    const primaryModel = {
      async stream() {
        throw Object.assign(new Error('synthetic provider rate limit'), { status: 429 });
      },
    };
    const fallbackStream = jest.fn(() =>
      (async function* streamFallback() {
        yield new AIMessageChunk({ content: 'Fallback completed the recoverable request.' });
      })(),
    );
    const fallbackModel = {
      bindTools() {
        return fallbackModel;
      },
      stream: fallbackStream,
    };
    graph.initializeModel = (() => primaryModel) as never;
    graph.getNewModel = (() => fallbackModel) as never;

    const result = await graph.createWorkflow().invoke(
      {
        messages: [new HumanMessage('Complete this request through the configured model route.')],
        agentMessages: [],
      },
      {
        recursionLimit: 4,
        metadata: {
          run_id: 'synthetic-recoverable-fallback-run',
          thread_id: 'synthetic-recoverable-fallback-thread',
        },
        configurable: { thread_id: 'synthetic-recoverable-fallback-thread' },
      },
    );

    expect(fallbackStream).toHaveBeenCalledTimes(1);
    expect(result.messages.at(-1)?.content).toBe('Fallback completed the recoverable request.');
  });

  it.each([
    [
      'invalid request',
      () => Object.assign(new Error('synthetic invalid request'), { status: 400 }),
    ],
    [
      'content policy rejection',
      () =>
        Object.assign(new Error('synthetic policy rejection'), {
          status: 403,
          code: 'content_policy_violation',
        }),
    ],
    [
      'tool invariant failure',
      () =>
        Object.assign(new Error('synthetic tool invariant failure'), {
          status: 503,
          errorClass: 'tool_failure',
        }),
    ],
  ])(
    'does not invoke a participant fallback for a nonrecoverable %s',
    async (_label, errorFactory) => {
      const graph = new MultiAgentGraph({
        runId: 'synthetic-nonrecoverable-fallback-run',
        agents: [
          {
            agentId: 'main',
            name: 'Main',
            provider: Providers.OPENAI,
            clientOptions: {
              model: 'synthetic-primary-model',
              fallbacks: [
                {
                  provider: Providers.GOOGLE,
                  clientOptions: { model: 'synthetic-fallback-model' },
                },
              ],
            },
          },
        ],
        edges: [],
      });
      const primaryError = errorFactory();
      const primaryModel = {
        async stream() {
          throw primaryError;
        },
      };
      const fallbackStream = jest.fn(() =>
        (async function* streamFallback() {
          yield new AIMessageChunk({ content: 'This fallback must not run.' });
        })(),
      );
      const fallbackModel = {
        bindTools() {
          return fallbackModel;
        },
        stream: fallbackStream,
      };
      graph.initializeModel = (() => primaryModel) as never;
      graph.getNewModel = (() => fallbackModel) as never;

      await expect(
        graph.createWorkflow().invoke(
          {
            messages: [new HumanMessage('Do not mask invalid or invariant failures.')],
            agentMessages: [],
          },
          {
            recursionLimit: 4,
            metadata: {
              run_id: 'synthetic-nonrecoverable-fallback-run',
              thread_id: 'synthetic-nonrecoverable-fallback-thread',
            },
            configurable: { thread_id: 'synthetic-nonrecoverable-fallback-thread' },
          },
        ),
      ).rejects.toBe(primaryError);
      expect(fallbackStream).not.toHaveBeenCalled();
    },
  );

  it('does not invoke a participant fallback provider after the run is aborted', async () => {
    const abortController = new AbortController();
    const fallbackStream = jest.fn();
    const graph = new MultiAgentGraph({
      runId: 'synthetic-aborted-fallback-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: {
            model: 'synthetic-primary-model',
            fallbacks: [
              {
                provider: Providers.GOOGLE,
                clientOptions: { model: 'synthetic-fallback-model' },
              },
            ],
          },
        },
      ],
      edges: [],
    });
    const primaryModel = {
      async stream() {
        abortController.abort();
        throw Object.assign(new Error('synthetic primary failure during Stop'), { status: 429 });
      },
    };
    const fallbackModel = {
      bindTools() {
        return fallbackModel;
      },
      stream: fallbackStream,
    };
    graph.initializeModel = (() => primaryModel) as never;
    graph.getNewModel = (() => fallbackModel) as never;

    await expect(
      graph.createWorkflow().invoke(
        {
          messages: [new HumanMessage('Stop this turn before a fallback can start.')],
          agentMessages: [],
        },
        {
          signal: abortController.signal,
          recursionLimit: 4,
          metadata: {
            run_id: 'synthetic-aborted-fallback-run',
            thread_id: 'synthetic-aborted-fallback-thread',
          },
          configurable: { thread_id: 'synthetic-aborted-fallback-thread' },
        },
      ),
    ).rejects.toThrow(/abort/i);
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it('does not invoke a fallback after a recoverable primary failure that already authored output', async () => {
    const primaryError = Object.assign(new Error('synthetic late provider outage'), {
      status: 503,
    });
    const fallbackStream = jest.fn(() =>
      (async function* streamFallback() {
        yield new AIMessageChunk({ content: 'This fallback must not create a second answer.' });
      })(),
    );
    const graph = new MultiAgentGraph({
      runId: 'synthetic-late-authoring-failure-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: {
            model: 'synthetic-primary-model',
            fallbacks: [
              {
                provider: Providers.GOOGLE,
                clientOptions: { model: 'synthetic-fallback-model' },
              },
            ],
          },
        },
      ],
      edges: [],
    });
    const primaryModel = {
      async *stream() {
        yield new AIMessageChunk({ content: 'Primary already authored this visible fragment.' });
        throw primaryError;
      },
    };
    const fallbackModel = {
      bindTools() {
        return fallbackModel;
      },
      stream: fallbackStream,
    };
    graph.initializeModel = (() => primaryModel) as never;
    graph.getNewModel = (() => fallbackModel) as never;

    await expect(
      graph.createWorkflow().invoke(
        {
          messages: [new HumanMessage('Do not create two authoring runs.')],
          agentMessages: [],
        },
        {
          recursionLimit: 4,
          metadata: {
            run_id: 'synthetic-late-authoring-failure-run',
            thread_id: 'synthetic-late-authoring-failure-thread',
          },
          configurable: { thread_id: 'synthetic-late-authoring-failure-thread' },
        },
      ),
    ).rejects.toBe(primaryError);
    expect(fallbackStream).not.toHaveBeenCalled();
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
