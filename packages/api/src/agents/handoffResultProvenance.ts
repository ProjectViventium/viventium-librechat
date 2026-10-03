/* === VIVENTIUM START === Preserve completed consults as attributed tool results. === */
import { extractTextFromContent } from '@librechat/agents';
import type { JsonValue } from '@librechat/agents';
import { isCommand } from '@langchain/langgraph';
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
  createHandoffToolsForEdge(
    edge: AgentGraphEdge, sourceAgentId: string, sourceAgentName: string,
  ): DynamicStructuredTool[];
  processHandoffReception(messages: BaseMessage[], agentId: string): HandoffContext | null;
  [key: symbol]: unknown;
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
  prototype.processHandoffReception = function (messages, receiverId) {
    const result = receive.call(this, messages, receiverId);
    if (!result) return result;
    const restored = restoreCompletedHandoffPair(messages, result.filteredMessages, receiverId);
    return restored ? { ...result, filteredMessages: restored } : result;
  };
  Object.defineProperty(prototype, patchMarker, { value: true });
  return true;
}
/* === VIVENTIUM END === */
