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
  result?: AIMessage;
  scope: string;
  key: string;
  receiverScope?: string;
  resultUserMessageId?: string;
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
          catch (error) { current.delete(key); throw error; }
          if (config?.signal?.aborted) { current.delete(key); return result; }
          if (isCommand(result)) return result;
          const terminal = result.messages?.at(-1);
          const presentation = config?.configurable;
          const visible = presentation?.visible_agent_ids;
          if (childId === presentation?.main_agent_id && terminal && isAIMessage(terminal) &&
              !terminal.tool_calls?.length) {
            for (const [id, entry] of current) if (entry.scope === scope) current.delete(id);
          }
          if (!active || current.get(key) !== active || config?.signal?.aborted ||
              currentUserId(state.messages) !== userAtStart ||
              !terminal || !isAIMessage(terminal) || terminal.tool_calls?.length || !terminal.id ||
              terminal.id === active.call.id || terminal.id === active.transfer.id ||
              !result.messages.some((message) => message.getType() === 'human' && message.id === active.userMessageId) ||
              presentation?.hide_sequential_outputs !== true || !Array.isArray(visible) ||
              visible.includes(childId) || !visible.includes(presentation.main_agent_id) ||
              !this.agentContexts?.has(active.callerId) ||
              !this.handoffEdges?.some((edge) => {
                const from = typeof edge.from === 'string' ? [edge.from] : edge.from ?? [];
                const to = typeof edge.to === 'string' ? [edge.to] : edge.to ?? [];
                return edge.condition == null && from.includes(childId) && to.includes(active.callerId); 
              })) return result;
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
