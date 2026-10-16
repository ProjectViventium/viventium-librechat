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

  test('projects persisted native ranges and exact callback controls without changing text', async () => {
    const text = 'Read-first 🧠.\nUseful spoken result.';
    const content = [{ type: 'text', text, deliveryDispositionRanges: [
      { start: 0, end: text.length, disposition: {
        version: 1, audio: 'eligible', required: true, valid: true, source: 'model',
      } },
    ] }];
    const controls = { audioContent: content, sourceTextSha256: 'a'.repeat(64) };
    mockGetMessages.mockResolvedValue([{ messageId: 'followup-native', text, content,
      metadata: { viventium: { telegramDeliveryControls: controls } } }]);
    const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
    expect(state.followUp).toEqual(expect.objectContaining({ text, content, deliveryControls: controls }));
  });

  test.each(['durable_terminal_callback', 'durable_work_callback'])(
    'leaves %s Main presentation to its native delivery owner, preserving ordinary Cortex follow-ups',
    async (followUpSource) => {
      const ordinary = {
        messageId: 'cortex-follow-up', text: 'A useful independent Cortex clarification.',
        metadata: { viventium: { followUpSource: 'cortex_aggregation' } },
      };
      const native = {
        messageId: 'worker-main-follow-up', text: 'The Main-authored worker result.',
        metadata: { viventium: { followUpSource } },
      };
      mockGetMessages.mockImplementation(async (filter) => [ordinary, native].filter(
        (message) => !filter['metadata.viventium.followUpSource']?.$nin?.includes(
          message.metadata.viventium.followUpSource,
        ),
      ));
      const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
      expect(state.followUp).toMatchObject({
        messageId: ordinary.messageId, text: ordinary.text, followUpSource: 'cortex_aggregation',
      });
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({
        user: 'owner-1', conversationId: 'conversation-1',
        'metadata.viventium.parentMessageId': 'parent-1',
        'metadata.viventium.followUpSource': { $nin: ['durable_terminal_callback', 'durable_work_callback'] },
      }));
    },
  );

  test.each(['durable_terminal_callback', 'durable_work_callback'])(
    'never offers %s as a fallback when no ordinary follow-up exists', async (followUpSource) => {
      mockGetMessages.mockImplementation(async (filter) =>
        filter['metadata.viventium.followUpSource']?.$nin?.includes(followUpSource)
          ? [] : [{ messageId: 'worker-main', text: 'Worker result.', metadata: { viventium: { followUpSource } } }],
      );
      const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'parent-1' });
      expect(state.followUp).toBeNull();
      expect(state.canonicalText).toBe('Main answer.');
      expect(state.canonicalTextSource).toBe('message');
    },
  );

  test('does not query another owner when the requested conversation does not match', async () => {
    const state = await getCortexMessageState({
      userId: 'owner-1',
      messageId: 'parent-1',
      conversationId: 'other-conversation',
    });

    expect(state).toBeNull();
    expect(mockGetInsightDeliveries).not.toHaveBeenCalled();
  });

  test.each(['telegram', 'voice', 'scheduler'])('keeps a completed model-authored quiet %s final silent in polling', async (surface) => {
    mockGetMessage.mockResolvedValue({ messageId: 'quiet-parent', conversationId: 'conversation-1',
      text: '', content: [], isCreatedByUser: false, unfinished: false, error: false,
      metadata: { viventium: { surface, deliveryDisposition: {
        version: 1, audio: 'skip', required: true, valid: true, source: 'model',
      } } } });
    const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(state.canonicalText).toBeNull();
    expect(state.canonicalTextFallbackReason).toBe('');
  });

  test('keeps quiet Main separate from active and completed Cortex follow-up delivery', async () => {
    const main = { messageId: 'quiet-parent', conversationId: 'conversation-1',
      text: '', isCreatedByUser: false, unfinished: false, error: false,
      content: [{ type: 'cortex_activation', status: 'running' }],
      metadata: { viventium: { deliveryDisposition: {
        version: 1, audio: 'skip', required: true, valid: true, source: 'model',
      } } } };
    mockGetMessage.mockResolvedValue(main);
    let state = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(state).toMatchObject({ canonicalText: null, followUp: null,
      canonicalTextFallbackReason: '' });
    main.content = [{ type: 'cortex_insight', status: 'complete', insight: 'Useful evidence.' }];
    state = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(state).toMatchObject({ canonicalText: null, followUp: null,
      canonicalTextFallbackReason: '' });
    const followUp = { messageId: 'ordinary-follow-up', text: 'A useful clarification.',
      metadata: { viventium: { followUpSource: 'cortex_aggregation' } } };
    mockGetMessages.mockResolvedValue([followUp]);
    state = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(state.canonicalText).toBeNull();
    expect(state.followUp).toMatchObject({ messageId: followUp.messageId, text: followUp.text });
    expect(state.canonicalTextFallbackReason).toBe('');
    mockGetMessages.mockResolvedValue([]);
    main.metadata.viventium.cortexFollowUpDecision = { result: 'skipped' };
    state = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(state).toMatchObject({ canonicalText: null, followUp: null,
      followUpDecision: { result: 'skipped' }, canonicalTextFallbackReason: '' });
  });

  test('requires committed completion and typed model skip before treating non-native polling as quiet', async () => {
    const main = { messageId: 'quiet-parent', conversationId: 'conversation-1',
      text: '', content: [], isCreatedByUser: false, unfinished: true, error: false,
      metadata: { viventium: { deliveryDisposition: {
        version: 1, audio: 'skip', required: true, valid: true, source: 'model',
      } } } };
    mockGetMessage.mockResolvedValue(main);
    const beforeCommit = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(beforeCommit.canonicalTextFallbackReason).toBe('empty_deferred_response');
    main.unfinished = false;
    const afterCommit = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(afterCommit.canonicalText).toBeNull();
    expect(afterCommit.canonicalTextFallbackReason).toBe('');
    expect(mockGetMessage).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining(
      'unfinished error aborted superseded isCreatedByUser',
    ));
    delete main.metadata.viventium.deliveryDisposition;
    const untyped = await getCortexMessageState({ userId: 'owner-1', messageId: 'quiet-parent' });
    expect(untyped.canonicalTextFallbackReason).toBe('empty_deferred_response');
  });

  test.each([
    { unfinished: true }, { error: true }, { aborted: true }, { superseded: true },
    { disposition: null }, { disposition: { valid: false } },
    { disposition: { audio: 'eligible' } }, { disposition: { source: 'legacy_marker' } },
  ])('keeps malformed, incomplete and failed empty results distinct from quiet completion: %j', async (change) => {
    const disposition = { version: 1, audio: 'skip', required: true, valid: true, source: 'model',
      ...(change.disposition || {}) };
    mockGetMessage.mockResolvedValue({ messageId: 'empty-parent', conversationId: 'conversation-1',
      text: '', content: [], isCreatedByUser: false, unfinished: false, error: false,
      ...Object.fromEntries(Object.entries(change).filter(([key]) => key !== 'disposition')),
      metadata: { viventium: { deliveryDisposition: change.disposition === null ? null : disposition } } });
    const state = await getCortexMessageState({ userId: 'owner-1', messageId: 'empty-parent' });
    expect(state.canonicalText).toBeTruthy();
    expect(state.canonicalTextFallbackReason).toBe('empty_deferred_response');
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
