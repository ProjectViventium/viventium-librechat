import { z } from 'zod';
import { ToolMessage, AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getChatModelClass, GraphEvents, MultiAgentGraph, Providers, Run } from '@librechat/agents';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import { installUnifiedSchemaToolBindingPatch } from '../../../../api/server/services/viventium/agentSchemaToolBindingPatch';
import { applyTimeContextDelivery } from '../../../../api/server/services/viventium/surfacePrompts';
import { getVerifiedNativeSources } from '../glasshive/nativeSupersession';
import { createNativeResponseFetch, nativeResponseSha256 } from '../glasshive/nativeResponse';
import { GenerationJobManager } from '../stream/GenerationJobManager';
import {
  buildMainContinuityHeaders,
  MAIN_CONTINUITY_CHAIN_HEADER,
  renderMainBackgroundInputs,
} from '../continuity/mainContinuity';
import {
  applyDeclaredProviderTransport,
  buildRunAgentSystemInstructions,
  createRun,
  extractDiscoveredToolsFromHistory,
  markGraphCoordinationTools,
  projectGraphLlmFallbacks,
  requestBodyForAgent,
} from './run';

installUnifiedSchemaToolBindingPatch();

type ViventiumGraph = MultiAgentGraph & {
  viventiumGraphFallbackRecoveryReceipt?: { provider: string; model: string };
};

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

describe('buildRunAgentSystemInstructions', () => {
  it('matches the real provider system pipe after removing stale capability authority', () => {
    const staleCapability = 'Stale signed capability authority.';
    const capsule = '<viventium_feeling_state>steady</viventium_feeling_state>';
    const agent = {
      instructions: `Stable Main instructions.\n\n${staleCapability}\n\n${capsule}`,
      additional_instructions: 'Final structured output contract.',
      toolContextMap: { evidence: 'Declared tool context.' },
      viventiumConversationProviderInstructionAppend: staleCapability,
      viventiumConversationProviderCapabilityRefresh: jest.fn(),
    } as never;

    expect(buildRunAgentSystemInstructions(agent)).toBe(
      [
        'Declared tool context.',
        `Stable Main instructions.\n\n${capsule}`,
        'Final structured output contract.',
      ].join('\n'),
    );
  });
});
// VIVENTIUM END

