const mockFlushVoiceTaskPersistence = jest.fn(() => Promise.resolve());
const mockMarkVoiceTaskAwaitingOwnerResult = jest.fn(() => ({ sequence: 4 }));

jest.mock('../VoiceTaskService', () => ({
  flushVoiceTaskPersistence: mockFlushVoiceTaskPersistence,
  markVoiceTaskAwaitingOwnerResult: mockMarkVoiceTaskAwaitingOwnerResult,
}));

const {
  glassHiveCallbackDispatchAccepted,
  markCallbackBackedVoiceContinuation,
} = require('../GlassHiveDispatchContinuationService');

describe('GlassHive callback-backed voice continuation', () => {
  test('accepts only structured callback-backed dispatch results', () => {
    expect(
      glassHiveCallbackDispatchAccepted({
        status: 'dispatched',
        callback_ready: true,
        callback_delivery_deadline_seconds: 870,
        run_state: 'queued',
      }),
    ).toBe(true);
    expect(
      glassHiveCallbackDispatchAccepted([
        { type: 'text', text: 'Background worker dispatched successfully' },
        {
          artifact: {
            status: 'queued',
            callback_ready: true,
            callback_delivery_deadline_seconds: 60,
          },
        },
      ]),
    ).toBe(true);
  });

  test.each([
    ['human-facing text', 'Background worker dispatched successfully'],
    ['blocked dispatch', { status: 'blocked', callback_ready: true }],
    ['unbacked dispatch', { status: 'dispatched', callback_ready: false }],
    ['callback dispatch without an owner deadline', { status: 'dispatched', callback_ready: true }],
    [
      'callback dispatch with an unsafe owner deadline',
      { status: 'dispatched', callback_ready: true, callback_delivery_deadline_seconds: 0 },
    ],
    ['unrelated queued object', { status: 'queued' }],
  ])('rejects %s', (_label, value) => {
    expect(glassHiveCallbackDispatchAccepted(value)).toBe(false);
  });

  test('durably fences a voice task only after a structured callback-backed dispatch', async () => {
    await expect(
      markCallbackBackedVoiceContinuation({
        result: {
          status: 'dispatched',
          callback_ready: true,
          callback_delivery_deadline_seconds: 870,
        },
        requestBody: { voiceMode: true, viventiumVoiceTaskId: 'voice-task-1' },
        continuationKey: 'tool-call-1',
      }),
    ).resolves.toEqual({ sequence: 4 });

    expect(mockMarkVoiceTaskAwaitingOwnerResult).toHaveBeenCalledWith(
      'voice-task-1',
      'glasshive_dispatch:tool-call-1',
      { deadlineAtMs: expect.any(Number) },
    );
    expect(
      mockMarkVoiceTaskAwaitingOwnerResult.mock.calls[0][2].deadlineAtMs - Date.now(),
    ).toBeGreaterThanOrEqual(869_000);
    expect(mockFlushVoiceTaskPersistence).toHaveBeenCalledTimes(1);
  });

  test('never creates a continuation fence from text or outside a voice turn', async () => {
    mockMarkVoiceTaskAwaitingOwnerResult.mockClear();
    mockFlushVoiceTaskPersistence.mockClear();

    await expect(
      markCallbackBackedVoiceContinuation({
        result: { text: 'Background worker dispatched successfully' },
        requestBody: { voiceMode: true, viventiumVoiceTaskId: 'voice-task-1' },
        continuationKey: 'tool-call-2',
      }),
    ).resolves.toBeNull();
    await expect(
      markCallbackBackedVoiceContinuation({
        result: { status: 'queued', callback_ready: true },
        requestBody: { voiceMode: false, viventiumVoiceTaskId: 'voice-task-1' },
        continuationKey: 'tool-call-3',
      }),
    ).resolves.toBeNull();

    expect(mockMarkVoiceTaskAwaitingOwnerResult).not.toHaveBeenCalled();
    expect(mockFlushVoiceTaskPersistence).not.toHaveBeenCalled();
  });
});
