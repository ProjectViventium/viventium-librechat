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
import { isEnabled } from '~/utils/common';

export type ConversationRecallRuntimeScope = 'none' | 'all' | 'agent';
export type ConversationRecallAttachmentMode = 'vector' | 'source_only';
export type ConversationRecallAttachmentReason =
  | 'vector_ready'
  | 'missing_corpus'
  | 'stale_corpus'
  | 'runtime_unconfigured'
  | 'runtime_http_error'
  | 'runtime_unhealthy'
  | 'runtime_invalid_response'
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

  if (resolveConversationRecallPreference(user)) {
    return 'all';
  }

  return 'none';
}

/* === VIVENTIUM START ===
 * Feature: Installer default for conversation recall.
 * Purpose: An account that never chose a recall preference follows the compiled installer default
 * (`VIVENTIUM_DEFAULT_CONVERSATION_RECALL`); an explicit saved choice always wins.
 * === VIVENTIUM END === */
export function resolveConversationRecallPreference(
  user?: Pick<TUser, 'personalization'> | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const choice = user?.personalization?.conversation_recall;
  if (typeof choice === 'boolean') {
    return choice;
  }
  return isEnabled(env.VIVENTIUM_DEFAULT_CONVERSATION_RECALL);
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

/* === VIVENTIUM START ===
 * Reconstruct rowless source recall from the authorized current scope, never staged metadata.
 * === VIVENTIUM END === */
export function rebuildSourceOnlyConversationRecallFiles({
  user,
  agent,
  files,
}: {
  user: TUser;
  agent: Agent;
  files: Array<Pick<TFile, 'file_id'> & { viventiumConversationRecallMode?: string }>;
}): TFile[] {
  if (!user?.id || !agent?.id) {
    return [];
  }
  const requestedIds = new Set(
    files
      .filter((file) => file.viventiumConversationRecallMode === 'source_only')
      .map((file) => file.file_id),
  );
  return buildConversationRecallAttachmentFiles({
    userId: user.id,
    agentId: agent.id,
    scope: getConversationRecallRuntimeScope({ user, agent }),
    mode: 'source_only',
  }).filter((file) => requestedIds.has(file.file_id));
}

export function ensureConversationRecallTool(tools?: string[] | null): string[] {
  const nextTools = Array.isArray(tools) ? [...tools] : [];
  if (!nextTools.includes(Tools.file_search)) {
    nextTools.push(Tools.file_search);
  }
  return nextTools;
}