// VIVENTIUM START: verify graph-owned coordination stays distinct from external effects.
describe('graph coordination tool effect metadata', () => {
  it('marks graph-owned tools structurally without inspecting their names', () => {
    const graphTool = { name: 'synthetic-future-handoff-shape', metadata: { existing: true } };
    const ordinaryTool = { name: 'synthetic-external-effect-tool', metadata: {} };
    const run = {
      Graph: {
        agentContexts: new Map([['main', { graphTools: [graphTool], tools: [ordinaryTool] }]]),
      },
    };

    markGraphCoordinationTools(run as never);

    expect(graphTool.metadata.existing).toBe(true);
    expect((graphTool.metadata as Record<string, unknown>).viventiumToolEffectClass).toBe(
      Symbol.for('viventium.agent.graph.coordination.effect.token.v1'),
    );
    expect(ordinaryTool.metadata).toEqual({});
  });

  it('carries the server token through the real tool callback metadata slot', async () => {
    const graphTool = new DynamicStructuredTool({
      name: 'synthetic-coordination-callback',
      description: 'Synthetic no-op graph coordination tool.',
      schema: z.object({}),
      func: async () => 'ok',
      metadata: { existing: true },
    });
    const run = {
      Graph: {
        agentContexts: new Map([['main', { graphTools: [graphTool] }]]),
      },
    };
    let callbackMetadata: Record<string, unknown> | undefined;

    markGraphCoordinationTools(run as never);
    await graphTool.invoke(
      {},
      {
        callbacks: [
          {
            handleToolStart: async (...args: unknown[]) => {
              callbackMetadata = args[5] as Record<string, unknown> | undefined;
            },
          },
        ],
      },
    );

    expect(callbackMetadata?.existing).toBe(true);
    expect(callbackMetadata?.viventiumToolEffectClass).toBe(
      Symbol.for('viventium.agent.graph.coordination.effect.token.v1'),
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
    const capabilityOwnerSymbol = Symbol.for(
      'viventium.agent.messaging.delivery-disposition.capability-owner.v1',
    );
    expect(clientOptions[capabilityOwnerSymbol]).toBe('glasshive-harness');
    expect(Object.getOwnPropertyDescriptor(clientOptions, capabilityOwnerSymbol)).toMatchObject({
      enumerable: false,
      writable: false,
    });
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

  it('projects a connected participant as a hidden singleflight lazy shell', async () => {
    const createSpy = jest.spyOn(Run, 'create').mockReturnValue({ synthetic: true } as never);
    const initializedRegistry = new Map([
      ['read_mail', { name: 'read_mail', description: 'Read authorized mail.' }],
    ]);
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const connectedInitializer = jest.fn(async () => {
      await initializationGate;
      return {
        id: 'connected',
        name: 'Connected Accounts',
        provider: 'openAI',
        endpoint: 'openAI',
        model_parameters: { model: 'synthetic-connected-model' },
        instructions: 'Use only authorized connected accounts.',
        tools: [{ name: 'read_mail' }],
        toolDefinitions: [{ name: 'read_mail', description: 'Read authorized mail.' }],
        toolRegistry: initializedRegistry,
        maxContextTokens: 32000,
        edges: [],
      };
    });
    const connectedAgent = {
      id: 'connected',
      name: 'Connected Accounts',
      provider: 'openAI',
      endpoint: 'openAI',
      model_parameters: { model: 'synthetic-connected-model' },
      instructions: 'Connected shell.',
      edges: [],
    } as never;
    Object.defineProperty(connectedAgent, 'viventiumConnectedAgentInitializer', {
      value: connectedInitializer,
      enumerable: false,
    });

    await createRun({
      agents: [connectedAgent],
      signal: new AbortController().signal,
      streaming: true,
      streamUsage: true,
    });

    const graphAgent = createSpy.mock.calls[0]?.[0].graphConfig.agents[0];
    const initializerSymbol = Symbol.for('viventium.agent.connected.initializer.v1');
    const projectedInitializer = graphAgent.clientOptions[initializerSymbol] as () => Promise<{
      toolDefinitions: Array<{ name: string }>;
      toolRegistry: Map<string, { name: string }>;
      instructions: string;
    }>;
    expect(connectedInitializer).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(graphAgent.clientOptions, initializerSymbol),
    ).toMatchObject({ enumerable: false, writable: false, value: expect.any(Function) });
    expect(JSON.stringify(graphAgent.clientOptions)).not.toContain('initializer');
    expect(graphAgent.toolDefinitions).toEqual([
      expect.objectContaining({ name: 'viventium_connected_agent_lazy_sentinel' }),
    ]);

    const first = projectedInitializer();
    const second = projectedInitializer();
    await Promise.resolve();
    expect(connectedInitializer).toHaveBeenCalledTimes(1);
    releaseInitialization();
    const [firstProjection, secondProjection] = await Promise.all([first, second]);
    expect(firstProjection).toBe(secondProjection);
    expect(firstProjection.instructions).toBe('Use only authorized connected accounts.');
    expect(firstProjection.toolDefinitions).toEqual([
      { name: 'read_mail', description: 'Read authorized mail.' },
    ]);
    expect(firstProjection.toolRegistry).toBe(graphAgent.toolRegistry);
    expect([...firstProjection.toolRegistry.keys()]).toEqual(['read_mail']);

    createSpy.mockRestore();
  });

  it('hydrates the compiled event-driven ToolNode before the selected participant uses a tool', async () => {
    const initializedRegistry = new Map([
      [
        'read_mail',
        {
          name: 'read_mail',
          description: 'Read authorized mail.',
          allowed_callers: ['direct'],
        },
      ],
    ]);
    const connectedInitializer = jest.fn(async () => ({
      id: 'connected',
      name: 'Connected Accounts',
      provider: 'openAI',
      endpoint: 'openAI',
      model_parameters: { model: 'synthetic-connected-model' },
      instructions: 'Use only authorized connected accounts.',
      tools: [],
      toolDefinitions: [
        {
          name: 'read_mail',
          description: 'Read authorized mail.',
          allowed_callers: ['direct'],
        },
      ],
      toolRegistry: initializedRegistry,
      maxContextTokens: 32000,
      edges: [],
    }));
    const connectedAgent = {
      id: 'connected',
      name: 'Connected Accounts',
      provider: 'openAI',
      endpoint: 'openAI',
      model_parameters: { model: 'synthetic-connected-model' },
      instructions: 'Connected shell.',
      edges: [],
    } as never;
    Object.defineProperty(connectedAgent, 'viventiumConnectedAgentInitializer', {
      value: connectedInitializer,
      enumerable: false,
    });
    const toolExecutions: Array<{ agentId?: string; name?: string }> = [];
    const run = await createRun({
      runId: 'synthetic-lazy-connected-tool-run',
      agents: [connectedAgent],
      signal: new AbortController().signal,
      customHandlers: {
        [GraphEvents.ON_TOOL_EXECUTE]: {
          handle: (_event: string, data: unknown) => {
            const request = data as {
              agentId?: string;
              toolCalls: Array<{ id: string; name: string }>;
              resolve: (results: unknown[]) => void;
            };
            toolExecutions.push({
              agentId: request.agentId,
              name: request.toolCalls[0]?.name,
            });
            request.resolve(
              request.toolCalls.map((call) => ({
                toolCallId: call.id,
                status: 'success',
                content: 'Synthetic authorized mail result.',
              })),
            );
          },
        },
      },
      indexTokenCountMap: {},
      tokenCounter: () => 1,
    });
    const graph = run.Graph as ViventiumGraph;
    let providerCallCount = 0;
    graph.overrideModel = {
      async *stream() {
        expect(connectedInitializer).toHaveBeenCalledTimes(1);
        providerCallCount += 1;
        if (providerCallCount === 1) {
          yield new AIMessageChunk({
            content: '',
            tool_call_chunks: [
              {
                id: 'call-connected-read-mail',
                name: 'read_mail',
                args: '{}',
                index: 0,
                type: 'tool_call_chunk',
              },
            ],
          });
          return;
        }
        yield new AIMessageChunk({ content: 'Connected result returned.' });
      },
    } as never;

    expect(connectedInitializer).not.toHaveBeenCalled();
    await run.processStream(
      { messages: [new HumanMessage('Read my authorized mail.')] },
      {
        version: 'v2',
        recursionLimit: 6,
        configurable: { thread_id: 'synthetic-lazy-connected-tool-thread' },
      },
    );

    expect(connectedInitializer).toHaveBeenCalledTimes(1);
    expect(toolExecutions).toEqual([{ agentId: 'connected', name: 'read_mail' }]);
    expect(providerCallCount).toBe(2);
    expect([...initializedRegistry.keys()]).toEqual(['read_mail']);
  });

  it('binds a final native-authority observer only to the visible Main route', async () => {
    const createSpy = jest.spyOn(Run, 'create').mockReturnValue({ synthetic: true } as never);
    const observer = jest.fn();
    const params = {
      agents: [
        {
          id: 'main',
          provider: 'openAI',
          endpoint: 'glasshive-harness',
          model_parameters: { model: 'synthetic-main' },
          edges: [],
        },
        {
          id: 'hidden',
          provider: 'openAI',
          endpoint: 'openAI',
          model_parameters: { model: 'synthetic-hidden' },
          edges: [],
        },
      ],
      signal: new AbortController().signal,
      customHandlers: {},
      indexTokenCountMap: {},
      nativeRequestAuthorityObserver: observer,
    };

    await createRun(params as never);

    const graphAgents = createSpy.mock.calls[0]?.[0].graphConfig.agents;
    const observerSymbol = Symbol.for('viventium.agent.model.route.native.authority.observer.v1');
    expect(graphAgents[0].clientOptions[observerSymbol]).toBe(observer);
    expect(graphAgents[1].clientOptions[observerSymbol]).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(graphAgents[0].clientOptions, observerSymbol),
    ).toMatchObject({ enumerable: false, writable: false });
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
      tokenCounter: jest.fn(),
    });
    const graph = run.Graph as ViventiumGraph;
    expect(
      (graph.agentContexts.get('main')?.clientOptions as unknown as Record<PropertyKey, unknown>)[
        Symbol.for('viventium.agent.messaging.delivery-disposition.capability-owner.v1')
      ],
    ).toBe('glasshive-harness');
    expect(graph.agentContexts.get('main')?.instructions).toContain('Stable Main instructions.');
    expect(graph.agentContexts.get('main')?.systemRunnable).toBeDefined();
    const observedSystemMessages: string[] = [];
    graph.overrideModel = RunnableLambda.from(
      async (messages: Array<{ getType(): string; content: unknown }>) => {
        observedSystemMessages.push(messages.map((message) => String(message.content)).join('\n'));
        return new AIMessageChunk({ content: 'Synthetic answer.' });
      },
    ) as never;

    await run.processStream(
      { messages: [new HumanMessage('Use only current capability truth.')] },
      {
        version: 'v2',
        recursionLimit: 4,
        configurable: { thread_id: 'synthetic-primary-authority-refresh-thread' },
      },
    );

    expect(capabilityRefresh).toHaveBeenCalledTimes(1);
    const observedAuthority = observedSystemMessages.join('\n');
    expect(observedAuthority).toContain('Stable Main instructions.');
    expect(observedAuthority).toContain(unavailableAuthority);
    expect(observedAuthority).not.toContain(oldAuthority);
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
      tokenCounter: jest.fn(),
    });
    const graph = run.Graph as ViventiumGraph;
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

  it('bounds a pathological handoff bounce with the configured recursion limit', async () => {
    const graph = new MultiAgentGraph({
      runId: 'synthetic-bounded-bounce-run',
      agents: [
        {
          agentId: 'main',
          name: 'Main',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
        {
          agentId: 'connected',
          name: 'Connected Accounts',
          provider: Providers.OPENAI,
          clientOptions: { model: 'synthetic-model' },
        },
      ],
      edges: [
        {
          from: 'main',
          to: 'connected',
          edgeType: 'handoff',
          description: 'Consult Connected Accounts once.',
        },
        {
          from: 'connected',
          to: 'main',
          edgeType: 'handoff',
          description: 'Return the result to Main.',
        },
      ],
    });
    const calls: string[] = [];
    graph.overrideModel = {
      async *stream(_messages: unknown, config: never) {
        const node = String(
          (config as { metadata?: { langgraph_node?: string } })?.metadata?.langgraph_node,
        );
        const agentId = node.split('agent=').at(-1) || 'main';
        const destination = agentId === 'main' ? 'connected' : 'main';
        calls.push(agentId);
        yield new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              id: `call-${calls.length}`,
              name: `lc_transfer_to_${destination}`,
              args: '{}',
              index: 0,
              type: 'tool_call_chunk',
            },
          ],
        });
      },
    } as never;

    await expect(
      graph.createWorkflow().invoke(
        {
          messages: [new HumanMessage('Trigger a synthetic pathological handoff bounce.')],
          agentMessages: [],
        },
        {
          recursionLimit: 4,
          metadata: {
            run_id: 'synthetic-bounded-bounce-run',
            thread_id: 'synthetic-bounded-bounce-thread',
          },
          configurable: { thread_id: 'synthetic-bounded-bounce-thread' },
        },
      ),
    ).rejects.toThrow(/recursion/i);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(4);
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
    const scriptedProviderModel = {
      bindTools(tools: Array<{ name?: string }>) {
        const activeProvider = graph.agentContexts.get('red')?.provider;
        if (activeProvider === Providers.GOOGLE) {
          fallbackBoundToolNames.push(...tools.map((tool) => tool.name ?? ''));
        }
        return scriptedProviderModel;
      },
      async *stream(_messages: unknown, config: never) {
        const node = String(
          (config as { metadata?: { langgraph_node?: string } })?.metadata?.langgraph_node,
        );
        const agentId = node.split('agent=').at(-1) || 'main';
        const provider = graph.agentContexts.get(agentId)?.provider ?? Providers.OPENAI;
        if (agentId === 'red' && provider === Providers.GOOGLE) {
          fallbackBoundToolNames.push(
            ...(graph.agentContexts.get('red')?.getToolsForBinding() ?? []).map(
              (tool: { name?: string }) => tool.name ?? '',
            ),
          );
        }
        const result = await invokeForProvider(provider);
        for (const message of result.messages) {
          yield message;
        }
      },
    };
    graph.overrideModel = scriptedProviderModel as never;

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
      tokenCounter: jest.fn(),
    });
    const graph = run.Graph as ViventiumGraph;
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
      expect.any(Object),
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

  it.each([
    { status: 429 },
    { status: 500 },
    { code: 'provider_auth_missing', state: 'needs_input' },
  ])('uses a participant fallback for a structured recoverable %j', async (failure) => {
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
    const fallbackStream = jest.fn(() =>
      (async function* streamFallback() {
        yield new AIMessageChunk({ content: 'Fallback completed the recoverable request.' });
      })(),
    );
    const scriptedModel = {
      bindTools() {
        return scriptedModel;
      },
      stream: jest
        .fn()
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('synthetic recoverable provider failure'), failure);
        })
        .mockImplementation(fallbackStream),
    };
    graph.overrideModel = scriptedModel as never;

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
    ...[
      'native_input_declined',
      'native_input_expired',
      'native_input_cancelled',
      'native_turn_cancelled',
    ].map((code) => [
      code,
      () => Object.assign(new Error('Synthetic native owner input stop'), { status: 502, code }),
    ]),
    [
      'provider_progress_stalled',
      () =>
        Object.assign(new Error('Synthetic native attention'), {
          status: 502,
          code: 'provider_progress_stalled',
        }),
    ],
    [
      'wrapped provider_progress_stalled',
      () =>
        Object.assign(new Error('Synthetic provider boundary'), {
          viventiumCompletionPhase: 'provider_response',
          cause: { code: 'provider_progress_stalled' },
        }),
    ],
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
      const scriptedModel = {
        bindTools() {
          return scriptedModel;
        },
        stream: jest.fn(async () => {
          throw primaryError;
        }),
      };
      const fallbackStream = jest.fn(() =>
        (async function* streamFallback() {
          yield new AIMessageChunk({ content: 'This fallback must not run.' });
        })(),
      );
      graph.overrideModel = scriptedModel as never;

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
      expect(scriptedModel.stream).toHaveBeenCalledTimes(1);
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
    const scriptedModel = {
      bindTools() {
        return scriptedModel;
      },
      async stream() {
        abortController.abort();
        throw Object.assign(new Error('synthetic primary failure during Stop'), { status: 429 });
      },
    };
    graph.overrideModel = scriptedModel as never;

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
    const scriptedModel = {
      bindTools() {
        return scriptedModel;
      },
      async *stream() {
        yield new AIMessageChunk({ content: 'Primary already authored this visible fragment.' });
        throw primaryError;
      },
    };
    graph.overrideModel = scriptedModel as never;

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
    const fallbackStream = jest.fn(() =>
      (async function* streamFallback() {
        yield new AIMessageChunk({ content: 'Fallback completed the recoverable request.' });
      })(),
    );
    const scriptedModel = {
      bindTools() {
        return scriptedModel;
      },
      stream: jest
        .fn()
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('synthetic provider rate limit'), { status: 429 });
        })
        .mockImplementation(fallbackStream),
    };
    graph.overrideModel = scriptedModel as never;

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

