/* === VIVENTIUM START ===
 * Feature: Conversation Recall RAG identity helpers.
 *
 * Purpose:
 * - Provide a single shared way to compute deterministic file IDs and filenames for
 *   conversation-recall vector resources.
 * - Avoid duplicated string construction across backend/runtime surfaces.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

export enum ConversationRecallScope {
  all = 'all',
  agent = 'agent',
}

export const CONVERSATION_RECALL_ALL_FILENAME = 'conversation-recall-all.txt';
export const CONVERSATION_RECALL_AGENT_FILENAME_PREFIX = 'conversation-recall-agent-';

const FILE_ID_PREFIX = 'conversation_recall';

export function buildConversationRecallFilename(params: {
  scope: ConversationRecallScope;
  agentId?: string | null;
}): string {
  if (params.scope === ConversationRecallScope.all) {
    return CONVERSATION_RECALL_ALL_FILENAME;
  }

  const agentId = params.agentId?.trim();
  if (!agentId) {
    throw new Error('agentId is required for agent-scoped conversation recall filenames');
  }

  return `${CONVERSATION_RECALL_AGENT_FILENAME_PREFIX}${agentId}.txt`;
}

export function buildConversationRecallFileId(params: {
  userId: string;
  scope: ConversationRecallScope;
  agentId?: string | null;
}): string {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error('userId is required for conversation recall file IDs');
  }

  if (params.scope === ConversationRecallScope.all) {
    return `${FILE_ID_PREFIX}:${userId}:all`;
  }

  const agentId = params.agentId?.trim();
  if (!agentId) {
    throw new Error('agentId is required for agent-scoped conversation recall file IDs');
  }

  return `${FILE_ID_PREFIX}:${userId}:agent:${agentId}`;
}

export function parseConversationRecallAgentIdFromFilename(filename?: string | null): string | null {
  if (!filename) {
    return null;
  }

  if (!filename.startsWith(CONVERSATION_RECALL_AGENT_FILENAME_PREFIX) || !filename.endsWith('.txt')) {
    return null;
  }

  const core = filename.slice(
    CONVERSATION_RECALL_AGENT_FILENAME_PREFIX.length,
    filename.length - '.txt'.length,
  );
  return core.trim() || null;
}
