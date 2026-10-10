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

/* === VIVENTIUM START === Worker callback rows cannot claim cortex presentation. === */
describe('durable callback follow-up selection', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
      content: [],
    });
    mockGetMessages = jest.fn();
  });

  test('returns no cortex follow-up for a marked worker-only row', async () => {
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'synthetic-worker',
        text: 'Worker result.',
        metadata: {
          viventium: {
            followUpSource: 'durable_terminal_callback',
            cortexInsightDeliveryIds: [],
          },
        },
      },
    ]);
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'synthetic-owner',
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
    });
    expect(result.followUp).toBeNull();
    expect(result.insights).toEqual([]);
    expect(result.presentationRequired).toBe(false);
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      'metadata.viventium.parentMessageId': 'synthetic-parent',
      'metadata.viventium.type': 'cortex_followup',
    });
  });

  test.each(['Worker result.', ''])(
    'a marked latest row does not mask an earlier cortex: %j',
    async (workerText) => {
      const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
      mockGetMessages.mockResolvedValueOnce([
        {
          messageId: 'synthetic-cortex',
          text: '  Useful cortex result.  ',
          metadata: { viventium: { cortexInsightDeliveryIds: ['synthetic-delivery'] } },
        },
        {
          messageId: 'synthetic-worker',
          text: workerText,
          metadata: {
            viventium: {
              followUpSource: 'durable_terminal_callback',
              cortexInsightDeliveryIds: [],
            },
          },
        },
      ]);
      const result = await getCompletedCortexInsightsForMessage({
        userId: 'synthetic-owner',
        messageId: 'synthetic-parent',
        conversationId: 'synthetic-conversation',
      });
      expect(result.followUp).toEqual({
        messageId: 'synthetic-cortex',
        text: 'Useful cortex result.',
      });
      expect(result.presentationRequired).toBe(true);
    },
  );

  test('keeps a legacy unmarked row with empty delivery IDs readable', async () => {
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'synthetic-legacy',
        text: '  Legacy cortex result.  ',
        metadata: { viventium: { cortexInsightDeliveryIds: [] } },
      },
    ]);
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'synthetic-owner',
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
    });
    expect(result.followUp).toEqual({
      messageId: 'synthetic-legacy',
      text: 'Legacy cortex result.',
    });
    expect(result.presentationRequired).toBe(false);
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Exact late-publication references keep separate child claims. === */
describe('exact published Cortex child', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
      content: [],
    });
    mockGetMessages = jest.fn();
  });
  test.each(['first-child', 'second-child'])(
    'selects %s without accepting another child',
    async (childId) => {
      mockGetMessages.mockResolvedValueOnce([
        {
          messageId: 'first-child',
          text: 'First authored result.',
          metadata: { viventium: { cortexInsightDeliveryIds: ['first-delivery'] } },
        },
        {
          messageId: 'second-child',
          text: 'Second authored result.',
          metadata: { viventium: { cortexInsightDeliveryIds: ['second-delivery'] } },
        },
      ]);
      const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
      const result = await getCompletedCortexInsightsForMessage({
        userId: 'synthetic-owner',
        messageId: 'synthetic-parent',
        conversationId: 'synthetic-conversation',
        followupMessageId: childId,
      });
      expect(result.followUp.messageId).toBe(childId);
      expect(result.presentationRequired).toBe(true);
      expect(mockGetMessages).toHaveBeenCalledWith({
        user: 'synthetic-owner',
        conversationId: 'synthetic-conversation',
        'metadata.viventium.parentMessageId': 'synthetic-parent',
        'metadata.viventium.type': 'cortex_followup',
        messageId: childId,
      });
    },
  );
  test.each(['missing-child', 'worker-child'])(
    'does not substitute another child for %s',
    async (childId) => {
      mockGetMessages.mockResolvedValueOnce([
        { messageId: 'first-child', text: 'First authored result.' },
        {
          messageId: 'worker-child',
          text: 'Worker result.',
          metadata: { viventium: { followUpSource: 'durable_terminal_callback' } },
        },
      ]);
      const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
      const result = await getCompletedCortexInsightsForMessage({
        userId: 'synthetic-owner',
        messageId: 'synthetic-parent',
        conversationId: 'synthetic-conversation',
        followupMessageId: childId,
      });
      expect(result.followUp).toBeNull();
      expect(result.presentationRequired).toBe(false);
    },
  );
  test('keeps omitted-reference latest behavior', async () => {
    mockGetMessages.mockResolvedValueOnce([
      { messageId: 'first-child', text: 'First authored result.' },
      { messageId: 'second-child', text: 'Second authored result.' },
    ]);
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'synthetic-owner',
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
    });
    expect(result.followUp.messageId).toBe('second-child');
    expect(mockGetMessages.mock.calls[0][0]).not.toHaveProperty('messageId');
  });
  test('rejects a foreign parent conversation before child lookup', async () => {
    mockGetMessage.mockResolvedValueOnce({
      messageId: 'synthetic-parent',
      conversationId: 'foreign',
    });
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'synthetic-owner',
      messageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
      followupMessageId: 'first-child',
    });
    expect(result).toBeNull();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Saved delivery decisions govern only the Voice projection. === */
describe('saved Phase B audio disposition', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'parent',
      conversationId: 'conversation',
      content: [
        { type: 'cortex_insight', status: 'complete', insight: 'Must not bypass silence.' },
      ],
    });
    mockGetMessages = jest.fn();
  });
  test.each([
    ['skip', true, null],
    ['skip', false, null],
    ['eligible', true, { messageId: 'latest', text: 'Saved text and file.' }],
  ])('projects %s valid=%s without losing saved text', async (audio, valid, expected) => {
    const saved = {
      messageId: 'latest',
      text: 'Saved text and file.',
      metadata: {
        viventium: {
          deliveryDisposition: {
            version: 1,
            audio,
            required: true,
            valid,
            source: valid ? 'model' : 'required_missing',
          },
          cortexInsightDeliveryIds: ['accepted-insight'],
        },
      },
    };
    mockGetMessages.mockResolvedValueOnce([
      { messageId: 'earlier', text: 'Do not fall back.' },
      saved,
    ]);
    const { getCompletedCortexInsightsForMessage } = require('../VoiceCortexInsightsService');
    const result = await getCompletedCortexInsightsForMessage({
      userId: 'owner',
      messageId: 'parent',
      conversationId: 'conversation',
    });
    expect(result.followUp).toEqual(expected);
    if (audio === 'skip') {
      expect(result.insights).toEqual([]);
      expect(result.followUpDecision).toMatchObject({
        result: 'suppressed',
        suppressionReason: 'audio_delivery_disposition',
      });
      expect(result.presentationRequired).toBe(false);
    }
    expect(saved.text).toBe('Saved text and file.');
  });
});
/* === VIVENTIUM END === */
