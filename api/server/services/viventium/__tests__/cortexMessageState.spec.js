/* === VIVENTIUM START ===
 * Feature: Cortex insight delivery state projection tests.
 * === VIVENTIUM END === */

let mockGetAgent;
let mockGetMessage;
let mockGetMessages;
let mockGetInsightDeliveries;
const mockGetMemoryWriteStatus = jest.fn().mockResolvedValue(null);

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
  getMessages: async (...args) => {
    if (args[0]?.messageId) {
      const message = await mockGetMessage(...args);
      return message ? [message] : [];
    }
    return mockGetMessages(...args);
  },
  getMemoryWriteStatus: (...args) => mockGetMemoryWriteStatus(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('../CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) => mockGetInsightDeliveries(...args),
}));

const { getCortexMessageState, memoryReceiptFromAttachments } = require('../cortexMessageState');

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

describe('cortexMessageState durable saved-memory receipt projection', () => {
  beforeEach(() => {
    mockGetAgent = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetInsightDeliveries = jest.fn().mockResolvedValue([]);
    mockGetMemoryWriteStatus.mockReset().mockResolvedValue(null);
  });

  test.each([
    ['pending', 'pending'],
    ['running', 'pending'],
    ['completed', 'unchanged'],
    ['failed', 'failed'],
  ])(
    'projects %s admission as %s without leaking source or claiming a save',
    async (internalStatus, publicStatus) => {
      mockGetMessage = jest.fn().mockResolvedValue({
        messageId: 'parent-1',
        conversationId: 'conversation-1',
        content: [],
        savedMemoryWrite: { status: internalStatus },
      });
      mockGetMemoryWriteStatus.mockResolvedValueOnce(internalStatus);
      const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
      expect(state.memoryReceipt).toMatchObject({ status: publicStatus, keys: [] });
      expect(state.savedMemoryWrite).toBeUndefined();
    },
  );

  test.each([
    [
      'completed',
      { type: 'update', key: 'preferences', value: 'synthetic saved value' },
      { status: 'saved', keys: ['preferences'] },
    ],
    [
      'failed',
      {
        type: 'error',
        key: 'system',
        value: JSON.stringify({ errorType: 'writer_interrupted', partialApplied: true }),
      },
      {
        status: 'uncertain',
        keys: [],
        errorType: 'writer_interrupted',
        failures: [{ errorType: 'writer_interrupted', partialApplied: true }],
      },
    ],
  ])(
    'keeps one receipt snapshot when %s commits during polling',
    async (terminalStatus, memory, expectedReceipt) => {
      let persisted = {
        messageId: 'parent-1',
        conversationId: 'conversation-1',
        content: [],
        attachments: [],
        savedMemoryWrite: { status: 'running' },
      };
      mockGetMessage = jest.fn(async () => JSON.parse(JSON.stringify(persisted)));
      mockGetMessages.mockImplementation(async () => {
        persisted = {
          ...persisted,
          savedMemoryWrite: { status: terminalStatus },
          attachments: [{ type: 'memory', memory }],
        };
        return [];
      });
      mockGetMemoryWriteStatus.mockImplementation(async () => persisted.savedMemoryWrite.status);

      const firstPoll = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
      expect(firstPoll.memoryReceipt).toEqual({ status: 'pending', keys: [] });
      const nextPoll = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
      expect(nextPoll.memoryReceipt).toEqual(expectedReceipt);
      expect(JSON.stringify(nextPoll)).not.toContain('synthetic saved value');
    },
  );
  test('projects saved keys, typed failures, and partial applies without private values', () => {
    expect(memoryReceiptFromAttachments(undefined)).toBeNull();
    expect(memoryReceiptFromAttachments([{ type: 'file', file_id: 'f1' }])).toBeNull();
    expect(
      memoryReceiptFromAttachments([
        { type: 'memory', memory: { key: 'preferences', type: 'update', value: 'private text' } },
        { type: 'memory', memory: { key: 'core', type: 'update', value: 'private text' } },
      ]),
    ).toEqual({ status: 'saved', keys: ['preferences', 'core'] });
    const failed = memoryReceiptFromAttachments([
      {
        type: 'memory',
        memory: {
          key: 'system',
          type: 'error',
          value: JSON.stringify({ errorType: 'usage_limit_reached', message: 'Provider quota.' }),
        },
      },
    ]);
    expect(failed).toEqual({
      status: 'failed',
      keys: [],
      errorType: 'usage_limit_reached',
      failures: [{ errorType: 'usage_limit_reached', partialApplied: false }],
    });
    expect(JSON.stringify(failed)).not.toContain('Provider quota.');
    const partial = memoryReceiptFromAttachments([
      { type: 'memory', memory: { key: 'core', type: 'update', value: 'private text' } },
      {
        type: 'memory',
        memory: {
          key: 'system',
          type: 'error',
          value: JSON.stringify({ errorType: 'provider_unavailable', partialApplied: true }),
        },
      },
    ]);
    expect(partial.status).toBe('partial');
    expect(JSON.stringify(partial)).not.toContain('private text');
  });

  test('exposes the receipt on the polled message state', async () => {
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'parent-1',
      conversationId: 'conversation-1',
      text: 'Got it.',
      content: [{ type: 'text', text: 'Got it.' }],
      attachments: [{ type: 'memory', memory: { key: 'moments', type: 'update', value: 'x' } }],
    });
    const state = await getCortexMessageState({
      userId: 'owner-1',
      messageId: 'parent-1',
      conversationId: 'conversation-1',
    });
    expect(state.memoryReceipt).toEqual({ status: 'saved', keys: ['moments'] });
  });
});