/* === VIVENTIUM START ===
 * Accepted-source guards belong to this Main run, never the persisted agent or Cortex defaults.
 * === VIVENTIUM END === */
it('keeps accepted-source guards local to Main run options and its exact fallback routes', async () => {
  const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
  const primaryParameters = { model: 'synthetic-primary' };
  const fallbackParameters = { model: 'synthetic-fallback' };
  try {
    await createRun({
      agents: [
        {
          id: 'main',
          provider: Providers.OPENAI,
          model_parameters: primaryParameters,
          tools: [],
          viventiumGraphLlmFallbacks: [
            {
              id: 'main',
              provider: Providers.ANTHROPIC,
              model_parameters: fallbackParameters,
            },
          ],
        },
      ],
      signal: new AbortController().signal,
      mainContinuityHeaders: {
        'X-Viventium-Visible-Message-Chain-B64': Buffer.from('[]').toString('base64'),
      },
    } as never);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          agents: [
            expect.objectContaining({
              clientOptions: expect.objectContaining({
                model: 'synthetic-primary',
                callbacks: [expect.objectContaining({ awaitHandlers: true, raiseError: true })],
                fallbacks: [
                  expect.objectContaining({
                    provider: Providers.ANTHROPIC,
                    clientOptions: expect.objectContaining({
                      model: 'synthetic-fallback',
                      callbacks: [
                        expect.objectContaining({ awaitHandlers: true, raiseError: true }),
                      ],
                    }),
                  }),
                ],
              }),
            }),
          ],
        }),
      }),
    );
    expect(primaryParameters).not.toHaveProperty('callbacks');
    expect(fallbackParameters).not.toHaveProperty('callbacks');
  } finally {
    createSpy.mockRestore();
  }
});

