const {
  buildRecallDerivedParentIdSet,
  isConversationRecallFileId,
  messageUsesConversationRecallSearch,
  shouldSkipRecallMessage,
} = require('../conversationRecallFilters');

describe('conversationRecallFilters', () => {
  test('detects conversation recall source ids structurally', () => {
    expect(isConversationRecallFileId('conversation_recall:user_1:all')).toBe(true);
    expect(isConversationRecallFileId('manual-file-1')).toBe(false);
  });

  test('detects assistant recall-derived turns from file_search attachment provenance', () => {
    expect(
      messageUsesConversationRecallSearch({
        attachments: [
          {
            type: 'file_search',
            file_search: {
              sources: [{ fileId: 'conversation_recall:user_1:all' }],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  test('skips assistant recall-derived turns and their parent user prompts structurally', () => {
    const recallAssistant = {
      messageId: 'assistant_1',
      parentMessageId: 'user_1',
      isCreatedByUser: false,
      attachments: [
        {
          type: 'file_search',
          file_search: {
            sources: [{ fileId: 'conversation_recall:user_1:all' }],
          },
        },
      ],
    };
    const recallDerivedParentIds = buildRecallDerivedParentIdSet([recallAssistant]);

    expect(
      shouldSkipRecallMessage({
        message: recallAssistant,
        messageText: 'Here is what I found in your earlier chats.',
        isCreatedByUser: false,
      }),
    ).toBe(true);

    expect(
      shouldSkipRecallMessage({
        message: { messageId: 'user_1', isCreatedByUser: true },
        messageText: 'What did I say in the other chat?',
        isCreatedByUser: true,
        hasRecallDerivedChild: recallDerivedParentIds.has('user_1'),
      }),
    ).toBe(true);
  });

  test('does not skip a source fact just because it contains exactness wording', () => {
    expect(
      shouldSkipRecallMessage({
        message: { messageId: 'user_source', isCreatedByUser: true },
        messageText: 'QA-only synthetic recall token: ALPHA-123. Reply only with the exact token.',
        isCreatedByUser: true,
        hasRecallDerivedChild: false,
      }),
    ).toBe(false);
  });

  test('does not skip normal content just because it discusses memory or chat history', () => {
    expect(
      shouldSkipRecallMessage({
        message: { messageId: 'memory_system_source', isCreatedByUser: true },
        messageText: 'The memory system design should preserve chat history for QA.',
        isCreatedByUser: true,
        hasRecallDerivedChild: false,
      }),
    ).toBe(false);

    expect(
      shouldSkipRecallMessage({
        message: { messageId: 'assistant_source', isCreatedByUser: false },
        messageText:
          'We can design the memory system fallback using chat history as source evidence.',
        isCreatedByUser: false,
      }),
    ).toBe(false);
  });

  test('skips Listen-Only ambient transcripts from the normal conversation recall corpus', () => {
    expect(
      shouldSkipRecallMessage({
        message: {
          messageId: 'listen_only_1',
          isCreatedByUser: false,
          metadata: {
            viventium: {
              type: 'listen_only_transcript',
              mode: 'listen_only',
              ambientKind: 'ambient_room_transcript',
            },
          },
        },
        messageText: 'Ambient room transcript.',
        isCreatedByUser: false,
      }),
    ).toBe(true);
  });
});
