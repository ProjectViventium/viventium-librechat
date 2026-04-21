/* === VIVENTIUM START ===
 * Feature: Conversation Recall runtime policy + resource merge helpers
 *
 * Purpose:
 * - Keep conversation-recall policy logic isolated from agent initialization plumbing.
 * - Reuse file_search tool_resources with minimal mutation and no duplicate files.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

import {
  buildConversationRecallFileId,
  buildConversationRecallFilename,
  ConversationRecallScope,
  EToolResources,
  FileContext,
  Tools,
} from 'librechat-data-provider';
import type { Agent, AgentToolResources, TFile, TUser } from 'librechat-data-provider';

export type ConversationRecallRuntimeScope = 'none' | 'all' | 'agent';
export type ConversationRecallAttachmentMode = 'vector' | 'source_only';
export type ConversationRecallAttachmentReason =
  | 'vector_ready'
  | 'missing_corpus'
  | 'stale_corpus'
  | 'runtime_unconfigured'
  | 'runtime_http_error'
  | 'runtime_timeout'
  | 'runtime_unreachable'
  | 'runtime_stale_restore';

/**
 * Runtime policy:
 * 1) Agent-level `conversation_recall_agent_only` has priority (agent corpus only)
 * 2) User-level personalization `conversation_recall` enables global recall
 * 3) Otherwise disabled
 */
export function getConversationRecallRuntimeScope({
  user,
  agent,
}: {
  user?: TUser | null;
  agent?: Agent | null;
}): ConversationRecallRuntimeScope {
  if (agent?.conversation_recall_agent_only === true) {
    return 'agent';
  }

  if (user?.personalization?.conversation_recall === true) {
    return 'all';
  }

  return 'none';
}

export function mergeConversationRecallResources(params: {
  tool_resources?: AgentToolResources;
  recallFiles: TFile[];
}): AgentToolResources | undefined {
  const { tool_resources, recallFiles } = params;
  if (!recallFiles.length) {
    return tool_resources;
  }

  const nextResources: AgentToolResources = { ...(tool_resources ?? {}) };
  const fileSearchResource = nextResources[EToolResources.file_search] ?? {};
  const existingFiles = fileSearchResource.files ?? [];
  const existingIds = new Set(existingFiles.map((file) => file.file_id));
  const nextFiles = [...existingFiles];

  for (const file of recallFiles) {
    if (!file?.file_id || existingIds.has(file.file_id)) {
      continue;
    }
    existingIds.add(file.file_id);
    nextFiles.push(file);
  }

  if (!nextFiles.length) {
    return nextResources;
  }

  const mergedIds = new Set(fileSearchResource.file_ids ?? []);
  for (const file of nextFiles) {
    if (file.file_id) {
      mergedIds.add(file.file_id);
    }
  }

  nextResources[EToolResources.file_search] = {
    ...fileSearchResource,
    files: nextFiles,
    file_ids: Array.from(mergedIds),
  };

  return nextResources;
}

export function buildConversationRecallAttachmentFiles(params: {
  userId: string;
  scope: ConversationRecallRuntimeScope;
  agentId?: string | null;
  existingFiles?: TFile[] | null;
  mode: ConversationRecallAttachmentMode;
  reason?: ConversationRecallAttachmentReason;
}): TFile[] {
  const { userId, scope, agentId, existingFiles, mode, reason } = params;
  if (scope === 'none') {
    return [];
  }

  const decorate = (file: TFile): TFile =>
    ({
      ...file,
      viventiumConversationRecallMode: mode,
      ...(reason ? { viventiumConversationRecallAttachmentReason: reason } : {}),
    }) as TFile;

  if (Array.isArray(existingFiles) && existingFiles.length > 0) {
    return existingFiles.map((file) => decorate(file));
  }

  return [
    decorate({
      user: userId,
      file_id: buildConversationRecallFileId({
        userId,
        scope: scope === 'agent' ? ConversationRecallScope.agent : ConversationRecallScope.all,
        agentId,
      }),
      filename: buildConversationRecallFilename({
        scope: scope === 'agent' ? ConversationRecallScope.agent : ConversationRecallScope.all,
        agentId,
      }),
      filepath: 'conversation_recall',
      object: 'file',
      type: 'text/plain',
      bytes: 0,
      embedded: mode === 'vector',
      usage: 0,
      context: FileContext.conversation_recall,
    } as TFile),
  ];
}

export function ensureConversationRecallTool(tools?: string[] | null): string[] {
  const nextTools = Array.isArray(tools) ? [...tools] : [];
  if (!nextTools.includes(Tools.file_search)) {
    nextTools.push(Tools.file_search);
  }
  return nextTools;
}
