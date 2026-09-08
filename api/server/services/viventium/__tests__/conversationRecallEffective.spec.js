const {
  withEffectiveConversationRecall,
} = require('~/server/services/viventium/conversationRecallService');

describe('withEffectiveConversationRecall', () => {
  test('projects the installer default when the account never chose', () => {
    const projected = withEffectiveConversationRecall(
      { personalization: { memories: true } },
      { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'true' },
    );
    expect(projected.personalization.conversation_recall).toBe(true);
    expect(projected.personalization.memories).toBe(true);
  });

  test('never overrides a saved choice', () => {
    const projected = withEffectiveConversationRecall(
      { personalization: { conversation_recall: false } },
      { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'true' },
    );
    expect(projected.personalization.conversation_recall).toBe(false);
  });

  test('handles a payload without personalization', () => {
    const projected = withEffectiveConversationRecall(
      {},
      { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'false' },
    );
    expect(projected.personalization.conversation_recall).toBe(false);
  });
});
