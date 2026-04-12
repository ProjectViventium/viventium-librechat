/* === VIVENTIUM START ===
 * Feature: Conversation Recall runtime helper tests
 * Added: 2026-02-19
 * === VIVENTIUM END === */

import { EToolResources } from 'librechat-data-provider';
import type { AgentToolResources, TFile } from 'librechat-data-provider';
import {
  buildConversationRecallAttachmentFiles,
  ensureConversationRecallTool,
  getConversationRecallRuntimeScope,
  mergeConversationRecallResources,
} from './conversationRecall';

const recallFiles: TFile[] = [
  {
    user: 'user1',
    file_id: 'recall-file-1',
    filename: 'conversation-recall-all.txt',
    filepath: 'vectordb',
    object: 'file',
    type: 'text/plain',
    bytes: 123,
    embedded: true,
    usage: 0,
  },
];

describe('conversationRecall runtime helpers', () => {
  describe('getConversationRecallRuntimeScope', () => {
    it('returns agent scope when agent toggle is enabled', () => {
      const scope = getConversationRecallRuntimeScope({
        user: {
          personalization: {
            conversation_recall: false,
          },
        } as never,
        agent: {
          conversation_recall_agent_only: true,
        } as never,
      });

      expect(scope).toBe('agent');
    });

    it('returns all scope when user preference is enabled', () => {
      const scope = getConversationRecallRuntimeScope({
        user: {
          personalization: {
            conversation_recall: true,
          },
        } as never,
        agent: {
          conversation_recall_agent_only: false,
        } as never,
      });

      expect(scope).toBe('all');
    });

    it('returns none when both toggles are disabled', () => {
      const scope = getConversationRecallRuntimeScope({
        user: {
          personalization: {
            conversation_recall: false,
          },
        } as never,
        agent: {
          conversation_recall_agent_only: false,
        } as never,
      });

      expect(scope).toBe('none');
    });
  });

  describe('mergeConversationRecallResources', () => {
    it('adds recall files into file_search resources', () => {
      const result = mergeConversationRecallResources({
        tool_resources: {},
        recallFiles,
      });

      expect(result?.[EToolResources.file_search]?.files).toHaveLength(1);
      expect(result?.[EToolResources.file_search]?.file_ids).toEqual(['recall-file-1']);
    });

    it('does not duplicate existing file ids', () => {
      const existingResources: AgentToolResources = {
        [EToolResources.file_search]: {
          file_ids: ['recall-file-1'],
          files: [...recallFiles],
        },
      };

      const result = mergeConversationRecallResources({
        tool_resources: existingResources,
        recallFiles,
      });

      expect(result?.[EToolResources.file_search]?.files).toHaveLength(1);
      expect(result?.[EToolResources.file_search]?.file_ids).toEqual(['recall-file-1']);
    });
  });

  describe('ensureConversationRecallTool', () => {
    it('adds file_search when missing', () => {
      const result = ensureConversationRecallTool(['web_search']);

      expect(result).toEqual(['web_search', 'file_search']);
    });

    it('does not duplicate file_search when already present', () => {
      const result = ensureConversationRecallTool(['file_search', 'web_search']);

      expect(result).toEqual(['file_search', 'web_search']);
    });
  });

  describe('buildConversationRecallAttachmentFiles', () => {
    it('builds a synthetic source-only recall file when no vector file exists yet', () => {
      const result = buildConversationRecallAttachmentFiles({
        userId: 'user1',
        scope: 'all',
        mode: 'source_only',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          file_id: 'conversation_recall:user1:all',
          filename: 'conversation-recall-all.txt',
          viventiumConversationRecallMode: 'source_only',
        }),
      );
    });

    it('decorates existing recall files with attachment mode metadata', () => {
      const result = buildConversationRecallAttachmentFiles({
        userId: 'user1',
        scope: 'all',
        existingFiles: recallFiles,
        mode: 'vector',
      });

      expect(result).toEqual([
        expect.objectContaining({
          file_id: 'recall-file-1',
          viventiumConversationRecallMode: 'vector',
        }),
      ]);
    });
  });
});
