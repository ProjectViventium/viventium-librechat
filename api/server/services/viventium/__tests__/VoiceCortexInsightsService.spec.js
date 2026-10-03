/* === VIVENTIUM START ===
 * Feature: Voice cortex insight lookup parity
 * Added: 2026-02-21
 * === VIVENTIUM END === */

let mockGetMessage;
let mockGetMessages;

jest.mock('~/models', () => ({
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

describe('VoiceCortexInsightsService', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn();
    mockGetMessages = jest.fn();
  });

  test('fetches follow-up by metadata.viventium.parentMessageId', async () => {
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: [],
      metadata: {
        viventium: {
          cortexFollowUpDecision: {
            result: 'suppressed',
            suppressionReason: 'no_response_tag',
          },
        },
      },
    });
    mockGetMessages.mockResolvedValueOnce([{ messageId: 'follow-1', text: '  Follow-up text  ' }]);

    const result = await getCompletedCortexInsightsForMessage({
      userId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
    });

    expect(result.followUp).toEqual({
      messageId: 'follow-1',
      text: 'Follow-up text',
    });
    expect(result.followUpDecision).toEqual({
      result: 'suppressed',
      suppressionReason: 'no_response_tag',
    });
    expect(result.presentationRequired).toBe(false);
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conv-1',
      'metadata.viventium.parentMessageId': 'msg-1',
      'metadata.viventium.type': 'cortex_followup',
    });
  });

  test('retains canonical Voice source binding internally without adding fields to the fetched speech', async () => {
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    mockGetMessage.mockResolvedValueOnce({
      messageId: 'parent',
      conversationId: 'conversation',
      metadata: {
        viventium: {
          callSessionId: 'call',
          voiceTaskId: 'task',
          interactionContext: { logical_turn_id: 'turn' },
        },
      },
    });
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'child',
        text: 'Useful result.',
        metadata: { viventium: { cortexInsightDeliveryIds: ['delivery'] } },
      },
    ]);
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'owner',
      messageId: 'parent',
      conversationId: 'conversation',
    });
    expect(result.presentationRequired).toBe(true);
    expect(result.presentationContext).toEqual({
      callSessionId: 'call',
      taskId: 'task',
      turnId: 'turn',
    });
    expect(result.followUp).toEqual({ messageId: 'child', text: 'Useful result.' });
  });
});
