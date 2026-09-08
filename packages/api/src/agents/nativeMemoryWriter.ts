/* === VIVENTIUM START === Broker transport for the existing admitted memory writer. === */
import { randomUUID } from 'crypto';
import { isZodSchema, toJsonSchema } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { MemoryArtifact, Tools } from 'librechat-data-provider';
import type { OpenAIConfiguration, RequestBody } from '~/types';
import type { createRun } from './run';

export interface NativeMemoryWriterIdentity {
  userId: string;
  messageId: string;
  conversationId: string;
  owner: string;
}

type ToolResult = [string, Record<Tools.memory, MemoryArtifact> | undefined];
type RunAgent = Parameters<typeof createRun>[0]['agents'][number];
type RunUser = Parameters<typeof createRun>[0]['user'];
type NativeMemoryResource = NativeMemoryWriterIdentity & {
  version: number;
  bindingId: string;
};
interface Grant {
  user_id?: string;
  message_id?: string;
  conversation_id?: string;
  worker_id?: string;
  run_id?: string;
  schedule_id?: string;
  allow_dynamic_policy_servers?: boolean;
  allowed_servers?: string[];
  allowed_host_tools?: string[];
  host_tool_resources?: Record<string, Partial<NativeMemoryResource>>;
}
interface NativeMemoryBundle {
  glasshive_capability_broker?: object;
  provider_capabilities?: { native_tools?: boolean };
}
interface BundleInput {
  user: RunUser;
  requestBody: RequestBody;
  allowedServerNames: string[];
  allowedHostTools: string[];
  hostToolResources: Record<string, NativeMemoryResource>;
}

export type NativeMemoryExecutor = (input: {
  tool: DynamicStructuredTool;
  messages: BaseMessage[];
  instructions: string;
  onResult: (result: ToolResult, callId: string) => Promise<void>;
}) => Promise<void>;

/** The coordinator retains this callback only while its existing admitted writer is active.
 * One apply call matches the existing tool protocol. Transport repeats return the same result;
 * a changed second call cannot apply another batch or rebase its revision snapshot. */
