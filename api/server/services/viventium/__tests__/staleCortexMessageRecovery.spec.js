jest.mock('~/db/models', () => ({
  Message: {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

const { ContentTypes } = require('librechat-data-provider');
const { Message } = require('~/db/models');
const {
  recoverCortexContent,
  recoverDeferredHoldParentErrorCards,
  recoverVisibleFollowUpErrorCards,
  recoverStaleCortexMessages,
  stripDeferredHoldParentErrorParts,
  stripErrorPartsFromRecoveredFollowUpContent,
} = require('../staleCortexMessageRecovery');

function mockFindLean(messages) {
  const lean = jest.fn().mockResolvedValue(messages);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  Message.find.mockReturnValue({ sort });
  return { sort, limit, lean };
}

function mockFindOneLean(message) {
  const lean = jest.fn().mockResolvedValue(message);
  Message.findOne.mockReturnValue({ lean });
  return { lean };
}

describe('staleCortexMessageRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS;
    delete process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_LIMIT;
    Message.updateOne.mockResolvedValue({ modifiedCount: 1 });
    mockFindOneLean(null);
  });

  test('marks active cortex parts as terminal errors', () => {
    const nowIso = '2026-05-06T12:00:00.000Z';
    const result = recoverCortexContent(
      [
        { type: ContentTypes.CORTEX_ACTIVATION, cortex_id: 'a', status: 'activating' },
        { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'b', status: 'complete', insight: 'done' },
      ],
      nowIso,
    );

    expect(result.changed).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        recovered_at: nowIso,
        recovery_reason: 'stale_cortex_startup_recovery',
      }),
    );
    expect(result.content[1].status).toBe('complete');
  });

  test('strips stale provider error cards from recovered visible follow-ups', () => {
    const result = stripErrorPartsFromRecoveredFollowUpContent([
      { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'a', status: 'complete' },
      {
        type: ContentTypes.ERROR,
        error: 'The model provider is temporarily overloaded. Please try again shortly.',
        error_class: 'provider_temporarily_unavailable',
      },
      { type: ContentTypes.TEXT, text: 'Recovered answer.' },
    ]);

    expect(result.changed).toBe(true);
    expect(result.errorClasses).toEqual(['provider_temporarily_unavailable']);
    expect(result.content).toEqual([
      expect.objectContaining({ type: ContentTypes.CORTEX_INSIGHT }),
      { type: ContentTypes.TEXT, text: 'Recovered answer.' },
    ]);
  });

  test('repairs persisted recovered follow-ups that still contain visible error cards', async () => {
    mockFindLean([
      {
        _id: 'mongo-id-recovered',
        messageId: 'msg-recovered',
        updatedAt: new Date('2026-05-21T06:44:46.000Z'),
        text: 'Recovered answer.',
        metadata: {
          viventium: {
            type: 'cortex_followup',
            promotedToEmptyParent: true,
          },
        },
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'a', status: 'complete' },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider is temporarily overloaded. Please try again shortly.',
            error_class: 'provider_temporarily_unavailable',
          },
          { type: ContentTypes.TEXT, text: 'Recovered answer.' },
        ],
      },
    ]);

    const result = await recoverVisibleFollowUpErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 1 });
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-recovered', updatedAt: new Date('2026-05-21T06:44:46.000Z') },
      {
        $set: expect.objectContaining({
          error: false,
          unfinished: false,
          content: [
            expect.objectContaining({ type: ContentTypes.CORTEX_INSIGHT }),
            { type: ContentTypes.TEXT, text: 'Recovered answer.' },
          ],
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              recoveredPrimaryErrorClasses: ['provider_temporarily_unavailable'],
            }),
          }),
        }),
      },
    );
  });

  test('strips stale completion errors from deferred hold parents only when structurally safe', () => {
    const holdPart = {
      type: ContentTypes.TEXT,
      text: 'Checking now.',
      viventium_runtime_hold: true,
    };
    const cortexPart = {
      type: ContentTypes.CORTEX_INSIGHT,
      cortex_id: 'agent-prod',
      status: 'complete',
    };

    const result = stripDeferredHoldParentErrorParts([
      cortexPart,
      holdPart,
      {
        type: ContentTypes.ERROR,
        error: 'The model provider could not complete this request.',
        error_class: 'completion_error',
      },
      {
        type: ContentTypes.ERROR,
        error: 'The model provider credentials were rejected.',
        error_class: 'provider_unauthorized',
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.errorClasses).toEqual(['completion_error']);
    expect(result.content).toEqual([
      cortexPart,
      holdPart,
      {
        type: ContentTypes.ERROR,
        error: 'The model provider credentials were rejected.',
        error_class: 'provider_unauthorized',
      },
    ]);
    expect(
      stripDeferredHoldParentErrorParts([
        holdPart,
        {
          type: ContentTypes.ERROR,
          error: 'The model provider could not complete this request.',
          error_class: 'completion_error',
        },
      ]).changed,
    ).toBe(false);
  });

  test('repairs deferred hold parent error cards after a successful cortex follow-up exists', async () => {
    const updatedAt = new Date('2026-05-21T16:27:58.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-parent',
        messageId: 'msg-parent',
        updatedAt,
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
          {
            type: ContentTypes.TEXT,
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider could not complete this request.',
            error_class: 'completion_error',
          },
        ],
      },
    ]);
    mockFindOneLean({ _id: 'mongo-id-followup' });

    const result = await recoverDeferredHoldParentErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 1 });
    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        isCreatedByUser: false,
        text: { $type: 'string', $ne: '' },
        error: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.parentMessageId': 'msg-parent',
      }),
      { _id: 1 },
    );
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-parent', updatedAt },
      {
        $set: expect.objectContaining({
          content: [
            { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
            {
              type: ContentTypes.TEXT,
              text: 'Checking now.',
              viventium_runtime_hold: true,
            },
          ],
          error: false,
          unfinished: false,
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              recoveredDeferredHoldErrorClasses: ['completion_error'],
            }),
          }),
        }),
      },
    );
  });

  test('does not repair deferred hold parent errors without a successful follow-up', async () => {
    mockFindLean([
      {
        _id: 'mongo-id-parent',
        messageId: 'msg-parent',
        updatedAt: new Date('2026-05-21T16:27:58.000Z'),
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
          {
            type: ContentTypes.TEXT,
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider could not complete this request.',
            error_class: 'completion_error',
          },
        ],
      },
    ]);
    mockFindOneLean(null);

    const result = await recoverDeferredHoldParentErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 0 });
    expect(Message.updateOne).not.toHaveBeenCalled();
  });

  test('repairs stale unfinished hold messages on startup', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '500';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-1',
        messageId: 'msg-1',
        createdAt: new Date('2026-05-06T11:59:00.000Z'),
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: true,
        text: 'Checking now.',
        content: [
          {
            type: 'text',
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          { type: ContentTypes.CORTEX_ACTIVATION, cortex_id: 'a', status: 'activating' },
        ],
      },
    ]);

    const result = await recoverStaleCortexMessages({ now });

    expect(result).toEqual(expect.objectContaining({ scanned: 1, repaired: 1, timeoutMs: 1000 }));
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-1', updatedAt: new Date('2026-05-06T11:59:01.000Z') },
      {
        $set: expect.objectContaining({
          unfinished: false,
          text: 'That background check was interrupted by a runtime restart before it finished.',
          content: expect.arrayContaining([
            expect.objectContaining({ status: 'error', cortex_id: 'a' }),
          ]),
        }),
      },
    );
  });

  test('repairs finished blank messages that still contain active cortex rows', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '500';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-blank',
        messageId: 'msg-blank',
        createdAt: new Date('2026-05-06T11:59:00.000Z'),
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: false,
        error: false,
        text: '',
        content: [
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'a', status: 'brewing' },
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'b', status: 'brewing' },
        ],
      },
    ]);

    const result = await recoverStaleCortexMessages({ now });

    expect(result).toEqual(expect.objectContaining({ scanned: 1, repaired: 1, timeoutMs: 1000 }));
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-blank', updatedAt: new Date('2026-05-06T11:59:01.000Z') },
      {
        $set: expect.objectContaining({
          unfinished: false,
          content: [
            expect.objectContaining({ status: 'error', cortex_id: 'a' }),
            expect.objectContaining({ status: 'error', cortex_id: 'b' }),
          ],
        }),
      },
    );
  });

  test('keeps stale cutoff beyond the configured cortex execution timeout', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '5000';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    mockFindLean([]);

    const result = await recoverStaleCortexMessages({
      now: new Date('2026-05-06T12:00:00.000Z'),
    });

    expect(result).toEqual(
      expect.objectContaining({
        timeoutMs: 5250,
        cortexExecutionTimeoutMs: 5000,
        graceMs: 250,
      }),
    );
  });

  test('keeps scheduled stale hold text suppressed', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-2',
        messageId: 'msg-2',
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: true,
        metadata: { viventium: { scheduleId: 'sched-1' } },
        content: [
          {
            type: 'text',
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'a', status: 'brewing' },
        ],
      },
    ]);

    await recoverStaleCortexMessages({ now });

    expect(Message.updateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: expect.not.objectContaining({
        text: expect.any(String),
      }),
    });
  });
});