it('keeps native dispatch wrappers out of source agent configuration and composes final-body binding locally', async () => {
  const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
  const baseFetch = jest.fn(async () => new Response('{}'));
  const configuration = { defaultHeaders: { 'X-GlassHive-Agent-Id': 'main' }, fetch: baseFetch };
  const parameters = { model: 'synthetic', configuration };
  const boundFetch = jest.fn(async () => new Response('{}'));
  const nativeResponseFetch = jest.fn(() => boundFetch);
  try {
    await createRun({
      agents: [
        {
          id: 'main',
          provider: Providers.OPENAI,
          endpoint: 'synthetic-native',
          model_parameters: parameters,
          tools: [],
        },
      ],
      signal: new AbortController().signal,
      mainContinuityHeaders: {
        'X-Viventium-Visible-Message-Chain-B64': Buffer.from('[]').toString('base64'),
        'X-Viventium-Main-Context-Owner': 'core',
      },
      nativeResponseFetch,
    } as never);
    expect(nativeResponseFetch).toHaveBeenCalledWith(baseFetch, {
      agentId: 'main',
      provider: Providers.OPENAI,
      endpoint: 'synthetic-native',
    });
    expect(parameters.configuration).toBe(configuration);
    expect(configuration.fetch).toBe(baseFetch);
    expect(configuration.defaultHeaders).toEqual({ 'X-GlassHive-Agent-Id': 'main' });
    expect(parameters).not.toHaveProperty('callbacks');
  } finally {
    createSpy.mockRestore();
  }
});

