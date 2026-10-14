/* === VIVENTIUM START === Preserve completed consults as attributed tool results. === */
import { extractTextFromContent } from '@librechat/agents';
import type { JsonValue, GraphEdge, MultiAgentGraphState } from '@librechat/agents';
import { Command, isCommand } from '@langchain/langgraph';
import type { Runnable, RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolMessage, isAIMessage, isToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentGraphEdge } from './sourceComponentStarts';

interface HandoffContext {
  filteredMessages: BaseMessage[];
  instructions: string | null;
  sourceAgentName: string | null;
  parallelSiblings: string[];
}

interface HandoffPrototype {
  agentContexts?: Map<string, { name?: string }>;
  handoffEdges?: GraphEdge[];
  createCallModel?(agentId?: string): (state: GraphState, config?: RunnableConfig) => Promise<unknown>;
  createWorkflow?(): { nodes: { [agentId: string]: { bound: Runnable<GraphState, GraphState | Command> } } };
  createHandoffToolsForEdge(
    edge: AgentGraphEdge, sourceAgentId: string, sourceAgentName: string,
  ): DynamicStructuredTool[];
  processHandoffReception(messages: BaseMessage[], agentId: string): HandoffContext | null;
  [key: symbol]: unknown;
}

type GraphState = MultiAgentGraphState;
interface PendingConsult {
  callerId: string;
  childId: string;
  userMessageId: string;
  call: AIMessage;
  transfer: ToolMessage;
  resultId?: string;
  result?: AIMessage | ToolMessage;
  scope: string;
  key: string;
  receiverScope?: string;
  resultUserMessageId?: string;
}

// These are typed public native-provider codes, not exception text or HTTP tool errors.
const consultProviderCodes = new Map([
  ['rate_limit_error', 'provider_rate_limited'],
  ['rate_limit_exceeded', 'provider_rate_limited'],
  ['provider_rate_limited', 'provider_rate_limited'],
  ['provider_quota_exhausted', 'provider_quota_exhausted'],
  ['provider_temporarily_unavailable', 'provider_temporarily_unavailable'],
  ['provider_response_failed', 'provider_response_failed'],
]);

export function nativeConsultProviderFailure(error: unknown): string | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  let code: string | null = null;
  for (let index = 0; index < queue.length && index < 16; index++) {
    const value = queue[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const item = value as Record<string, unknown>;
    if (item.name === 'AbortError' || item.code === 'ABORT_ERR') return null;
    for (const field of ['errorClass', 'error_class', 'errorCode', 'error_code', 'code', 'type']) {
      if (item[field] == null) continue;
      if (typeof item[field] !== 'string') return null;
      const projected = consultProviderCodes.get(item[field] as string);
      if (!projected || (code && projected !== code)) return null;
      code = projected;
    }
    queue.push(item.cause, item.error);
    if (item.response && typeof item.response === 'object') {
      const response = item.response as Record<string, unknown>;
      queue.push(response.data);
    }
  }
  return queue.length > 16 ? null : code;
}

function consultScope(config?: RunnableConfig): string | null {
  const runId = config?.configurable?.run_id;
  const threadId = config?.configurable?.thread_id;
  return typeof runId === 'string' && runId && typeof threadId === 'string' && threadId
    ? JSON.stringify([threadId, runId]) : null;
}

function declaredHiddenReturn(graph: HandoffPrototype, active: PendingConsult,
  config?: RunnableConfig): boolean {
  const presentation = config?.configurable;
  const visible = presentation?.visible_agent_ids;
  return presentation?.hide_sequential_outputs === true && Array.isArray(visible) &&
    !visible.includes(active.childId) && visible.includes(presentation.main_agent_id) &&
    graph.agentContexts?.has(active.callerId) === true &&
    graph.handoffEdges?.some((edge) => {
      const from = typeof edge.from === 'string' ? [edge.from] : edge.from ?? [];
      const to = typeof edge.to === 'string' ? [edge.to] : edge.to ?? [];
      return edge.condition == null && from.includes(active.childId) && to.includes(active.callerId);
    }) === true;
}

function currentUserId(messages: BaseMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].getType() === 'human') return messages[index].id;
  }
  return undefined;
}

