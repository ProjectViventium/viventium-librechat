import { Run, Providers, Constants } from '@librechat/agents';
import { providerEndpointMap, KnownEndpoints } from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type {
  MultiAgentGraphConfig,
  OpenAIClientOptions,
  StandardGraphConfig,
  LCToolRegistry,
  AgentInputs,
  GenericTool,
  RunConfig,
  IState,
  LCTool,
} from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { Agent, AgentModelParameters } from 'librechat-data-provider';
import type * as t from '~/types';
import { resolveHeaders, createSafeUser } from '~/utils/env';

/** Expected shape of JSON tool search results */
interface ToolSearchJsonResult {
  found?: number;
  tools?: Array<{ name: string }>;
}

/**
 * Parses tool names from JSON-formatted tool_search output.
 * Format: { "found": N, "tools": [{ "name": "tool_name", ... }], ... }
 *
 * @param content - The JSON string content
 * @param discoveredTools - Set to add discovered tool names to
 * @returns true if parsing succeeded, false otherwise
 */
function parseToolSearchJson(content: string, discoveredTools: Set<string>): boolean {
  try {
    const parsed = JSON.parse(content) as ToolSearchJsonResult;
    if (!parsed.tools || !Array.isArray(parsed.tools)) {
      return false;
    }
    for (const tool of parsed.tools) {
      if (tool.name && typeof tool.name === 'string') {
        discoveredTools.add(tool.name);
      }
    }
    return parsed.tools.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parses tool names from legacy text-formatted tool_search output.
 * Format: "- tool_name (score: X.XX)"
 *
 * @param content - The text content
 * @param discoveredTools - Set to add discovered tool names to
 */
function parseToolSearchLegacy(content: string, discoveredTools: Set<string>): void {
  const toolNameRegex = /^- ([^\s(]+)\s*\(score:/gm;
  let match: RegExpExecArray | null;
  while ((match = toolNameRegex.exec(content)) !== null) {
    const toolName = match[1];
    if (toolName) {
      discoveredTools.add(toolName);
    }
  }
}

/**
 * Extracts discovered tool names from message history by parsing tool_search results.
 * When the LLM calls tool_search, the result contains tool names that were discovered.
 * These tools should have defer_loading overridden to false on subsequent turns.
 *
 * Supports both:
 * - New JSON format: { "tools": [{ "name": "tool_name" }] }
 * - Legacy text format: "- tool_name (score: X.XX)"
 *
 * @param messages - The conversation message history
 * @returns Set of tool names that were discovered via tool_search
 */
export function extractDiscoveredToolsFromHistory(messages: BaseMessage[]): Set<string> {
  const discoveredTools = new Set<string>();

  for (const message of messages) {
    const msgType = message._getType?.() ?? message.constructor?.name ?? '';
    if (msgType !== 'tool') {
      continue;
    }

    const name = (message as { name?: string }).name;
    if (name !== Constants.TOOL_SEARCH) {
      continue;
    }

    const content = message.content;
    if (typeof content !== 'string') {
      continue;
    }

    /** Try JSON format first (new), fall back to regex (legacy) */
    if (!parseToolSearchJson(content, discoveredTools)) {
      parseToolSearchLegacy(content, discoveredTools);
    }
  }

  return discoveredTools;
}

/**
 * Overrides defer_loading to false for tools that were already discovered via tool_search.
 * This prevents the LLM from having to re-discover tools on every turn.
 *
 * @param toolRegistry - The tool registry to modify (mutated in place)
 * @param discoveredTools - Set of tool names that were previously discovered
 * @returns Number of tools that had defer_loading overridden
 */
export function overrideDeferLoadingForDiscoveredTools(
  toolRegistry: LCToolRegistry,
  discoveredTools: Set<string>,
): number {
  let overrideCount = 0;
  for (const toolName of discoveredTools) {
    const toolDef = toolRegistry.get(toolName);
    if (toolDef && toolDef.defer_loading === true) {
      toolDef.defer_loading = false;
      overrideCount++;
    }
  }
  return overrideCount;
}

const customProviders = new Set([
  Providers.XAI,
  Providers.DEEPSEEK,
  Providers.MOONSHOT,
  Providers.OPENROUTER,
  KnownEndpoints.ollama,
  // === VIVENTIUM START ===
  // Feature: Disable per-chunk usage for Perplexity to avoid LangChain usage merge warnings.
  // Reason: Perplexity streams usage metadata per chunk, triggering completion_tokens warnings.
  KnownEndpoints.perplexity,
  // === VIVENTIUM END ===
]);

// === VIVENTIUM START ===
// Feature: Optional global streamUsage disable to suppress LangChain merge warnings.
const disableStreamUsageEnv = (process.env.VIVENTIUM_DISABLE_STREAM_USAGE ?? '').trim() === '1';
// === VIVENTIUM END ===
export function getReasoningKey(
  provider: Providers,
  llmConfig: t.RunLLMConfig,
  agentEndpoint?: string | null,
): 'reasoning_content' | 'reasoning' {
  let reasoningKey: 'reasoning_content' | 'reasoning' = 'reasoning_content';
  if (provider === Providers.GOOGLE) {
    reasoningKey = 'reasoning';
  } else if (
    llmConfig.configuration?.baseURL?.includes(KnownEndpoints.openrouter) ||
    (agentEndpoint && agentEndpoint.toLowerCase().includes(KnownEndpoints.openrouter))
  ) {
    reasoningKey = 'reasoning';
  } else if (
    (llmConfig as OpenAIClientOptions).useResponsesApi === true &&
    (provider === Providers.OPENAI || provider === Providers.AZURE)
  ) {
    reasoningKey = 'reasoning';
  }
  return reasoningKey;
}

type RunAgent = Omit<Agent, 'tools'> & {
  tools?: GenericTool[];
  maxContextTokens?: number;
  useLegacyContent?: boolean;
  toolContextMap?: Record<string, string>;
  toolRegistry?: LCToolRegistry;
  /** Serializable tool definitions for event-driven execution */
  toolDefinitions?: LCTool[];
  /** Precomputed flag indicating if any tools have defer_loading enabled */
  hasDeferredTools?: boolean;
  /* === VIVENTIUM START === Capability-declared provider wire transport. === */
  /** Runtime-only wire contract derived from provider capability metadata during initialization. */
  declaredProviderTransport?: DeclaredProviderTransport;
  /* === VIVENTIUM END === */
  /** Runtime-only initialized model routes used by this graph participant. */
  viventiumGraphLlmFallbacks?: RunAgentModelRoute[];
  /** Runtime-only exact authority block regenerated before a workspace-bound provider attempt. */
  viventiumConversationProviderInstructionAppend?: string;
  viventiumConversationProviderCapabilityRefresh?: (requestBody?: t.RequestBody) => Promise<{
    attached: boolean;
    defaultHeaders: Record<string, string>;
    previousInstructionAppend?: string;
    instructionAppend?: string;
  }>;
};

type RunAgentModelRoute = Pick<
  RunAgent,
  'id' | 'endpoint' | 'provider' | 'model_parameters' | 'declaredProviderTransport'
> & {
  viventiumConversationProviderInstructionAppend?: string;
  viventiumConversationProviderCapabilityRefresh?: (requestBody?: t.RequestBody) => Promise<{
    attached: boolean;
    defaultHeaders: Record<string, string>;
    previousInstructionAppend?: string;
    instructionAppend?: string;
  }>;
};

/* === VIVENTIUM START ===
 * Feature: Capability-declared provider wire transport.
 * Purpose: Enforce Chat Completions after SDK model-name heuristics while preserving the exact
 * provider model on the serialized wire request.
 */
export type DeclaredProviderTransport = {
  mode: 'chat_completions';
  reasoningEffort?: string;
};

const CHAT_COMPLETIONS_INTERNAL_MODEL = 'viventium-chat-completions';

export function applyDeclaredProviderTransport(
  modelParameters: Record<string, unknown>,
  transport?: DeclaredProviderTransport,
  provider?: Providers | string,
): Record<string, unknown> {
  const next = { ...modelParameters };
  if (transport?.mode !== 'chat_completions') {
    return next;
  }
  if (
    String(provider ?? '')
      .trim()
      .toLowerCase() !== String(Providers.OPENAI).trim().toLowerCase()
  ) {
    throw new Error(
      `A declared Chat Completions transport requires an OpenAI-compatible provider; received "${String(provider ?? 'missing')}"`,
    );
  }
  const wireModel = String(next.model ?? '').trim();
  if (!wireModel) {
    throw new Error('A declared Chat Completions provider requires an exact model');
  }
  const existingModelKwargs =
    next.modelKwargs && typeof next.modelKwargs === 'object' && !Array.isArray(next.modelKwargs)
      ? (next.modelKwargs as Record<string, unknown>)
      : {};
  const reasoningEffort = String(transport.reasoningEffort ?? '').trim();
  next.modelKwargs = {
    ...existingModelKwargs,
    model: wireModel,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  next.model = CHAT_COMPLETIONS_INTERNAL_MODEL;
  next.useResponsesApi = false;
  delete next.reasoning;
  delete next.reasoning_summary;
  delete next.verbosity;
  delete next.web_search;
  return next;
}

const nullableAgentModelParameterKeys = [
  'temperature',
  'maxContextTokens',
  'max_context_tokens',
  'max_output_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
] satisfies Array<keyof AgentModelParameters>;

function normalizeAgentModelParameters(
  modelParameters: AgentModelParameters | undefined,
): Partial<AgentModelParameters> | undefined {
  if (!modelParameters) {
    return undefined;
  }
  const normalized: Partial<AgentModelParameters> = { ...modelParameters };
  for (const key of nullableAgentModelParameterKeys) {
    if (normalized[key] === null) {
      delete normalized[key];
    }
  }
  return normalized;
}
/* === VIVENTIUM END === */

function withoutRuntimeCapabilityInstructionAppend(agent: RunAgent): string {
  const instructions = String(agent.instructions ?? '').trim();
  const runtimeAppend = String(agent.viventiumConversationProviderInstructionAppend ?? '').trim();
  if (
    typeof agent.viventiumConversationProviderCapabilityRefresh !== 'function' ||
    !runtimeAppend ||
    !instructions.includes(runtimeAppend)
  ) {
    return instructions;
  }
  return instructions
    .replace(runtimeAppend, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* === VIVENTIUM START ===
 * Feature: Graph-agent-scoped GlassHive request identity.
 * Purpose: Resolve the existing per-agent request key at the common Agent run boundary so each
 * handoff executes once, while an exact retry of that same participant remains idempotent.
 * === VIVENTIUM END === */
export function requestBodyForAgent(
  requestBody: t.RequestBody | undefined,
  agentId: string | null | undefined,
): t.RequestBody | undefined {
  const viventiumBody = requestBody as
    | (t.RequestBody & {
        viventiumGlassHiveIdempotencyKey?: string;
        viventiumGlassHiveAgentIdempotencyKeys?: Record<string, string>;
      })
    | undefined;
  const scopedKey = String(
    viventiumBody?.viventiumGlassHiveAgentIdempotencyKeys?.[String(agentId || '')] || '',
  ).trim();
  if (!scopedKey || !viventiumBody) {
    return requestBody;
  }
  return {
    ...viventiumBody,
    viventiumGlassHiveIdempotencyKey: scopedKey,
  } as t.RequestBody;
}

type ProjectGraphLlmFallbacksParams = {
  routes?: RunAgentModelRoute[];
  agentId: string;
  requestBody?: t.RequestBody;
  user?: IUser;
  streaming: boolean;
  streamUsage: boolean;
};

type ProjectedGraphLlmFallback = {
  provider: Providers;
  clientOptions: t.RunLLMConfig;
};

const VIVENTIUM_GRAPH_FALLBACK_CONTEXT = Symbol.for(
  'viventium.agent.graph.fallback.runtime.context.v1',
);
const VIVENTIUM_MODEL_ROUTE_CAPABILITY_REFRESH = Symbol.for(
  'viventium.agent.model.route.capability.refresh.v1',
);
const VIVENTIUM_DELIVERY_DISPOSITION_CAPABILITY_OWNER = Symbol.for(
  'viventium.agent.messaging.delivery-disposition.capability-owner.v1',
);

function installProjectedCapabilityRefresh({
  route,
  clientOptions,
  agentId,
  requestBody,
  user,
}: {
  route: RunAgentModelRoute;
  clientOptions: t.RunLLMConfig;
  agentId: string;
  requestBody?: t.RequestBody;
  user?: IUser;
}): void {
  const sourceRefresh = route.viventiumConversationProviderCapabilityRefresh;
  if (typeof sourceRefresh !== 'function') {
    return;
  }
  const configuration = (clientOptions.configuration ??= {});
  const liveHeaders = (configuration.defaultHeaders ??= {}) as Record<string, string>;
  const refresh = async () => {
    /* === VIVENTIUM START ===
     * Feature: Finalized gateway turn scope for invocation-fresh provider grants.
     * Purpose: Rebuild signed capability authority from the exact per-agent run body created after
     * persistence ids exist, rather than an initialization-time body that may still be unscoped.
     * === VIVENTIUM END === */
    const scopedRequestBody = requestBodyForAgent(requestBody, agentId);
    const result = await sourceRefresh(scopedRequestBody);
    const resolvedHeaders = resolveHeaders({
      headers: result.defaultHeaders ?? {},
      user: createSafeUser(user),
      body: scopedRequestBody,
    });
    for (const headerName of Object.keys(liveHeaders)) {
      delete liveHeaders[headerName];
    }
    Object.assign(liveHeaders, resolvedHeaders);
    return {
      ...result,
      defaultHeaders: liveHeaders,
    };
  };
  Object.defineProperty(clientOptions, VIVENTIUM_MODEL_ROUTE_CAPABILITY_REFRESH, {
    value: refresh,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function normalizeRunModelRoute({
  route,
  agentId,
  requestBody,
  user,
  streaming,
  streamUsage,
}: {
  route: RunAgentModelRoute;
} & Omit<ProjectGraphLlmFallbacksParams, 'routes'>): ProjectedGraphLlmFallback {
  const provider =
    (providerEndpointMap[
      route.provider as keyof typeof providerEndpointMap
    ] as unknown as Providers) ?? route.provider;
  const modelParameters = applyDeclaredProviderTransport(
    {
      ...(normalizeAgentModelParameters(route.model_parameters) ?? {}),
    } as Record<string, unknown>,
    route.declaredProviderTransport,
    provider,
  );
  const configuration = modelParameters.configuration as
    { defaultHeaders?: Record<string, string>; baseURL?: string } | undefined;
  if (configuration) {
    modelParameters.configuration = {
      ...configuration,
      ...(configuration.defaultHeaders
        ? { defaultHeaders: { ...configuration.defaultHeaders } }
        : {}),
    };
  }
  if (provider === Providers.ANTHROPIC && modelParameters.thinking === false) {
    delete modelParameters.thinking;
    delete modelParameters.thinkingBudget;
    delete modelParameters.thinkingLevel;
    delete modelParameters.effort;
  }

  const clientOptions = Object.assign(
    {
      provider,
      streaming,
      streamUsage,
    },
    modelParameters,
  ) as unknown as t.RunLLMConfig;
  Object.defineProperty(clientOptions, VIVENTIUM_DELIVERY_DISPOSITION_CAPABILITY_OWNER, {
    value: route.endpoint || route.provider,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  if (clientOptions.configuration?.defaultHeaders != null) {
    clientOptions.configuration.defaultHeaders = resolveHeaders({
      headers: clientOptions.configuration.defaultHeaders as Record<string, string>,
      user: createSafeUser(user),
      body: requestBodyForAgent(requestBody, agentId),
    });
  }
  installProjectedCapabilityRefresh({
    route,
    clientOptions,
    agentId,
    requestBody,
    user,
  });

  const requestMeta = requestBody as
    { viventiumSurface?: string; viventiumInputMode?: string } | undefined;
  const inputMode = (requestMeta?.viventiumInputMode ?? '').toString().toLowerCase();
  const voiceSurface = requestMeta?.viventiumSurface === 'voice' || inputMode === 'voice_call';
  if (
    disableStreamUsageEnv ||
    voiceSurface ||
    customProviders.has(route.provider) ||
    (route.provider === Providers.OPENAI && route.endpoint !== route.provider)
  ) {
    clientOptions.streamUsage = false;
    clientOptions.usage = true;
  }

  return { provider, clientOptions };
}

/* === VIVENTIUM START ===
 * Feature: Per-participant Agent Builder fallback projection.
 * Purpose: Convert only initialization-validated runtime routes into the installed graph's native
 * fallback shape, with the same provider normalization and request-bound headers as the owning
 * participant. No Agent document, prompt, name, or provider-specific routing rule is consulted.
 * Added: 2026-08-10
 * === VIVENTIUM END === */
export function projectGraphLlmFallbacks({
  routes = [],
  ...params
}: ProjectGraphLlmFallbacksParams): ProjectedGraphLlmFallback[] {
  return routes.map((route) => {
    const projected = normalizeRunModelRoute({ route, ...params });
    const runtimeContext = {
      endpoint: route.endpoint,
      model: String(route.model_parameters?.model ?? '').trim(),
      provider: projected.provider,
      reasoningKey: getReasoningKey(projected.provider, projected.clientOptions, route.endpoint),
      systemInstructionAppend: String(
        route.viventiumConversationProviderInstructionAppend ?? '',
      ).trim(),
    };
    Object.defineProperty(projected.clientOptions, VIVENTIUM_GRAPH_FALLBACK_CONTEXT, {
      value: Object.freeze(runtimeContext),
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return projected;
  });
}

/**
 * Creates a new Run instance with custom handlers and configuration.
 *
 * @param options - The options for creating the Run instance.
 * @param options.agents - The agents for this run.
 * @param options.signal - The signal for this run.
 * @param options.runId - Optional run ID; otherwise, a new run ID will be generated.
 * @param options.customHandlers - Custom event handlers.
 * @param options.streaming - Whether to use streaming.
 * @param options.streamUsage - Whether to stream usage information.
 * @param options.messages - Optional message history to extract discovered tools from.
 *   When provided, tools that were previously discovered via tool_search will have
 *   their defer_loading overridden to false, preventing redundant re-discovery.
 * @returns {Promise<Run<IState>>} A promise that resolves to a new Run instance.
 */
export async function createRun({
  runId,
  signal,
  agents,
  messages,
  requestBody,
  user,
  tokenCounter,
  customHandlers,
  indexTokenCountMap,
  streaming = true,
  streamUsage = true,
}: {
  agents: RunAgent[];
  signal: AbortSignal;
  runId?: string;
  streaming?: boolean;
  streamUsage?: boolean;
  requestBody?: t.RequestBody;
  user?: IUser;
  /** Message history for extracting previously discovered tools */
  messages?: BaseMessage[];
} & Pick<RunConfig, 'tokenCounter' | 'customHandlers' | 'indexTokenCountMap'>): Promise<
  Run<IState>
> {
  /**
   * Only extract discovered tools if:
   * 1. We have message history to parse
   * 2. At least one agent has deferred tools (using precomputed flag)
   *
   * This optimization avoids iterating through messages in the ~95% of cases
   * where no agent uses deferred tool loading.
   */
  const hasAnyDeferredTools = agents.some((agent) => agent.hasDeferredTools === true);

  const discoveredTools =
    hasAnyDeferredTools && messages?.length
      ? extractDiscoveredToolsFromHistory(messages)
      : new Set<string>();

  const agentInputs: AgentInputs[] = [];
  const buildAgentContext = (agent: RunAgent) => {
    const { provider, clientOptions: llmConfig } = normalizeRunModelRoute({
      route: agent,
      agentId: agent.id,
      requestBody,
      user,
      streaming,
      streamUsage,
    });

    const systemMessage = Object.values(agent.toolContextMap ?? {})
      .join('\n')
      .trim();

    const systemContent = [
      systemMessage,
      withoutRuntimeCapabilityInstructionAppend(agent),
      agent.additional_instructions ?? '',
    ]
      .join('\n')
      .trim();

    const graphFallbacks = projectGraphLlmFallbacks({
      routes: agent.viventiumGraphLlmFallbacks,
      agentId: agent.id,
      requestBody,
      user,
      streaming,
      streamUsage,
    });
    if (graphFallbacks.length > 0) {
      (
        llmConfig as t.RunLLMConfig & {
          fallbacks: ProjectedGraphLlmFallback[];
        }
      ).fallbacks = graphFallbacks;
    }

    /**
     * Override defer_loading for tools that were discovered in previous turns.
     * This prevents the LLM from having to re-discover tools via tool_search.
     * Also add the discovered tools' definitions so the LLM has their schemas.
     */
    let toolDefinitions = agent.toolDefinitions ?? [];
    if (discoveredTools.size > 0 && agent.toolRegistry) {
      overrideDeferLoadingForDiscoveredTools(agent.toolRegistry, discoveredTools);

      /** Add discovered tools' definitions so the LLM can see their schemas */
      const existingToolNames = new Set(toolDefinitions.map((d) => d.name));
      for (const toolName of discoveredTools) {
        if (existingToolNames.has(toolName)) {
          continue;
        }
        const toolDef = agent.toolRegistry.get(toolName);
        if (toolDef) {
          toolDefinitions = [...toolDefinitions, toolDef];
        }
      }
    }

    const reasoningKey = getReasoningKey(provider, llmConfig, agent.endpoint);
    const agentInput: AgentInputs = {
      provider,
      reasoningKey,
      toolDefinitions,
      agentId: agent.id,
      tools: agent.tools,
      clientOptions: llmConfig,
      instructions: systemContent,
      name: agent.name ?? undefined,
      toolRegistry: agent.toolRegistry,
      maxContextTokens: agent.maxContextTokens,
      useLegacyContent: agent.useLegacyContent ?? false,
      discoveredTools: discoveredTools.size > 0 ? Array.from(discoveredTools) : undefined,
    };
    agentInputs.push(agentInput);
  };

  for (const agent of agents) {
    buildAgentContext(agent);
  }

  const graphConfig: RunConfig['graphConfig'] = {
    signal,
    agents: agentInputs,
    edges: agents[0].edges,
  };

  if (agentInputs.length > 1 || ((graphConfig as MultiAgentGraphConfig).edges?.length ?? 0) > 0) {
    (graphConfig as unknown as MultiAgentGraphConfig).type = 'multi-agent';
  } else {
    (graphConfig as StandardGraphConfig).type = 'standard';
  }

  return Run.create({
    runId,
    graphConfig,
    tokenCounter,
    customHandlers,
    indexTokenCountMap,
  });
}