it.each([false, true])(
  'keeps Main continuity out of handoff routes (native=%s)',
  async (native) => {
    const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
    const existingCallback = { name: 'handoff-existing-callback' };
    const baseFetch = jest.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}'),
    );
    const main = {
      id: 'main',
      provider: Providers.OPENAI,
      tools: [],
      model_parameters: {
        model: 'synthetic-main',
        configuration: {
          fetch: baseFetch,
          defaultHeaders: { 'X-GlassHive-Agent-Id': 'main', 'X-Synthetic-Route': 'main' },
        },
      },
    };
    const handoffHeaders = {
      'X-Synthetic-Route': 'handoff',
      'X-Synthetic-Broker': 'handoff-broker',
      ...(native ? { 'X-GlassHive-Agent-Id': 'handoff' } : {}),
    };
    const handoff = {
      id: 'handoff',
      provider: Providers.OPENAI,
      tools: [],
      model_parameters: {
        model: 'synthetic-handoff',
        callbacks: [existingCallback],
        configuration: { fetch: baseFetch, defaultHeaders: handoffHeaders },
      },
    };
    const authority = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages: [new HumanMessage({ id: 'main-source', content: 'Accepted Main input.' })],
      sourceMessageIds: ['main-source'],
      logicalTurnId: 'turn',
    });
    try {
      await createRun({
        agents: [main, handoff],
        signal: new AbortController().signal,
        mainContinuityHeaders: authority,
      } as never);
      const projected = createSpy.mock.calls[0][0].graphConfig.agents;
      expect(projected[0].clientOptions?.callbacks).toEqual([
        expect.objectContaining({ awaitHandlers: true, raiseError: true }),
      ]);
      expect(projected[1].clientOptions?.callbacks).toEqual([existingCallback]);
      expect(projected[1].clientOptions?.configuration?.defaultHeaders).toEqual(handoffHeaders);
      if (!native) expect(projected[1].clientOptions?.configuration?.fetch).toBe(baseFetch);
      await projected[1].clientOptions?.configuration?.fetch?.('https://synthetic.invalid/v1', {
        method: 'POST',
        headers: handoffHeaders,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Separate handoff input.' }] }),
      });
      expect(new Headers(baseFetch.mock.calls[0][1]?.headers).get('X-Synthetic-Route')).toBe(
        'handoff',
      );
      const sentHeaders = new Headers(baseFetch.mock.calls[0][1]?.headers);
      for (const [key, value] of Object.entries(handoffHeaders)) {
        expect(sentHeaders.get(key)).toBe(value);
      }
      expect(sentHeaders.has('X-Viventium-Main-Context-Owner')).toBe(false);
      expect(sentHeaders.has(MAIN_CONTINUITY_CHAIN_HEADER)).toBe(false);
      expect(JSON.parse(String(baseFetch.mock.calls[0][1]?.body))).toEqual({
        messages: [{ role: 'user', content: 'Separate handoff input.' }],
      });
      expect(main.model_parameters).not.toHaveProperty('callbacks');
      expect(handoff.model_parameters.callbacks).toEqual([existingCallback]);
    } finally {
      createSpy.mockRestore();
    }
  },
);

it('preserves exact fallback route authority and required Main continuity stamps at dispatch', async () => {
  const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
  const sent: Headers[] = [];
  const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response('{}');
  });
  const source = new HumanMessage({ id: 'main-source', content: 'Accepted Main input.' });
  const authority = {
    ...buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages: [source],
      sourceMessageIds: ['main-source'],
      logicalTurnId: 'turn',
      revision: 2,
    }),
    'X-Viventium-Actor-Kind': 'external_user',
    'X-Viventium-Origin': 'interactive',
    'X-GlassHive-Agent-Id': 'main',
    'X-Synthetic-Route': 'main',
    'X-Synthetic-Broker': 'main-broker',
    'X-GlassHive-Idempotency-Key': 'main-occurrence',
  };
  const routeHeaders = {
    'X-GlassHive-Agent-Id': 'fallback',
    'X-Synthetic-Route': 'fallback',
    'X-Synthetic-Broker': 'fallback-broker',
    'X-GlassHive-Idempotency-Key': 'fallback-occurrence',
  };
  try {
    await createRun({
      agents: [
        {
          id: 'main',
          provider: Providers.OPENAI,
          tools: [],
          model_parameters: {
            model: 'synthetic-main',
            configuration: { fetch: baseFetch, defaultHeaders: authority },
          },
          viventiumGraphLlmFallbacks: [
            {
              id: 'main',
              provider: Providers.OPENAI,
              model_parameters: {
                model: 'synthetic-fallback',
                configuration: { fetch: baseFetch, defaultHeaders: routeHeaders },
              },
            },
          ],
        },
      ],
      signal: new AbortController().signal,
      mainContinuityHeaders: authority,
    } as never);
    const primary = createSpy.mock.calls[0][0].graphConfig.agents[0].clientOptions;
    const fallback = (
      primary as typeof primary & { fallbacks: Array<{ clientOptions: typeof primary }> }
    ).fallbacks[0].clientOptions;
    expect(fallback?.callbacks).toEqual([
      expect.objectContaining({ awaitHandlers: true, raiseError: true }),
    ]);
    await fallback?.configuration?.fetch?.('https://synthetic.invalid/v1', {
      method: 'POST',
      headers: {
        ...routeHeaders,
        [MAIN_CONTINUITY_CHAIN_HEADER]: authority[MAIN_CONTINUITY_CHAIN_HEADER],
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: source.content }] }),
    });
    expect(sent).toHaveLength(1);
    for (const [key, value] of Object.entries(routeHeaders)) expect(sent[0].get(key)).toBe(value);
    for (const key of [
      'X-Viventium-Main-Context-Owner',
      'X-Viventium-Main-Context-Protocol',
      'X-Viventium-Main-Context-Snapshot-SHA256',
      'X-Viventium-Continuity-Domain-Id',
      'X-Viventium-Logical-Turn-Id',
      'X-Viventium-Logical-Turn-Revision',
      'X-Viventium-Actor-Kind',
      'X-Viventium-Origin',
    ])
      expect(sent[0].get(key)).toBe(authority[key]);
  } finally {
    createSpy.mockRestore();
  }
});