function pendingConsult(messages: BaseMessage[], childId: string, scope: string): PendingConsult | null {
  const userMessageId = currentUserId(messages);
  if (!userMessageId) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const transfer = messages[index];
    if (transfer.getType() === 'human') break;
    if (!isToolMessage(transfer) || !transfer.id ||
        transfer.additional_kwargs.handoff_destination !== childId) continue;
    const siblings = transfer.additional_kwargs.handoff_parallel_siblings;
    if (Array.isArray(siblings) && siblings.length > 0) return null;
    const callerId = transfer.additional_kwargs.handoff_source_agent_id;
    if (typeof callerId !== 'string' || callerId === childId) return null;
    let call: BaseMessage | undefined;
    for (let callIndex = index - 1; callIndex >= 0; callIndex--) {
      const message = messages[callIndex];
      if (isAIMessage(message) &&
          message.tool_calls?.some((entry) => entry.id === transfer.tool_call_id)) {
        call = message;
        break;
      }
    }
    if (!call || !isAIMessage(call) || !call.id || call.tool_calls?.length !== 1 ||
        call.tool_calls[0].name !== transfer.name) return null;
    return { callerId, childId, userMessageId, call, transfer, scope,
      key: JSON.stringify([scope, childId]) };
  }
  return null;
}

function completedConsultContext(
  messages: BaseMessage[], consult: PendingConsult, sourceAgentName: string | null,
): HandoffContext | null {
  if (!consult.result || messages.at(-1)?.id !== consult.resultId ||
      currentUserId(messages) !== consult.resultUserMessageId) return null;
  const filteredMessages = messages.filter((message) => message.id !== consult.resultId &&
    message.id !== consult.transfer.id);
  const callIndex = filteredMessages.findIndex((message) => message.id === consult.call.id);
  if (callIndex < 0) return null;
  // Complete the original call, preserving the child's exact authored result and metadata.
  const content = typeof consult.result.content === 'string' ? consult.result.content :
    extractTextFromContent(consult.result.content.filter((part) =>
      part != null && typeof part === 'object' && part.type === 'text') as JsonValue);
  const result = new ToolMessage({ ...consult.transfer, content,
    response_metadata: consult.result.response_metadata,
    ...(isToolMessage(consult.result) ? { status: consult.result.status } : {}),
    additional_kwargs: { ...consult.result.additional_kwargs, ...consult.transfer.additional_kwargs } });
  filteredMessages.splice(callIndex, 1, consult.call, result);
  return { filteredMessages, instructions: null, sourceAgentName, parallelSiblings: [] };
}

interface HandoffModule {
  MultiAgentGraph?: { prototype?: HandoffPrototype };
}

const patchMarker = Symbol.for('viventium.librechat_agents.handoff_result_provenance.v1');

export function restoreCompletedHandoffPair(
  messages: BaseMessage[], filteredMessages: BaseMessage[], receiverId: string,
): BaseMessage[] | null {
  let returnToolIndex = -1;
  let currentTurnStart = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.getType() === 'human') { currentTurnStart = index; break; }
    if (returnToolIndex >= 0 || !(isToolMessage(message))) continue;
    if (message.additional_kwargs.handoff_destination === receiverId &&
        typeof message.additional_kwargs.handoff_source_agent_id === 'string') {
      returnToolIndex = index;
    }
  }
  if (returnToolIndex < 0) return null;
  const returned = messages[returnToolIndex] as ToolMessage;
  const sourceId = returned.additional_kwargs.handoff_source_agent_id;
  if (sourceId === receiverId) return null;
  let returnAi: AIMessage | null = null;
  for (let index = returnToolIndex - 1; index > currentTurnStart; index--) {
    const message = messages[index];
    if (isAIMessage(message) && message.tool_calls?.length === 1 &&
        message.tool_calls[0].id === returned.tool_call_id) {
      returnAi = message; break;
    }
  }
  if (!returnAi?.id) return null;
  const returnedText = typeof returnAi.content === 'string' ? returnAi.content :
    extractTextFromContent(returnAi.content.filter((part) =>
      part != null && typeof part === 'object' && part.type === 'text') as JsonValue);
  if (!returnedText.trim()) return null;
  let consultTool: ToolMessage | null = null;
  let consultAi: AIMessage | null = null;
  for (let index = returnToolIndex - 1; index > currentTurnStart; index--) {
    const message = messages[index];
    if (!consultTool && isToolMessage(message) &&
        message.additional_kwargs.handoff_source_agent_id === receiverId &&
        message.additional_kwargs.handoff_destination === sourceId) {
      consultTool = message;
      continue;
    }
    if (consultTool && isAIMessage(message) &&
        message.tool_calls?.some((call) => call.id === consultTool?.tool_call_id)) {
      consultAi = message; break;
    }
  }
  if (!consultTool || !consultAi?.id) return null;
  const call = consultAi.tool_calls?.find((entry) => entry.id === consultTool?.tool_call_id);
  if (!call) return null;
  const result = filteredMessages.filter((message) => message.id !== returnAi?.id);
  const existingIndex = result.findIndex((message) => message.id === consultAi?.id);
  const existing = existingIndex >= 0 ? result[existingIndex] : null;
  const remainingCalls = existing && isAIMessage(existing) ? existing.tool_calls ?? [] : [];
  const restoredAi = new AIMessage({ ...consultAi, tool_calls: [
    ...remainingCalls.filter((entry) => entry.id !== call.id), call,
  ] });
  const restoredTool = new ToolMessage({ ...consultTool, content: returnedText });
  if (existingIndex >= 0) {
    result.splice(existingIndex, 1, restoredAi, restoredTool);
  } else {
    result.push(restoredAi, restoredTool);
  }
  return result;
}

