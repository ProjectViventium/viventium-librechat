/* === VIVENTIUM START ===
 * Feature: Conversation Recall RAG identity helper tests
 * Added: 2026-02-19
 * === VIVENTIUM END === */

import {
  ConversationRecallScope,
  buildConversationRecallFileId,
  buildConversationRecallFilename,
  parseConversationRecallAgentIdFromFilename,
} from '@src/conversationRecall';

describe('conversationRecall helpers', () => {
  describe('buildConversationRecallFilename', () => {
    it('builds all-scope filename', () => {
      expect(buildConversationRecallFilename({ scope: ConversationRecallScope.all })).toBe(
        'conversation-recall-all.txt',
      );
    });

    it('builds agent-scope filename', () => {
      expect(
        buildConversationRecallFilename({
          scope: ConversationRecallScope.agent,
          agentId: 'agent_123',
        }),
      ).toBe('conversation-recall-agent-agent_123.txt');
    });

    it('throws for missing agentId on agent scope', () => {
      expect(() =>
        buildConversationRecallFilename({
          scope: ConversationRecallScope.agent,
        }),
      ).toThrow('agentId is required');
    });
  });

  describe('buildConversationRecallFileId', () => {
    it('builds all-scope file_id', () => {
      expect(
        buildConversationRecallFileId({
          userId: 'user_abc',
          scope: ConversationRecallScope.all,
        }),
      ).toBe('conversation_recall:user_abc:all');
    });

    it('builds agent-scope file_id', () => {
      expect(
        buildConversationRecallFileId({
          userId: 'user_abc',
          scope: ConversationRecallScope.agent,
          agentId: 'agent_123',
        }),
      ).toBe('conversation_recall:user_abc:agent:agent_123');
    });
  });

  describe('parseConversationRecallAgentIdFromFilename', () => {
    it('returns null for all-scope filename', () => {
      expect(parseConversationRecallAgentIdFromFilename('conversation-recall-all.txt')).toBeNull();
    });

    it('extracts agent id for agent-scope filename', () => {
      expect(
        parseConversationRecallAgentIdFromFilename('conversation-recall-agent-agent_123.txt'),
      ).toBe('agent_123');
    });

    it('returns null for invalid format', () => {
      expect(parseConversationRecallAgentIdFromFilename('not-a-recall-file.txt')).toBeNull();
    });
  });
});