it.each([false, true])(
  'preserves request-resolved factual context through Main and fallback SDK dispatch (stream=%s)',
  async (streaming) => {
    const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
    const source = new HumanMessage({
      id: 'accepted-source',
      content: 'Accepted synthetic input.',
    });
    const context = 'Current time: synthetic. Décision suivante. 次の行動を確認する。';
    const requestBody = {
      conversationId: 'conversation',
      messageId: source.id,
      viventiumSurface: 'voice',
      viventiumInputMode: 'voice_call',
      viventiumGlassHiveTurnContextB64: '',
    };
    applyTimeContextDelivery({
      req: { body: requestBody },
      requestBody,
      instructions: '',
      timeContextInstructions: context,
      providerCapability: { workspace_binding: true, conversation_session: true },
    });
    const stamps = {
      ...buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages: [source],
        sourceMessageIds: [source.id!],
        logicalTurnId: 'turn',
        revision: 1,
      }),
      'X-Viventium-Actor-Kind': 'external_user',
      'X-Viventium-Origin': 'interactive',
      'X-Viventium-Surface': 'voice',
      'X-Viventium-Memory-Eligible': 'true',
    };
    const rawHeaders = {
      ...stamps,
      'X-GlassHive-Agent-Id': 'main',
      'X-GlassHive-Turn-Context-B64': '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVETURNCONTEXTB64}}',
    };
    const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.metadata.turn_context).toBe(context);
      expect(payload.messages).toEqual([{ role: 'user', content: source.content }]);
      expect(payload.reasoning_effort).toBe('high');
      expect(getVerifiedNativeSources(init)).toEqual([
        {
          id: source.id,
          sha256: payload.metadata.visible_message_chain[0].sha256,
        },
      ]);
      const headers = new Headers(init?.headers);
      expect(headers.has('X-GlassHive-Turn-Context-B64')).toBe(false);
      for (const [key, value] of Object.entries(stamps)) {
        if (key !== MAIN_CONTINUITY_CHAIN_HEADER) expect(headers.get(key)).toBe(value);
      }
      if (streaming)
        return new Response(
          'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Kept."},"finish_reason":null}]}\n\n' +
            'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(
        JSON.stringify({
          id: 'synthetic',
          object: 'chat.completion',
          model: payload.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const route = (model: string, routeId: string) => ({
      id: 'main',
      provider: Providers.OPENAI,
      endpoint: 'glasshive-harness',
      tools: [],
      declaredProviderTransport: { mode: 'chat_completions', reasoningEffort: 'high' },
      model_parameters: {
        model,
        apiKey: 'synthetic',
        maxRetries: 0,
        configuration: {
          baseURL: 'https://synthetic.invalid/v1',
          fetch: baseFetch,
          defaultHeaders: {
            ...rawHeaders,
            'X-Synthetic-Route': routeId,
            'X-GlassHive-Tool-Grant': `${routeId}-grant`,
          },
        },
      },
    });
    const main = route('grok-build:grok-4.7-build-fast', 'primary');
    try {
      await createRun({
        agents: [
          {
            ...main,
            viventiumGraphLlmFallbacks: [route('claude-code:claude-opus-5-5', 'fallback')],
          },
        ],
        requestBody,
        user: { id: 'owner' },
        streaming,
        signal: new AbortController().signal,
        mainContinuityHeaders: rawHeaders,
      } as never);
      const primary = createSpy.mock.calls[0][0].graphConfig.agents[0].clientOptions;
      const fallback = (
        primary as typeof primary & {
          fallbacks: Array<{ clientOptions: typeof primary }>;
        }
      ).fallbacks[0].clientOptions;
      for (const [routeId, options] of [
        ['primary', primary],
        ['fallback', fallback],
      ] as const) {
        expect(options.configuration?.defaultHeaders?.['X-GlassHive-Turn-Context-B64']).toBe(
          requestBody.viventiumGlassHiveTurnContextB64,
        );
        const Model = getChatModelClass(Providers.OPENAI);
        const model = new Model(options as never);
        if (streaming)
          for await (const _chunk of await model.stream([source])) {
            /* consume */
          }
        else await model.invoke([source]);
        const sent = new Headers(baseFetch.mock.calls.at(-1)?.[1]?.headers);
        expect(sent.get('X-Synthetic-Route')).toBe(routeId);
        expect(sent.get('X-GlassHive-Tool-Grant')).toBe(`${routeId}-grant`);
        expect(JSON.parse(String(baseFetch.mock.calls.at(-1)?.[1]?.body)).model).toBe(
          routeId === 'primary' ? 'grok-build:grok-4.7-build-fast' : 'claude-code:claude-opus-5-5',
        );
      }
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(rawHeaders['X-GlassHive-Turn-Context-B64']).toBe(
        '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVETURNCONTEXTB64}}',
      );
    } finally {
      createSpy.mockRestore();
    }
  },
);

it.each([false, true])(
  'relocates signed bootstrap before Native response admission through Main and fallback (continuity=%s)',
  async (continuity) => {
    const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
    const predecessorSpy = jest
      .spyOn(GenerationJobManager, 'getNativePredecessorSupersession')
      .mockResolvedValue(undefined);
    const retainSpy = jest
      .spyOn(GenerationJobManager, 'retainNativeAcceptedSources')
      .mockResolvedValue(undefined);
    const source = new HumanMessage({ id: 'source', content: 'Read both selected notes.' });
    const sourceHeaders = continuity
      ? buildMainContinuityHeaders({
          context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
          messages: [source],
          sourceMessageIds: ['source'],
          logicalTurnId: 'turn',
          revision: 1,
        })
      : undefined;
    const files = [
      { path: 'alpha.txt', content: 'a'.repeat(200 * 1024) },
      { path: 'bravo.txt', content: 'b'.repeat(200 * 1024) },
    ];
    const encoded = Buffer.from(JSON.stringify({ files })).toString('base64');
    const body = JSON.stringify({
      model: 'synthetic',
      messages: [{ role: 'user', content: source.content }],
    });
    const baseFetch = jest.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}'),
    );
    const admit = jest.fn(async (_identity: NativeResponseIdentity) => true);
    const onBound = jest.fn();
    const context = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: 1,
      logicalTurnId: 'scope.turn',
      revision: 1,
      providerId: 'native',
      agentId: 'main',
      source: { id: 'source-id', messageId: 'source', digest: 'source-digest' },
    };
    const headers = {
      'X-GlassHive-Agent-Id': 'main',
      'X-GlassHive-Bootstrap-Bundle-B64': encoded,
      'X-GlassHive-Bootstrap-Signature': 'synthetic-signature',
      'X-GlassHive-Bootstrap-Timestamp': '123',
      Authorization: 'Bearer synthetic',
      ...sourceHeaders,
    };
    const route = (name: string) => ({
      id: 'main',
      provider: Providers.OPENAI,
      endpoint: 'synthetic-native',
      tools: [],
      model_parameters: {
        model: name,
        configuration: { fetch: baseFetch, defaultHeaders: headers },
      },
    });
    try {
      await createRun({
        agents: [{ ...route('primary'), viventiumGraphLlmFallbacks: [route('fallback')] }],
        signal: new AbortController().signal,
        mainContinuityHeaders: sourceHeaders,
        nativeResponseFetch: (fetch: typeof baseFetch) =>
          createNativeResponseFetch(fetch, async () => context, admit, onBound),
      } as never);
      const primary = createSpy.mock.calls[0][0].graphConfig.agents[0].clientOptions;
      const fallback = (
        primary as typeof primary & { fallbacks: Array<{ clientOptions: typeof primary }> }
      ).fallbacks[0].clientOptions;
      for (const options of [primary, fallback]) {
        await options.configuration?.fetch?.('https://synthetic.invalid/v1/chat/completions', {
          method: 'POST',
          headers: options.configuration.defaultHeaders,
          body,
        });
        const dispatched = baseFetch.mock.calls[baseFetch.mock.calls.length - 1];
        const sent = new Headers(dispatched[1].headers);
        const wire = String(dispatched[1].body);
        const payload = JSON.parse(wire);
        expect(sent.has('X-GlassHive-Bootstrap-Bundle-B64')).toBe(false);
        expect(sent.get('X-GlassHive-Bootstrap-Signature')).toBe('synthetic-signature');
        expect(sent.get('X-GlassHive-Bootstrap-Timestamp')).toBe('123');
        expect(sent.get('Authorization')).toBe('Bearer synthetic');
        expect(payload.metadata.bootstrap_bundle_b64).toBe(encoded);
        expect(
          JSON.parse(Buffer.from(payload.metadata.bootstrap_bundle_b64, 'base64').toString()).files,
        ).toEqual(files);
        expect(payload.messages).toEqual([{ role: 'user', content: source.content }]);
        expect(sent.get('X-Viventium-Native-Body-SHA256')).toBe(nativeResponseSha256(wire));
        expect(admit.mock.calls.at(-1)?.[0].bodySha256).toBe(nativeResponseSha256(wire));
        if (continuity) {
          expect(payload.metadata.visible_message_chain).toHaveLength(1);
          expect(sent.get('X-Viventium-Main-Context-Owner')).toBe(
            sourceHeaders?.['X-Viventium-Main-Context-Owner'],
          );
        }
      }
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(onBound).toHaveBeenCalledTimes(2);
      expect(headers['X-GlassHive-Bootstrap-Bundle-B64']).toBe(encoded);
    } finally {
      createSpy.mockRestore();
      predecessorSpy.mockRestore();
      retainSpy.mockRestore();
    }
  },
);

