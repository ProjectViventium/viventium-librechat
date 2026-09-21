import { AsyncLocalStorage } from 'node:async_hooks';
import { Run, Providers, Constants, StandardGraph } from '@librechat/agents';
import { providerEndpointMap, KnownEndpoints } from 'librechat-data-provider';
import { SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Callbacks } from '@langchain/core/callbacks/manager';
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
import type { MainContinuityFetch } from '~/continuity';
import {
  withMainContinuityCallbacks,
  createMainContinuityFetch,
  MAIN_CONTINUITY_CHAIN_HEADER,
} from '~/continuity';

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
  /** Runtime-only wire contract derived from provider capability metadata. */
  declaredProviderTransport?: DeclaredProviderTransport;
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
  /** Runtime-only first-use initializer for a connected graph participant. */
  viventiumConnectedAgentInitializer?: () => Promise<RunAgent>;
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

export type DeclaredProviderTransport = {
  mode: 'chat_completions';
  reasoningEffort?: string;
};

const CHAT_COMPLETIONS_INTERNAL_MODEL = 'viventium-chat-completions';

/** Apply an initialized provider's declared wire transport without changing its wire model. */
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
  const modelKwargs =
    next.modelKwargs && typeof next.modelKwargs === 'object' && !Array.isArray(next.modelKwargs)
      ? (next.modelKwargs as Record<string, unknown>)
      : {};
  const reasoningEffort = String(transport.reasoningEffort ?? '').trim();
  next.modelKwargs = {
    ...modelKwargs,
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

export function buildRunAgentSystemInstructions(agent: RunAgent): string {
  const toolContext = Object.values(agent.toolContextMap ?? {})
    .join('\n')
    .trim();
  return [
    toolContext,
    withoutRuntimeCapabilityInstructionAppend(agent),
    agent.additional_instructions ?? '',
  ]
    .join('\n')
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
const VIVENTIUM_MODEL_ROUTE_NATIVE_AUTHORITY_OBSERVER = Symbol.for(
  'viventium.agent.model.route.native.authority.observer.v1',
);
const VIVENTIUM_GRAPH_COORDINATION_EFFECT_TOKEN = Symbol.for(
  'viventium.agent.graph.coordination.effect.token.v1',
);
const VIVENTIUM_CONNECTED_AGENT_INITIALIZER = Symbol.for(
  'viventium.agent.connected.initializer.v1',
);
const VIVENTIUM_CONNECTED_AGENT_LAZY_SENTINEL: LCTool = Object.freeze({
  name: 'viventium_connected_agent_lazy_sentinel',
  description: 'Internal graph initialization sentinel. Never exposed to a provider.',
});
const VIVENTIUM_MODERN_GRAPH_PATCH = Symbol.for('viventium.agent.modern.graph.fallback.patch.v1');
const VIVENTIUM_MODERN_ROUTE_ACCESSORS = Symbol.for(
  'viventium.agent.modern.graph.route.accessors.v1',
);
const VIVENTIUM_CONNECTED_AGENT_HYDRATION = Symbol.for('viventium.agent.connected.hydration.v1');

type ModernGraphRoute = {
  provider?: unknown;
  reasoningKey?: unknown;
  clientOptions?: unknown;
  systemRunnable?: unknown;
};

type ModernRouteContext = {
  routes: Map<object, ModernGraphRoute>;
};

const modernRouteContext = new AsyncLocalStorage<ModernRouteContext>();

function propertyValue(target: object, key: PropertyKey): unknown {
  return (target as Record<PropertyKey, unknown>)[key];
}

function installModernRouteAccessors(agentContext: object): void {
  const context = agentContext as Record<PropertyKey, unknown>;
  if (context[VIVENTIUM_MODERN_ROUTE_ACCESSORS] === true) {
    return;
  }

  const fields: PropertyKey[] = ['provider', 'reasoningKey', 'clientOptions', 'systemRunnable'];
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const field of fields) {
    let owner: object | null = agentContext;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, field);
      owner = Object.getPrototypeOf(owner);
    }
    if (descriptor?.configurable === false) {
      return;
    }
    descriptors.set(field, descriptor);
  }

  for (const field of fields) {
    const descriptor = descriptors.get(field);
    const baseValue = descriptor?.get
      ? descriptor.get.call(agentContext)
      : propertyValue(agentContext, field);
    let writableValue = baseValue;
    Object.defineProperty(agentContext, field, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        const activeRoute = modernRouteContext.getStore()?.routes.get(agentContext);
        if (activeRoute && Object.prototype.hasOwnProperty.call(activeRoute, field)) {
          return (activeRoute as Record<PropertyKey, unknown>)[field];
        }
        return descriptor?.get ? descriptor.get.call(this) : writableValue;
      },
      set(value: unknown) {
        if (descriptor?.set) {
          descriptor.set.call(this, value);
        } else {
          writableValue = value;
        }
      },
    });
  }

  Object.defineProperty(agentContext, VIVENTIUM_MODERN_ROUTE_ACCESSORS, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function cloneRouteClientOptions(clientOptions: unknown): Record<PropertyKey, unknown> {
  const source =
    clientOptions && typeof clientOptions === 'object'
      ? (clientOptions as object)
      : Object.create(null);
  const clone = Object.defineProperties({}, Object.getOwnPropertyDescriptors(source)) as Record<
    PropertyKey,
    unknown
  >;
  clone.fallbacks = [];
  return clone;
}

function systemMessageText(message: unknown): string {
  const candidate = message as { content?: unknown } | null;
  if (!candidate) {
    return '';
  }
  if (typeof candidate.content === 'string') {
    return candidate.content;
  }
  if (!Array.isArray(candidate.content)) {
    return '';
  }
  return candidate.content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

function appendSystemInstruction(messages: BaseMessage[], instruction?: string): BaseMessage[] {
  const append = String(instruction ?? '').trim();
  if (!append) {
    return messages;
  }
  const nextMessages = [...messages];
  const systemIndex = nextMessages.findIndex((message) => message.getType() === 'system');
  if (systemIndex < 0) {
    return [new SystemMessage(append), ...nextMessages];
  }
  const currentText = systemMessageText(nextMessages[systemIndex]);
  if (currentText.includes(append)) {
    return nextMessages;
  }
  nextMessages[systemIndex] = new SystemMessage([currentText, append].filter(Boolean).join('\n\n'));
  return nextMessages;
}

function replaceSystemInstruction(
  messages: BaseMessage[],
  previousInstructionAppend?: string,
  instructionAppend?: string,
): BaseMessage[] {
  const previous = String(previousInstructionAppend ?? '').trim();
  const nextInstruction = String(instructionAppend ?? '').trim();
  if (!previous && !nextInstruction) {
    return messages;
  }
  const nextMessages = [...messages];
  const systemIndex = nextMessages.findIndex((message) => message.getType() === 'system');
  if (systemIndex < 0) {
    return nextInstruction ? [new SystemMessage(nextInstruction), ...nextMessages] : nextMessages;
  }
  let currentText = systemMessageText(nextMessages[systemIndex]);
  if (previous && currentText.includes(previous)) {
    currentText = currentText
      .replace(previous, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (nextInstruction && !currentText.includes(nextInstruction)) {
    currentText = [currentText, nextInstruction].filter(Boolean).join('\n\n');
  }
  nextMessages[systemIndex] = new SystemMessage(currentText);
  return nextMessages;
}

function reportNativeInstructionAuthority(messages: BaseMessage[], clientOptions: unknown): void {
  const observer = propertyValue(
    (clientOptions && typeof clientOptions === 'object' ? clientOptions : {}) as object,
    VIVENTIUM_MODEL_ROUTE_NATIVE_AUTHORITY_OBSERVER,
  );
  if (typeof observer !== 'function') {
    return;
  }
  const instructionAuthority = messages
    .filter((message) => message.getType() === 'system')
    .map(systemMessageText)
    .map((value) => value.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join('\n\n')
    .trim();
  if (instructionAuthority) {
    try {
      (observer as (value: { instructionAuthority: string }) => void)({
        instructionAuthority,
      });
    } catch {
      // Observability must not change the provider attempt outcome.
    }
  }
}

function graphAbortError(): Error & { code: string } {
  return createConnectedAgentAbortError();
}

function graphIsAborted(graph: object, config?: { signal?: AbortSignal }): boolean {
  return (
    config?.signal?.aborted === true || (graph as { signal?: AbortSignal }).signal?.aborted === true
  );
}

function authoringEvidenceSnapshot(graph: object): { runStepCount: number; toolCallCount: number } {
  const candidate = graph as {
    contentData?: unknown;
    toolCallStepIds?: unknown;
  };
  return {
    runStepCount: Array.isArray(candidate.contentData) ? candidate.contentData.length : 0,
    toolCallCount: candidate.toolCallStepIds instanceof Map ? candidate.toolCallStepIds.size : 0,
  };
}

function hasNewAuthoringEvidence(
  graph: object,
  before: { runStepCount: number; toolCallCount: number },
): boolean {
  const after = authoringEvidenceSnapshot(graph);
  return after.runStepCount > before.runStepCount || after.toolCallCount > before.toolCallCount;
}

async function hydrateConnectedAgentContextForModernPolicy(
  agentContext: object,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    throw graphAbortError();
  }
  const context = agentContext as Record<PropertyKey, unknown>;
  const clientOptions = context.clientOptions;
  const initializer =
    clientOptions && typeof clientOptions === 'object'
      ? (clientOptions as Record<PropertyKey, unknown>)[VIVENTIUM_CONNECTED_AGENT_INITIALIZER]
      : undefined;
  if (typeof initializer !== 'function') {
    return;
  }

  let hydration = context[VIVENTIUM_CONNECTED_AGENT_HYDRATION] as Promise<void> | undefined;
  if (!hydration) {
    const priorTokenCalculation = context.tokenCalculationPromise;
    hydration = Promise.all([
      (initializer as () => Promise<Record<string, unknown>>)(),
      priorTokenCalculation &&
      typeof (priorTokenCalculation as Promise<unknown>).then === 'function'
        ? priorTokenCalculation
        : Promise.resolve(),
    ]).then(([hydrated]) => {
      if (!hydrated || typeof hydrated !== 'object') {
        throw new Error('Connected agent initialization returned no graph configuration');
      }
      const stableRegistry = context.toolRegistry instanceof Map ? context.toolRegistry : new Map();
      if (hydrated.toolRegistry instanceof Map && hydrated.toolRegistry !== stableRegistry) {
        stableRegistry.clear();
        for (const [name, definition] of hydrated.toolRegistry) {
          stableRegistry.set(name, definition);
        }
      }
      context.provider = hydrated.provider;
      context.reasoningKey = hydrated.reasoningKey ?? context.reasoningKey;
      context.clientOptions = hydrated.clientOptions;
      context.name = hydrated.name ?? context.name;
      context.tools = hydrated.tools;
      context.toolRegistry = stableRegistry;
      context.toolDefinitions = hydrated.toolDefinitions;
      context.instructions = hydrated.instructions;
      context.additionalInstructions = hydrated.additional_instructions;
      context.maxContextTokens = hydrated.maxContextTokens;
      context.useLegacyContent = hydrated.useLegacyContent ?? false;
      if (hydrated.toolEnd !== undefined) {
        context.toolEnd = hydrated.toolEnd;
      }
      const discoveredTools = Array.isArray(hydrated.discoveredTools)
        ? (hydrated.discoveredTools as unknown[])
        : [];
      for (const toolName of discoveredTools) {
        if (typeof toolName !== 'string') {
          continue;
        }
        (context.discoveredToolNames as Set<string> | undefined)?.add?.(toolName);
      }
      context.instructionTokens = 0;
      context.systemMessageTokens = 0;
      context.cachedSystemRunnable = undefined;
      context.systemRunnableStale = true;
      context.pruneMessages = undefined;
      (context.initializeSystemRunnable as (() => void) | undefined)?.call(context);
      if (
        typeof context.tokenCounter === 'function' &&
        typeof context.calculateInstructionTokens === 'function'
      ) {
        const baseTokenMap = { ...(context.baseIndexTokenCountMap as Record<string, number>) };
        context.indexTokenCountMap = baseTokenMap;
        context.tokenCalculationPromise = (
          context.calculateInstructionTokens as (counter: unknown) => Promise<void>
        )
          .call(context, context.tokenCounter)
          .then(() => {
            (
              context.updateTokenMapWithInstructions as
                ((tokenMap: Record<string, number>) => void) | undefined
            )?.call(context, baseTokenMap);
          });
      } else {
        context.tokenCalculationPromise = undefined;
      }
    });
    Object.defineProperty(context, VIVENTIUM_CONNECTED_AGENT_HYDRATION, {
      value: hydration,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  await hydration;
  if ((signal as AbortSignal | undefined)?.aborted === true) {
    throw graphAbortError();
  }
}

function fallbackRuntimeContext(fallback: unknown): {
  provider?: unknown;
  model: string;
  reasoningKey?: unknown;
  systemInstructionAppend: string;
} {
  const candidate = fallback as { clientOptions?: unknown; provider?: unknown } | null;
  const options =
    candidate?.clientOptions && typeof candidate.clientOptions === 'object'
      ? (candidate.clientOptions as Record<PropertyKey, unknown>)
      : {};
  const declared = options[VIVENTIUM_GRAPH_FALLBACK_CONTEXT];
  if (declared && typeof declared === 'object') {
    const context = declared as {
      provider?: unknown;
      model?: unknown;
      reasoningKey?: unknown;
      systemInstructionAppend?: unknown;
    };
    return {
      provider: context.provider,
      model: String(context.model ?? '').trim(),
      reasoningKey: context.reasoningKey,
      systemInstructionAppend: String(context.systemInstructionAppend ?? '').trim(),
    };
  }
  return {
    provider: candidate?.provider,
    model: String(options.model ?? options.modelName ?? '').trim(),
    reasoningKey: undefined,
    systemInstructionAppend: '',
  };
}

async function prepareModernRouteMessages({
  stateMessages,
  config,
  baseSystemRunnable,
  refreshResult,
  systemInstructionAppend,
}: {
  stateMessages: BaseMessage[];
  config: object;
  baseSystemRunnable?: {
    invoke?: (messages: BaseMessage[], config?: object) => Promise<BaseMessage[]>;
  };
  refreshResult?: {
    previousInstructionAppend?: string;
    instructionAppend?: string;
  } | null;
  systemInstructionAppend?: string;
}): Promise<BaseMessage[]> {
  let messages = stateMessages;
  if (baseSystemRunnable && typeof baseSystemRunnable.invoke === 'function') {
    messages = await baseSystemRunnable.invoke(messages, config);
  }
  if (refreshResult) {
    return replaceSystemInstruction(
      messages,
      refreshResult.previousInstructionAppend || systemInstructionAppend,
      refreshResult.instructionAppend ?? systemInstructionAppend,
    );
  }
  return appendSystemInstruction(messages, systemInstructionAppend);
}

/* === VIVENTIUM START ===
 * Feature: Package-local graph fallback error boundary.
 * Purpose: Classify the exact graph model-attempt failure without importing legacy server source
 * into the compiled TypeScript package.
 */
const nonRetryableGraphFallbackClasses = new Set([
  'host_capacity',
  'provider_request_rejected',
  'bad_request',
  'content_policy',
  'content_policy_violation',
  'context_length_exceeded',
  'graph_invariant_failure',
  'invalid_request',
  'invalid_request_error',
  'invariant_failure',
  'no_live_tool_execution',
  'missing_required_evidence',
  'schema_validation_error',
  'tool_failure',
  'mcp_failure',
  'mcp_tool_failure',
  'missing_tool_auth',
  'tool_auth_required',
  'provider_response_deadline_exceeded',
]);

const recoverableGraphFallbackClasses = new Set([
  'provider_rate_limited',
  'provider_quota_exhausted',
  'provider_quota_or_billing',
  'provider_response_failed',
  'provider_temporarily_unavailable',
  'provider_auth_missing',
  'recoverable_provider_error',
  'provider_unauthorized',
  'provider_access_denied',
  'provider_connected_account_reconnect_required',
  'late_stream_termination',
]);

const recoverableGraphFallbackCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

interface StructuredGraphFallbackError {
  name?: unknown;
  cause?: unknown;
  error?: unknown;
  response?: unknown;
  data?: unknown;
  errorClass?: unknown;
  error_class?: unknown;
  errorCode?: unknown;
  error_code?: unknown;
  code?: unknown;
  lc_error_code?: unknown;
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  errorStatus?: unknown;
  error_status?: unknown;
  viventiumCompletionPhase?: unknown;
  viventiumConnectedAccountReconnectRequired?: unknown;
  viventiumRecoverableProviderError?: unknown;
  viventiumNonRetryableProviderError?: unknown;
}

function structuredGraphFallbackError(value: unknown): StructuredGraphFallbackError | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as StructuredGraphFallbackError;
}

function graphFallbackErrorChain(error: unknown): StructuredGraphFallbackError[] {
  const chain: StructuredGraphFallbackError[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  while (queue.length > 0 && chain.length < 12) {
    const current = structuredGraphFallbackError(queue.shift());
    if (!current || seen.has(current as object)) {
      continue;
    }
    seen.add(current as object);
    chain.push(current);
    const response = structuredGraphFallbackError(current.response);
    const responseData = structuredGraphFallbackError(response?.data);
    queue.push(current.cause, current.error, current.response, response?.data, responseData?.error);
  }
  return chain;
}

function normalizeGraphFallbackClass(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function graphFallbackErrorClasses(error: unknown): string[] {
  return graphFallbackErrorChain(error)
    .flatMap((item) => [
      item.errorClass,
      item.error_class,
      item.errorCode,
      item.error_code,
      item.code,
      item.lc_error_code,
      item.type,
    ])
    .map(normalizeGraphFallbackClass)
    .filter(Boolean);
}

function graphFallbackStatus(item: StructuredGraphFallbackError): number {
  for (const candidate of [item.status, item.statusCode, item.errorStatus, item.error_status]) {
    const status = Number(candidate);
    if (Number.isFinite(status) && status > 0) {
      return status;
    }
  }
  return 0;
}

function isRecoverableGraphFallbackStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

function markOpaqueProviderAttemptFailure(error: unknown): unknown {
  const chain = graphFallbackErrorChain(error);
  if (chain.length === 0) {
    return error;
  }
  const hasStructuredDisposition =
    graphFallbackErrorClasses(error).length > 0 ||
    chain.some(
      (item) =>
        item.name === 'AbortError' ||
        Boolean(item.viventiumCompletionPhase) ||
        item.viventiumConnectedAccountReconnectRequired === true ||
        item.viventiumRecoverableProviderError === true ||
        item.viventiumNonRetryableProviderError === true ||
        graphFallbackStatus(item) > 0,
    );
  if (hasStructuredDisposition) {
    return error;
  }
  try {
    chain[0].viventiumCompletionPhase = 'provider_response';
    return error;
  } catch {
    return Object.assign(new Error('Model provider response failed'), {
      viventiumCompletionPhase: 'provider_response',
      cause: error,
    });
  }
}

function isRecoverableProviderFallbackError(error: unknown): boolean {
  const chain = graphFallbackErrorChain(error);
  if (chain.length === 0) {
    return false;
  }
  const structuredClasses = graphFallbackErrorClasses(error);
  if (
    chain.some(
      (item) =>
        item.name === 'AbortError' ||
        item.code === 'ABORT_ERR' ||
        item.viventiumNonRetryableProviderError === true,
    ) ||
    structuredClasses.some((value) => nonRetryableGraphFallbackClasses.has(value))
  ) {
    return false;
  }
  if (
    chain.some(
      (item) =>
        item.viventiumCompletionPhase === 'provider_response' ||
        item.viventiumConnectedAccountReconnectRequired === true ||
        item.viventiumRecoverableProviderError === true,
    ) ||
    structuredClasses.some((value) => recoverableGraphFallbackClasses.has(value))
  ) {
    return true;
  }
  if (chain.some((item) => isRecoverableGraphFallbackStatus(graphFallbackStatus(item)))) {
    return true;
  }
  return structuredClasses.some((value) => {
    const code = value.toUpperCase();
    return (
      code === 'MODEL_AUTHENTICATION' ||
      code === 'MODEL_RATE_LIMIT' ||
      code === 'AUTHENTICATION_ERROR' ||
      recoverableGraphFallbackCodes.has(code)
    );
  });
}
/* === VIVENTIUM END === */

async function invokeModernGraphFallbackPolicy(
  graph: object,
  agentContext: object,
  originalCallModel: (state: { messages: BaseMessage[] }, config?: object) => Promise<unknown>,
  state: { messages: BaseMessage[] },
  config: { signal?: AbortSignal },
): Promise<unknown> {
  if (graphIsAborted(graph, config)) {
    throw graphAbortError();
  }

  await hydrateConnectedAgentContextForModernPolicy(agentContext, config.signal);
  installModernRouteAccessors(agentContext);
  const context = agentContext as Record<PropertyKey, unknown>;
  const baseProvider = context.provider;
  const baseReasoningKey = context.reasoningKey;
  const baseClientOptions = context.clientOptions;
  const baseSystemRunnable = context.systemRunnable as
    { invoke?: (messages: BaseMessage[], config?: object) => Promise<BaseMessage[]> } | undefined;
  const baseOptions =
    baseClientOptions && typeof baseClientOptions === 'object'
      ? (baseClientOptions as Record<PropertyKey, unknown>)
      : {};
  const fallbacks = Array.isArray(baseOptions.fallbacks) ? [...baseOptions.fallbacks] : [];
  const hasCapabilityRefresh =
    typeof baseOptions[VIVENTIUM_MODEL_ROUTE_CAPABILITY_REFRESH] === 'function';
  if (fallbacks.length === 0 && !hasCapabilityRefresh) {
    return originalCallModel(state, config);
  }

  const routes = new Map<object, ModernGraphRoute>();
  const invokeRoute = async (
    route: ModernGraphRoute,
    messages: BaseMessage[],
  ): Promise<unknown> => {
    routes.set(agentContext, route);
    return originalCallModel({ ...state, messages }, config);
  };

  return modernRouteContext.run({ routes }, async () => {
    const primaryOptions = cloneRouteClientOptions(baseClientOptions);
    const primaryRoute: ModernGraphRoute = {
      provider: baseProvider,
      reasoningKey: baseReasoningKey,
      clientOptions: primaryOptions,
      systemRunnable: null,
    };
    routes.set(agentContext, primaryRoute);
    const primaryRefresh = propertyValue(primaryOptions, VIVENTIUM_MODEL_ROUTE_CAPABILITY_REFRESH);
    let primaryRefreshResult: {
      previousInstructionAppend?: string;
      instructionAppend?: string;
    } | null = null;
    if (typeof primaryRefresh === 'function') {
      primaryRefreshResult = await (
        primaryRefresh as () => Promise<{
          previousInstructionAppend?: string;
          instructionAppend?: string;
        }>
      )();
    }
    if (graphIsAborted(graph, config)) {
      throw graphAbortError();
    }
    const primaryMessages = await prepareModernRouteMessages({
      stateMessages: state.messages,
      config,
      baseSystemRunnable,
      refreshResult: primaryRefreshResult,
    });
    reportNativeInstructionAuthority(primaryMessages, primaryOptions);
    const primaryBefore = authoringEvidenceSnapshot(graph);
    try {
      return await invokeRoute(primaryRoute, primaryMessages);
    } catch (primaryError) {
      const primaryAuthored = hasNewAuthoringEvidence(graph, primaryBefore);
      const classifiedPrimaryError =
        graphIsAborted(graph, config) || primaryAuthored
          ? primaryError
          : markOpaqueProviderAttemptFailure(primaryError);
      if (
        graphIsAborted(graph, config) ||
        primaryAuthored ||
        !isRecoverableProviderFallbackError(classifiedPrimaryError)
      ) {
        throw graphIsAborted(graph, config) ? graphAbortError() : classifiedPrimaryError;
      }

      let lastError = classifiedPrimaryError;
      for (const fallback of fallbacks) {
        if (graphIsAborted(graph, config)) {
          throw graphAbortError();
        }
        const runtimeContext = fallbackRuntimeContext(fallback);
        const fallbackOptions =
          fallback && typeof fallback === 'object'
            ? (fallback as { clientOptions?: unknown }).clientOptions
            : undefined;
        const fallbackRefresh = propertyValue(
          (fallbackOptions && typeof fallbackOptions === 'object' ? fallbackOptions : {}) as object,
          VIVENTIUM_MODEL_ROUTE_CAPABILITY_REFRESH,
        );
        let fallbackRefreshResult: {
          previousInstructionAppend?: string;
          instructionAppend?: string;
        } | null = null;
        if (typeof fallbackRefresh === 'function') {
          fallbackRefreshResult = await (
            fallbackRefresh as () => Promise<{
              previousInstructionAppend?: string;
              instructionAppend?: string;
            }>
          )();
        }
        if (graphIsAborted(graph, config)) {
          throw graphAbortError();
        }
        const fallbackMessages = await prepareModernRouteMessages({
          stateMessages: state.messages,
          config,
          baseSystemRunnable,
          refreshResult: fallbackRefreshResult,
          systemInstructionAppend: runtimeContext.systemInstructionAppend,
        });
        const fallbackRoute: ModernGraphRoute = {
          provider: runtimeContext.provider,
          reasoningKey: runtimeContext.reasoningKey,
          clientOptions: cloneRouteClientOptions(fallbackOptions),
          systemRunnable: null,
        };
        reportNativeInstructionAuthority(fallbackMessages, fallbackRoute.clientOptions);
        const fallbackBefore = authoringEvidenceSnapshot(graph);
        try {
          const result = await invokeRoute(fallbackRoute, fallbackMessages);
          Object.defineProperty(graph, 'viventiumGraphFallbackRecoveryReceipt', {
            value: Object.freeze({
              provider: String(runtimeContext.provider ?? '').trim(),
              model: runtimeContext.model,
            }),
            configurable: true,
            enumerable: false,
            writable: false,
          });
          return result;
        } catch (fallbackError) {
          const fallbackAuthored = hasNewAuthoringEvidence(graph, fallbackBefore);
          const classifiedFallbackError =
            graphIsAborted(graph, config) || fallbackAuthored
              ? fallbackError
              : markOpaqueProviderAttemptFailure(fallbackError);
          lastError = classifiedFallbackError;
          if (
            graphIsAborted(graph, config) ||
            fallbackAuthored ||
            !isRecoverableProviderFallbackError(classifiedFallbackError)
          ) {
            throw graphIsAborted(graph, config) ? graphAbortError() : classifiedFallbackError;
          }
        }
      }
      throw lastError;
    } finally {
      routes.delete(agentContext);
    }
  });
}

function installModernGraphCompatibilityPatch(): void {
  const proto = StandardGraph?.prototype as unknown as Record<PropertyKey, unknown> | undefined;
  if (!proto || typeof proto.createCallModel !== 'function') {
    return;
  }
  if (proto[VIVENTIUM_MODERN_GRAPH_PATCH] === true) {
    return;
  }
  const originalCreateCallModel = proto.createCallModel as (
    this: object,
    agentId?: string,
    ...rest: unknown[]
  ) => unknown;
  const originalResetValues = proto.resetValues as
    ((this: object, ...args: unknown[]) => unknown) | undefined;
  if (typeof originalResetValues === 'function') {
    proto.resetValues = function patchedResetValues(this: object, ...args: unknown[]) {
      if (Object.prototype.hasOwnProperty.call(this, 'viventiumGraphFallbackRecoveryReceipt')) {
        delete (this as Record<PropertyKey, unknown>).viventiumGraphFallbackRecoveryReceipt;
      }
      return originalResetValues.apply(this, args);
    };
  }
  proto.createCallModel = function patchedCreateCallModel(
    this: object,
    agentId = 'default',
    ...rest: unknown[]
  ): unknown {
    const originalCallModel = originalCreateCallModel.call(this, agentId, ...rest);
    if (typeof originalCallModel !== 'function') {
      return originalCallModel;
    }
    return async (state: { messages: BaseMessage[] }, config?: { signal?: AbortSignal }) => {
      const agentContext = (this as { agentContexts?: Map<string, object> }).agentContexts?.get(
        agentId,
      );
      if (!agentContext) {
        return (originalCallModel as (state: unknown, config?: unknown) => Promise<unknown>)(
          state,
          config,
        );
      }
      return invokeModernGraphFallbackPolicy(
        this,
        agentContext,
        originalCallModel as (
          state: { messages: BaseMessage[] },
          config?: object,
        ) => Promise<unknown>,
        state,
        config ?? {},
      );
    };
  };
  Object.defineProperty(proto, VIVENTIUM_MODERN_GRAPH_PATCH, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

installModernGraphCompatibilityPatch();

function repairAgentContextCompatibility(run: {
  Graph?: { agentContexts?: Map<string, object> };
}): void {
  const contexts = run?.Graph?.agentContexts;
  if (!(contexts instanceof Map)) {
    return;
  }
  for (const context of contexts.values()) {
    const descriptor = Object.getOwnPropertyDescriptor(context, 'instructionTokens');
    if (descriptor) {
      continue;
    }
    const prototype = Object.getPrototypeOf(context);
    const inherited = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'instructionTokens')
      : undefined;
    if (!inherited?.get || inherited.set) {
      continue;
    }
    Object.defineProperty(context, 'instructionTokens', {
      configurable: true,
      enumerable: inherited.enumerable ?? false,
      get: inherited.get.bind(context),
      set: () => undefined,
    });
  }
}

function createConnectedAgentAbortError(): Error & { code: string } {
  return Object.assign(new Error('operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

/* === VIVENTIUM START ===
 * Feature: Structural graph-coordination effect metadata.
 * Purpose: Graph-owned transfer tools only move control between in-process participants. Mark them
 * from graph ownership—not tool names—so provider recovery does not confuse coordination with an
 * external effect such as an email, calendar update, or durable work action.
 * Added: 2026-08-18
 */
export function markGraphCoordinationTools(run: {
  Graph?: {
    agentContexts?: Map<string, { graphTools?: Array<{ metadata?: Record<string, unknown> }> }>;
  };
}): void {
  const contexts = run?.Graph?.agentContexts;
  if (!(contexts instanceof Map)) {
    return;
  }
  for (const context of contexts.values()) {
    for (const graphTool of context?.graphTools ?? []) {
      if (!graphTool || typeof graphTool !== 'object') {
        continue;
      }
      graphTool.metadata = {
        ...(graphTool.metadata ?? {}),
        viventiumToolEffectClass: VIVENTIUM_GRAPH_COORDINATION_EFFECT_TOKEN,
      };
    }
  }
}
/* === VIVENTIUM END === */

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
  nativeRequestAuthorityObserver,
  mainContinuityHeaders,
  nativeResponseFetch,
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
  /** Observe the exact visible Main system authority after invocation-fresh route changes. */
  nativeRequestAuthorityObserver?: (value: { instructionAuthority: string }) => void;
  /** Message history for extracting previously discovered tools */
  messages?: BaseMessage[];
  /** Request-local accepted source manifest, checked after graph pruning on every selected route. */
  mainContinuityHeaders?: Readonly<Record<string, string>>;
  nativeResponseFetch?: (
    baseFetch: MainContinuityFetch,
    route: { agentId: string; provider: string; endpoint?: string },
  ) => MainContinuityFetch;
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
  const hasAnyDeferredTools = agents.some(
    (agent) =>
      agent.hasDeferredTools === true ||
      typeof agent.viventiumConnectedAgentInitializer === 'function',
  );

  const discoveredTools =
    hasAnyDeferredTools && messages?.length
      ? extractDiscoveredToolsFromHistory(messages)
      : new Set<string>();

  const agentInputs: AgentInputs[] = [];
  const projectAgentContext = (agent: RunAgent): AgentInputs => {
    const { provider, clientOptions: llmConfig } = normalizeRunModelRoute({
      route: agent,
      agentId: agent.id,
      requestBody,
      user,
      streaming,
      streamUsage,
    });

    const systemContent = buildRunAgentSystemInstructions(agent);

    if (agent === agents[0] && typeof nativeRequestAuthorityObserver === 'function') {
      Object.defineProperty(llmConfig, VIVENTIUM_MODEL_ROUTE_NATIVE_AUTHORITY_OBSERVER, {
        value: nativeRequestAuthorityObserver,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }

    const graphFallbacks = projectGraphLlmFallbacks({
      routes: agent.viventiumGraphLlmFallbacks,
      agentId: agent.id,
      requestBody,
      user,
      streaming,
      streamUsage,
    });
    // Keep accepted source guards local to this run and each exact selected route.
    const sourceChain = mainContinuityHeaders?.[MAIN_CONTINUITY_CHAIN_HEADER];
    const selectedRoutes = [agent, ...(agent.viventiumGraphLlmFallbacks || [])];
    const selectedOptions = [
      llmConfig,
      ...graphFallbacks.map((fallback) => fallback.clientOptions),
    ];
    for (let index = 0; index < selectedOptions.length; index += 1) {
      const options = selectedOptions[index] as t.RunLLMConfig & { callbacks?: Callbacks };
      const configuration = options.configuration;
      const nativeTransport = Boolean(
        (configuration?.defaultHeaders as Record<string, string> | undefined)?.[
          'X-GlassHive-Agent-Id'
        ],
      );
      if (sourceChain) {
        options.callbacks = withMainContinuityCallbacks(
          options.callbacks,
          sourceChain,
          nativeTransport,
        );
      }
      if (!nativeTransport || !configuration) {
        continue;
      }
      const route = selectedRoutes[index];
      const baseFetch = (configuration.fetch || fetch) as MainContinuityFetch;
      const boundFetch = nativeResponseFetch
        ? nativeResponseFetch(baseFetch, {
            agentId: agent.id,
            provider: route.provider,
            endpoint: route.endpoint ?? undefined,
          })
        : baseFetch;
      configuration.fetch = sourceChain
        ? createMainContinuityFetch(boundFetch, sourceChain, mainContinuityHeaders)
        : boundFetch;
    }
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
    return {
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
  };

  const buildAgentContext = (agent: RunAgent) => {
    const sourceInitializer = agent.viventiumConnectedAgentInitializer;
    if (typeof sourceInitializer !== 'function') {
      agentInputs.push(projectAgentContext(agent));
      return;
    }

    const shellInput = projectAgentContext(agent);
    const stableToolRegistry: LCToolRegistry = new Map();
    let hydrationPromise: Promise<AgentInputs> | null = null;
    const materializeConnectedAgent = () => {
      if (hydrationPromise) {
        return hydrationPromise;
      }
      if (signal.aborted) {
        hydrationPromise = Promise.reject(createConnectedAgentAbortError());
        return hydrationPromise;
      }
      hydrationPromise = sourceInitializer().then((initializedAgent) => {
        if (signal.aborted) {
          throw createConnectedAgentAbortError();
        }
        if (!initializedAgent || typeof initializedAgent !== 'object') {
          throw new Error(`Connected agent ${agent.id} initialization returned no configuration`);
        }
        const hydratedInput = projectAgentContext(initializedAgent);
        stableToolRegistry.clear();
        for (const [name, definition] of hydratedInput.toolRegistry ?? []) {
          stableToolRegistry.set(name, definition);
        }
        hydratedInput.toolRegistry = stableToolRegistry;
        return hydratedInput;
      });
      return hydrationPromise;
    };
    Object.defineProperty(shellInput.clientOptions ?? {}, VIVENTIUM_CONNECTED_AGENT_INITIALIZER, {
      value: materializeConnectedAgent,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    shellInput.toolRegistry = stableToolRegistry;
    shellInput.toolDefinitions = [VIVENTIUM_CONNECTED_AGENT_LAZY_SENTINEL];
    agentInputs.push(shellInput);
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

  const run = await Run.create({
    runId,
    graphConfig,
    tokenCounter,
    customHandlers,
    indexTokenCountMap,
  });
  repairAgentContextCompatibility(run);
  markGraphCoordinationTools(run);
  return run;
}
