/* === VIVENTIUM START ===
 * Feature: Cortex insight delivery state projection tests.
 * === VIVENTIUM END === */

let mockGetAgent;
let mockGetMessage;
let mockGetMessages;
let mockGetInsightDeliveries;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    ...jest.requireActual('@librechat/data-schemas'),
    logger: { info: jest.fn(), warn: jest.fn() },
  }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('../CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) => mockGetInsightDeliveries(...args),
}));

const { getCortexMessageState } = require('../cortexMessageState');

describe('cortexMessageState insight delivery projection', () => {
  beforeEach(() => {
    mockGetAgent = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetInsightDeliveries = jest.fn().mockResolvedValue([
      {
        deliveryId: 'cidl_sent',
        cortexId: 'emotional-resonance',
        insightHash: 'a'.repeat(64),
        surface: 'telegram',
        status: 'sent',
        persistedMessageId: 'follow-up-1',
        dropReason: '',
      },
      {
        deliveryId: 'cidl_dropped',
        cortexId: 'review',
        insightHash: 'b'.repeat(64),
        surface: 'telegram',
        status: 'dropped',
        persistedMessageId: '',
        dropReason: 'semantic_suppression',
      },
    ]);
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'parent-1',
      conversationId: 'conversation-1',
      text: 'Main answer.',
      content: [
        {
          type: 'cortex_insight',
          cortex_id: 'emotional-resonance',
          status: 'complete',
          insight: 'A completed insight.',
        },
      ],
    });
  });

  test('returns owner-scoped terminal insight delivery outcomes and counts', async () => {
    const state = await getCortexMessageState({
      userId: 'owner-1',
      messageId: 'parent-1',
      conversationId: 'conversation-1',
    });

    expect(mockGetInsightDeliveries).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      parentMessageId: 'parent-1',
    });
    expect(state.insightDeliveries).toEqual([
      expect.objectContaining({ deliveryId: 'cidl_sent', status: 'sent' }),
      expect.objectContaining({
        deliveryId: 'cidl_dropped',
        status: 'dropped',
        dropReason: 'semantic_suppression',
      }),
    ]);
    expect(state.insightDeliverySummary).toEqual({
      total: 2,
      pending: 0,
      claimed: 0,
      sent: 1,
      dropped: 1,
    });
  });

  test('does not query another owner when the requested conversation does not match', async () => {
    const state = await getCortexMessageState({
      userId: 'owner-1',
      messageId: 'parent-1',
      conversationId: 'other-conversation',
    });

    expect(state).toBeNull();
    expect(mockGetInsightDeliveries).not.toHaveBeenCalled();
  });
});