it.each([false, true])(
  'refreshes late source through actual primary and fallback SDK dispatch (stream=%s)',
  async (streaming) => {
    const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
    const source = new HumanMessage({ id: 'source', content: 'Accepted foreground input.' });
    const context = 'Frozen time and memory.';
    const headers = {
      ...buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages: [source],
        sourceMessageIds: ['source'],
        logicalTurnId: 'turn',
        revision: 1,
      }),
      'X-GlassHive-Agent-Id': 'main',
      'X-GlassHive-Turn-Context-B64': Buffer.from(context).toString('base64'),
    };
    const text = 'Completed late exact evidence.';
    const input = {
      version: 1 as const,
      invocationId: 'first-native-invocation',
      deliveryId: 'd'.repeat(64),
      text,
      textSha256: nativeResponseSha256(text),
      sources: [{ cortexId: 'cortex', insightSha256: 'e'.repeat(64) }],
    };
    let inputs: (typeof input)[] = [];
    const read = jest.fn(async () => inputs);
    const contextIdentity = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: 1,
      logicalTurnId: 'turn',
      revision: 1,
      providerId: 'native',
      agentId: 'main',
      source: { id: 'source-row', messageId: 'source', digest: 'f'.repeat(64) },
    };
    let admissions = 0;
    const admit = jest.fn(async (_identity: NativeResponseIdentity) => ++admissions === 1);
    const predecessor = jest
      .spyOn(GenerationJobManager, 'getNativePredecessorSupersession')
      .mockResolvedValue(undefined);
    const retain = jest
      .spyOn(GenerationJobManager, 'retainNativeAcceptedSources')
      .mockResolvedValue(undefined);
    const actualNativeBoundary = jest.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body));
        expect(payload.metadata.turn_context).toBe(
          inputs.length ? context + '\n\n' + renderMainBackgroundInputs([input]) : context,
        );
        expect(payload.metadata.main_background_inputs).toEqual(
          inputs.length ? [input] : undefined,
        );
        expect(payload.messages).toEqual([{ role: 'user', content: source.content }]);
        expect(payload.reasoning_effort).toBe('high');
        expect(payload.metadata.visible_message_chain[0]).toMatchObject({
          id: source.id,
          accepted_source: true,
        });
        if (streaming)
          return new Response(
            'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Kept."},"finish_reason":null}]}\n\n' +
              'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return new Response(
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion',
            model: payload.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const route = (model: string) => ({
      id: 'main',
      provider: Providers.OPENAI,
      endpoint: 'native',
      tools: [],
      instructions: 'Frozen Main authority.',
      declaredProviderTransport: { mode: 'chat_completions', reasoningEffort: 'high' },
      model_parameters: {
        model,
        apiKey: 'synthetic',
        maxRetries: 0,
        configuration: {
          baseURL: 'https://provider.invalid/v1',
          fetch: actualNativeBoundary,
          defaultHeaders: headers,
        },
      },
    });
    try {
      await createRun({
        agents: [
          {
            ...route('synthetic-primary'),
            viventiumGraphLlmFallbacks: [route('synthetic-fallback')],
          },
        ],
        user: { id: 'owner' },
        signal: new AbortController().signal,
        streaming,
        mainContinuityHeaders: headers,
        readMainBackgroundInputs: read,
        nativeResponseFetch: (fetch: typeof actualNativeBoundary) => {
          const native = createNativeResponseFetch(
            fetch,
            async () => contextIdentity,
            admit,
            () => undefined,
          );
          return (url, init) => {
            const payload = JSON.parse(String(init?.body));
            expect(getVerifiedNativeSources(init)).toEqual([
              {
                id: source.id,
                sha256: payload.metadata.visible_message_chain[0].sha256,
              },
            ]);
            return native(url, init);
          };
        },
      } as never);
      const primary = createSpy.mock.calls[0][0].graphConfig.agents[0].clientOptions;
      const fallback = (
        primary as typeof primary & { fallbacks: Array<{ clientOptions: typeof primary }> }
      ).fallbacks[0].clientOptions;
      for (const options of [primary, primary, fallback]) {
        const Model = getChatModelClass(Providers.OPENAI);
        const model = new Model(options as never);
        if (streaming)
          for await (const _chunk of await model.stream([source])) {
            /* consume */
          }
        else await model.invoke([source]);
        inputs = [input];
      }
      expect(actualNativeBoundary).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenCalledTimes(3);
      expect(admit).toHaveBeenCalledTimes(3);
      for (const [index, call] of actualNativeBoundary.mock.calls.entries())
        expect(admit.mock.calls[index][0].bodySha256).toBe(
          nativeResponseSha256(String(call[1]?.body)),
        );
      expect(admit.mock.calls[0][0].bodySha256).not.toBe(admit.mock.calls[1][0].bodySha256);
      expect(
        new Headers(actualNativeBoundary.mock.calls[1][1]?.headers).has(
          'X-Viventium-Native-Invocation-Id',
        ),
      ).toBe(false);
      expect(createSpy.mock.calls[0][0].graphConfig.agents[0].instructions).toBe(
        'Frozen Main authority.',
      );
      expect(headers['X-GlassHive-Turn-Context-B64']).toBe(Buffer.from(context).toString('base64'));
    } finally {
      createSpy.mockRestore();
      predecessor.mockRestore();
      retain.mockRestore();
    }
  },
);