export function installLibreChatAgentsHandoffResultPatch(module: HandoffModule): boolean {
  const prototype = module.MultiAgentGraph?.prototype;
  if (!prototype || typeof prototype.createHandoffToolsForEdge !== 'function' ||
      typeof prototype.processHandoffReception !== 'function') return false;
  if (prototype[patchMarker] === true) return true;
  const createTools = prototype.createHandoffToolsForEdge;
  prototype.createHandoffToolsForEdge = function (...args) {
    const tools = createTools.apply(this, args);
    for (const tool of tools) {
      const invoke = tool.func.bind(tool);
      tool.func = async (...input) => {
        const result = await invoke(...input);
        if (!isCommand(result)) return result;
        const destination = typeof result.goto === 'string' ? result.goto :
          Array.isArray(result.goto) && result.goto.length === 1 &&
          typeof result.goto[0] === 'string' ? result.goto[0] : null;
        if (!destination || !result.update || !('messages' in result.update) ||
            !Array.isArray(result.update.messages)) return result;
        const message = result.update.messages.at(-1);
        if (isToolMessage(message)) {
          message.additional_kwargs = { ...message.additional_kwargs,
            handoff_source_agent_id: args[1], handoff_destination: destination };
        }
        return result;
      };
    }
    return tools;
  };
  const receive = prototype.processHandoffReception;
  const consults = new WeakMap<object, Map<string, PendingConsult>>();
  prototype.processHandoffReception = function (messages, receiverId) {
    const pending = consults.get(this);
    const completed = [...(pending?.values() ?? [])].filter((entry) =>
      entry.callerId === receiverId && entry.receiverScope === entry.scope &&
      entry.resultId === messages.at(-1)?.id && currentUserId(messages) === entry.resultUserMessageId);
    if (completed.length === 1) {
      const entry = completed[0];
      pending?.delete(entry.key);
      const context = completedConsultContext(messages, entry,
        this.agentContexts?.get(entry.childId)?.name ?? null);
      if (context) return context;
    }
    const result = receive.call(this, messages, receiverId);
    if (!result) return result;
    const restored = restoreCompletedHandoffPair(messages, result.filteredMessages, receiverId);
    return restored ? { ...result, filteredMessages: restored } : result;
  };
  // Only the final model-attempt boundary establishes provider origin. A tool may throw
  // the same API code; catching it at the whole subgraph boundary would hide a tool failure.
  const providerFailures = new WeakMap<object, { graph: object; childId: string; scope: string; code: string; active: PendingConsult }>();
  const createCallModel = prototype.createCallModel;
  if (typeof createCallModel === 'function') {
    prototype.createCallModel = function (childId = 'default') {
      const invoke = createCallModel.call(this, childId);
      return async (state, config) => {
        const scope = consultScope(config);
        const active = scope ? consults.get(this)?.get(JSON.stringify([scope, childId])) : undefined;
        try { return await invoke(state, config); }
        catch (error) {
          const code = nativeConsultProviderFailure(error);
          if (error && typeof error === 'object' && scope && code && active && !config?.signal?.aborted &&
              state.messages.some((message) => message.getType() === 'human' && message.id === active.userMessageId))
            providerFailures.set(error, { graph: this, childId, scope, code, active });
          throw error;
        }
      };
    };
  }
  const createWorkflow = prototype.createWorkflow;
  if (typeof createWorkflow === 'function') {
    prototype.createWorkflow = function () {
      const workflow = createWorkflow.call(this);
      const nodes = workflow?.nodes;
      if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes) ||
          [...(this.agentContexts?.keys() ?? [])].some((id) =>
            typeof nodes[id]?.bound?.invoke !== 'function' || !Object.isExtensible(nodes[id].bound))) {
        console.warn('[Viventium][handoff] Terminal return unavailable: unsupported SDK node shape.');
        return workflow;
      }
      for (const [childId, node] of Object.entries(nodes)) {
        if (!this.agentContexts?.has(childId)) continue;
        const invoke = node.bound.invoke.bind(node.bound);
        node.bound.invoke = async (state: GraphState, config?: RunnableConfig) => {
          const runId = config?.configurable?.run_id;
          const threadId = config?.configurable?.thread_id;
          if (typeof runId !== 'string' || !runId || typeof threadId !== 'string' || !threadId)
            return invoke(state, config);
          const scope = JSON.stringify([threadId, runId]);
          let current = consults.get(this);
          if (!current) { current = new Map(); consults.set(this, current); }
          for (const entry of current.values()) {
            if (entry.scope === scope && entry.callerId === childId &&
                entry.resultId === state.messages.at(-1)?.id) entry.receiverScope = scope;
          }
          const consult = pendingConsult(state.messages, childId, scope);
          const key = JSON.stringify([scope, childId]);
          if (consult && current.get(key)?.transfer.tool_call_id !== consult.transfer.tool_call_id)
            current.set(key, consult);
          const active = current.get(key);
          const userAtStart = currentUserId(state.messages);
          let result: GraphState | Command;
          try { result = await invoke(state, config); }
          catch (error) {
            const failure = error && typeof error === 'object' ? providerFailures.get(error) : null;
            if (error && typeof error === 'object') providerFailures.delete(error);
            if (!failure || failure.graph !== this || failure.childId !== childId ||
                failure.scope !== scope || !active || failure.active !== active || current.get(key) !== active ||
                config?.signal?.aborted || currentUserId(state.messages) !== userAtStart ||
                userAtStart !== active.userMessageId || !declaredHiddenReturn(this, active, config)) {
              if (current.get(key) === active) current.delete(key);
              throw error;
            }
            const failed = new ToolMessage({ ...active.transfer, status: 'error',
              content: JSON.stringify({ status: 'failed', error: { code: failure.code } }),
              additional_kwargs: { ...active.transfer.additional_kwargs,
                handoff_failure: { version: 1, code: failure.code } } });
            active.resultId = failed.id;
            active.result = failed;
            active.resultUserMessageId = userAtStart;
            return new Command({ goto: active.callerId, update: { ...state,
              messages: [...state.messages.filter((message) => message.id !== failed.id), failed] } });
          }
          if (config?.signal?.aborted) { if (current.get(key) === active) current.delete(key); return result; }
          if (isCommand(result)) return result;
          const terminal = result.messages?.at(-1);
          const presentation = config?.configurable;
          if (childId === presentation?.main_agent_id && terminal && isAIMessage(terminal) &&
              !terminal.tool_calls?.length) {
            for (const [id, entry] of current) if (entry.scope === scope) current.delete(id);
          }
          if (!active || current.get(key) !== active || config?.signal?.aborted ||
              currentUserId(state.messages) !== userAtStart ||
              !terminal || !isAIMessage(terminal) || terminal.tool_calls?.length || !terminal.id ||
              terminal.id === active.call.id || terminal.id === active.transfer.id ||
              !result.messages.some((message) => message.getType() === 'human' && message.id === active.userMessageId) ||
              !declaredHiddenReturn(this, active, config)) return result;
          active.resultId = terminal.id;
          active.result = terminal;
          active.resultUserMessageId = currentUserId(result.messages);
          return new Command({ goto: active.callerId, update: result });
        };
      }
      return workflow;
    };
  }
  Object.defineProperty(prototype, patchMarker, { value: true });
  return true;
}
/* === VIVENTIUM END === */
