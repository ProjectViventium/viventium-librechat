/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Durable GlassHive callback delivery ledger tests.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */

let mockFindOneAndUpdate;
let mockFindOne;
let mockCountDocuments;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/db/models', () => ({
  ViventiumGlassHiveCallbackDelivery: {
    findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    findOne: (...args) => mockFindOne(...args),
    countDocuments: (...args) => mockCountDocuments(...args),
  },
}));

const {
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
} = require('../GlassHiveCallbackDeliveryService');

function leanResult(value) {
  return {
    lean: async () => value,
  };
}

function syntheticLocalPath(...parts) {
  return ['', 'Users', 'synthetic-user', ...parts].join('/');
}

describe('GlassHiveCallbackDeliveryService', () => {
  beforeEach(() => {
    mockFindOneAndUpdate = jest.fn();
    mockFindOne = jest.fn();
    mockCountDocuments = jest.fn();
  });

  test('enqueue never falls back to raw callback full_message text', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({
        ...update.$setOnInsert,
        ...update.$set,
      }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_private_raw',
        event: 'run.completed',
        user_id: 'user_1',
        conversation_id: 'conv_1',
        parent_message_id: 'msg_user',
        message_id: 'msg_anchor',
        surface: 'telegram',
        telegram_chat_id: 'chat_1',
        full_message: `Created ${syntheticLocalPath('private', 'report.md')}`,
      },
      message: {
        messageId: 'msg_callback',
        text: 'Created [local path]',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Created [local path]',
      fullText: '',
    });

    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert).not.toHaveProperty('fullText');
    expect(update.$setOnInsert).not.toHaveProperty('text');
    expect(update.$setOnInsert).not.toHaveProperty('expiresAt');
    expect(update.$set.fullText).toBe('');
    expect(JSON.stringify(update)).not.toContain(syntheticLocalPath());
  });

  test('claim uses the surface ledger without user-prompt matching', async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_claim',
          callbackId: 'cb_claim',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'telegram',
          status: 'claimed',
          text: 'Worker finished.',
          telegramChatId: 'chat_1',
          claimId: 'claim_1',
          retryCount: 0,
        }),
      )
      .mockReturnValueOnce(leanResult(null));

    const claimed = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'telegram',
      limit: 5,
      claimOwner: 'telegram-dispatcher',
    });

    expect(claimed).toEqual([
      expect.objectContaining({
        deliveryId: 'ghcd_claim',
        callbackId: 'cb_claim',
        telegramChatId: 'chat_1',
        claimId: 'claim_1',
      }),
    ]);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter.surface).toBe('telegram');
    expect(filter).not.toHaveProperty('text');
    expect(update.$set.status).toBe('claimed');
    expect(update.$set.claimOwner).toBe('telegram-dispatcher');
    expect(update.$set.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });

  test('delivery status failures redact tokens before persistence', async () => {
    mockFindOne.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_secret',
        claimId: 'claim_secret',
        retryCount: 0,
      }),
    );
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_secret',
          claimId: 'claim_secret',
          status: 'failed',
          lastError: 'redacted',
        }),
      )
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_secret',
          claimId: 'claim_secret',
          status: 'suppressed',
          lastError: 'redacted',
        }),
      );

    const secretUrl =
      'https://api.telegram.org/bot1234567890:ABCdef_1234567890SECRET_TOKEN/sendMessage?access_token=raw-token';
    await markGlassHiveCallbackDeliveryFailed({
      deliveryId: 'ghcd_secret',
      claimId: 'claim_secret',
      error: `failed calling ${secretUrl}`,
    });
    await markGlassHiveCallbackDeliverySuppressed({
      deliveryId: 'ghcd_secret',
      claimId: 'claim_secret',
      reason: `suppressed after ${secretUrl}`,
    });

    const failedUpdate = mockFindOneAndUpdate.mock.calls[0][1];
    const suppressedUpdate = mockFindOneAndUpdate.mock.calls[1][1];
    expect(failedUpdate.$set.lastError).toContain('/bot<redacted>');
    expect(failedUpdate.$set.lastError).toContain('access_token=<redacted>');
    expect(suppressedUpdate.$set.lastError).toContain('/bot<redacted>');
    expect(JSON.stringify(failedUpdate)).not.toContain('ABCdef_1234567890SECRET_TOKEN');
    expect(JSON.stringify(suppressedUpdate)).not.toContain('ABCdef_1234567890SECRET_TOKEN');
    expect(JSON.stringify(failedUpdate)).not.toContain('raw-token');
    expect(JSON.stringify(suppressedUpdate)).not.toContain('raw-token');
  });

  test('voice delivery claim and mark can be scoped to user and call session', async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_voice',
          callbackId: 'cb_voice',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'voice',
          status: 'claimed',
          text: 'Worker finished.',
          voiceCallSessionId: 'call_1',
          claimId: 'claim_voice',
          retryCount: 0,
        }),
      )
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_voice',
          callbackId: 'cb_voice',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'voice',
          status: 'sent',
          text: 'Worker finished.',
          voiceCallSessionId: 'call_1',
          claimId: 'claim_voice',
          retryCount: 0,
        }),
      );

    await claimPendingGlassHiveCallbackDeliveries({
      surface: 'voice',
      callbackId: 'cb_voice',
      userId: 'user_1',
      voiceCallSessionId: 'call_1',
    });
    await markGlassHiveCallbackDeliverySent({
      deliveryId: 'ghcd_voice',
      claimId: 'claim_voice',
      userId: 'user_1',
      voiceCallSessionId: 'call_1',
    });

    const claimFilter = mockFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.userId).toBe('user_1');
    expect(claimFilter.voiceCallSessionId).toBe('call_1');
    const markFilter = mockFindOneAndUpdate.mock.calls[1][0];
    expect(markFilter.userId).toBe('user_1');
    expect(markFilter.voiceCallSessionId).toBe('call_1');
  });
});