it('does not read current Main data for another native graph participant or ordinary API transport', async () => {
  const createSpy = jest.spyOn(Run, 'create').mockResolvedValue({ run: 'synthetic' } as never);
  const source = new HumanMessage({ id: 'source', content: 'Foreground.' });
  const headers = buildMainContinuityHeaders({
    context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
    messages: [source],
    sourceMessageIds: ['source'],
    logicalTurnId: 'turn',
    revision: 1,
  });
  const read = jest.fn(async () => []);
  const baseFetch = jest.fn(async () => new Response('{}'));
  try {
    await createRun({
      agents: [
        {
          id: 'main',
          provider: Providers.OPENAI,
          tools: [],
          model_parameters: {
            model: 'ordinary',
            configuration: { fetch: baseFetch, defaultHeaders: headers },
          },
        },
        {
          id: 'participant',
          provider: Providers.OPENAI,
          tools: [],
          model_parameters: {
            model: 'native',
            configuration: {
              fetch: baseFetch,
              defaultHeaders: { 'X-GlassHive-Agent-Id': 'participant' },
            },
          },
        },
      ],
      signal: new AbortController().signal,
      mainContinuityHeaders: headers,
      readMainBackgroundInputs: read,
    } as never);
    const agents = createSpy.mock.calls[0][0].graphConfig.agents;
    for (const agent of agents)
      await agent.clientOptions.configuration?.fetch?.(
        'https://provider.invalid/v1/chat/completions',
        { method: 'POST', body: '{"messages":[]}' },
      );
    expect(read).not.toHaveBeenCalled();
  } finally {
    createSpy.mockRestore();
  }
});