export function createNativeMemoryToolBinding({
  identity,
  tool,
  authorize,
  onResult,
}: {
  identity: NativeMemoryWriterIdentity;
  tool: DynamicStructuredTool;
  authorize: () => Promise<void>;
  onResult: (result: ToolResult, callId: string) => Promise<void>;
}) {
  const schema = tool.schema;
  if (!isZodSchema(schema)) throw new Error('native_memory_tool_schema_unavailable');
  const bindingId = randomUUID();
  const resource = { version: 1, bindingId, ...identity };
  let accepting = true;
  let inputJson: string | undefined;
  let pending: Promise<{ status: string; tool: string; result: ToolResult }> | undefined;
  const definition = {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.schema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
  const matchesIdentity = (other?: Partial<NativeMemoryWriterIdentity>) =>
    Boolean(
      other &&
      Object.keys(identity).every(
        (key) => identity[key as keyof typeof identity] === other[key as keyof typeof identity],
      ),
    );
  const accepts = (grant: Grant) => {
    const supplied = grant?.host_tool_resources?.[tool.name];
    return (
      accepting &&
      grant?.user_id === identity.userId &&
      grant?.message_id === identity.messageId &&
      grant?.conversation_id === identity.conversationId &&
      !grant?.worker_id &&
      !grant?.run_id &&
      !grant?.schedule_id &&
      grant?.allow_dynamic_policy_servers === false &&
      Array.isArray(grant?.allowed_servers) &&
      grant.allowed_servers.length === 0 &&
      Array.isArray(grant?.allowed_host_tools) &&
      grant.allowed_host_tools.length === 1 &&
      grant.allowed_host_tools[0] === tool.name &&
      supplied?.version === 1 &&
      supplied?.bindingId === bindingId &&
      matchesIdentity(supplied)
    );
  };
  return {
    identity,
    resource,
    definition,
    matchesIdentity,
    accepts,
    async invoke(grant: Grant, args: unknown) {
      if (!accepts(grant)) throw new Error('native_memory_writer_not_active');
      await authorize();
      if (!accepts(grant)) throw new Error('native_memory_writer_not_active');
      const parsed = await schema.parseAsync(args);
      const canonical = JSON.stringify(parsed);
      if (pending) {
        if (canonical !== inputJson) throw new Error('native_memory_batch_already_submitted');
        return pending;
      }
      inputJson = canonical;
      pending = (async () => {
        await authorize();
        if (!accepts(grant)) throw new Error('native_memory_writer_not_active');
        const result = (await tool.func(parsed)) as ToolResult;
        await onResult(result, bindingId);
        return { status: 'ok', tool: tool.name, result };
      })();
      return pending;
    },
    async finish() {
      accepting = false;
      if (!pending) throw new Error('native_memory_tool_not_called');
      await pending;
    },
  };
}

export type NativeMemoryToolBinding = ReturnType<typeof createNativeMemoryToolBinding>;

/** Dependencies reuse the host's existing broker/signing and active-writer owner. */
export function createNativeMemoryExecutor({
  identity,
  agent,
  user,
  requestBody,
  authorize,
  register,
  buildBundle,
  attachBundle,
  createProviderRun,
}: {
  identity: NativeMemoryWriterIdentity;
  agent: RunAgent;
  user: RunUser;
  requestBody: RequestBody;
  authorize: () => Promise<void>;
  register: (binding: NativeMemoryToolBinding) => () => void;
  buildBundle: (args: BundleInput) => Promise<NativeMemoryBundle | null>;
  attachBundle: (args: { targetAgent: RunAgent; bundle: NativeMemoryBundle }) => boolean;
  createProviderRun: typeof createRun;
}): NativeMemoryExecutor {
  return async ({ tool, messages, instructions, onResult }) => {
    await authorize();
    const binding = createNativeMemoryToolBinding({
      identity,
      tool,
      authorize,
      onResult,
    });
    const unregister = register(binding);
    let providerError: unknown;
    let toolCompleted = false;
    try {
      const invocationId = `memory_${binding.resource.bindingId}`;
      const body = {
        ...requestBody,
        conversationId: identity.conversationId,
        messageId: identity.messageId,
        viventiumGlassHiveIdempotencyKey: invocationId,
        viventiumStreamId: invocationId,
      };
      // Main owns this mutable carrier; the writer already receives its own memory input and time.
      delete body.viventiumGlassHiveTurnContextB64;
      const parameters = agent.model_parameters as RunAgent['model_parameters'] & {
        configuration?: OpenAIConfiguration;
      };
      const configuration = { ...(parameters.configuration ?? {}) };
      configuration.defaultHeaders = {
        ...(configuration.defaultHeaders ?? {}),
        'X-GlassHive-Agent-Id': invocationId,
        'X-GlassHive-Fallback-Model': '',
        'X-GlassHive-Fallback-Reasoning-Effort': '',
      };
      const nativeAgent = {
        ...agent,
        id: invocationId,
        tools: [],
        toolDefinitions: [],
        toolRegistry: undefined,
        toolContextMap: undefined,
        hasDeferredTools: false,
        instructions,
        additional_instructions: undefined,
        model_parameters: { ...agent.model_parameters, configuration },
        // No Main graph, model fallback, capability refresher, or answer-recovery binding is inherited.
        agent_ids: undefined,
        edges: undefined,
        viventiumGraphLlmFallbacks: undefined,
        viventiumFallbackLlm: undefined,
        viventiumConversationProviderCapabilityRefresh: undefined,
      } as RunAgent;
      const bundle = await buildBundle({
        user,
        requestBody: body,
        allowedServerNames: [],
        allowedHostTools: [tool.name],
        hostToolResources: { [tool.name]: binding.resource },
      });
      if (!bundle?.glasshive_capability_broker) {
        throw new Error('native_memory_broker_unavailable');
      }
      const restrictedBundle = {
        ...bundle,
        provider_capabilities: {
          ...bundle.provider_capabilities,
          native_tools: false,
        },
      };
      if (!attachBundle({ targetAgent: nativeAgent, bundle: restrictedBundle })) {
        throw new Error('native_memory_broker_unavailable');
      }
      const run = await createProviderRun({
        agents: [nativeAgent],
        requestBody: body,
        user,
        runId: invocationId,
        signal: new AbortController().signal,
        streaming: false,
        streamUsage: false,
        customHandlers: {},
      });
      await run.processStream(
        { messages },
        {
          runName: 'MemoryRun',
          configurable: {
            user_id: identity.userId,
            thread_id: identity.conversationId,
          },
          streamMode: 'values',
          recursionLimit: 3,
          version: 'v2',
        },
      );
    } catch (error) {
      providerError = error;
    } finally {
      try {
        await binding.finish();
        toolCompleted = true;
      } catch (error) {
        providerError ??= error;
      }
      unregister();
    }
    const providerCode = (providerError as { code?: unknown } | undefined)?.code;
    // The signed memory tool owns its completed effect; it does not require an authored chat answer.
    if (providerError && !(toolCompleted && providerCode === 'missing_terminal_response')) {
      throw providerError;
    }
  };
}
/* === VIVENTIUM END === */
