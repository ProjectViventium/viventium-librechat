jest.mock('~/db/models', () => ({
  Message: {
    find: jest.fn(),
    updateOne: jest.fn(),
  },
}));

const { ContentTypes } = require('librechat-data-provider');
const { Message } = require('~/db/models');
const {
  recoverCortexContent,
  recoverStaleCortexMessages,
} = require('../staleCortexMessageRecovery');

function mockFindLean(messages) {
  const lean = jest.fn().mockResolvedValue(messages);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  Message.find.mockReturnValue({ sort });
  return { sort, limit, lean };
}

describe('staleCortexMessageRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS;
    delete process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_LIMIT;
    Message.updateOne.mockResolvedValue({ modifiedCount: 1 });
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
