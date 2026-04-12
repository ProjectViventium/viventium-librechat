const {
  buildConversationRecallInstructions,
  resolveConversationRecallPromptText,
} = require('../conversationRecallPrompt');

describe('conversationRecallPrompt', () => {
  test('returns empty string when conversation recall is disabled', () => {
    const text = buildConversationRecallInstructions({
      req: {
        user: {
          personalization: {
            conversation_recall: false,
          },
        },
      },
      agent: {
        conversation_recall_agent_only: false,
      },
    });

    expect(text).toBe('');
  });

  test('returns empty string when recall is enabled but no YAML prompt is configured', () => {
    const text = buildConversationRecallInstructions({
      req: {
        user: {
          personalization: {
            conversation_recall: true,
          },
        },
      },
      agent: {
        conversation_recall_agent_only: false,
      },
    });

    expect(text).toBe('');
  });

  test('uses config override when present', () => {
    const req = {
      config: {
        viventium: {
          conversation_recall: {
            prompt: 'CUSTOM RECALL PROMPT',
          },
        },
      },
      user: {
        personalization: {
          conversation_recall: false,
        },
      },
    };

    expect(resolveConversationRecallPromptText(req)).toBe('CUSTOM RECALL PROMPT');
    expect(
      buildConversationRecallInstructions({
        req,
        agent: {
          conversation_recall_agent_only: true,
        },
      }),
    ).toBe('CUSTOM RECALL PROMPT');
  });
});
