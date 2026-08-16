/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Durable GlassHive callback delivery ledger tests.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */

let mockFindOneAndUpdate;
let mockFindOne;
let mockFindDeliveries;
let mockCountDocuments;
let mockRecordGlassHiveSurfaceDeliveryOutcome;
let mockResolveTelegramMappingByUserId;

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
    find: (...args) => mockFindDeliveries(...args),
    countDocuments: (...args) => mockCountDocuments(...args),
  },
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  recordGlassHiveSurfaceDeliveryOutcome: (...args) =>
    mockRecordGlassHiveSurfaceDeliveryOutcome(...args),
}));

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

const {
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
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
    mockFindDeliveries = jest.fn().mockReturnValue(leanResult([]));
    mockCountDocuments = jest.fn();
    mockRecordGlassHiveSurfaceDeliveryOutcome = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue(null);
  });

  test('successful terminal evidence waits for Main adjudication instead of direct surface delivery', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({
        ...update.$setOnInsert,
        ...update.$set,
      }),
    );

    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_private_raw',
        event: 'run.completed',
        user_id: 'user_1',
        conversation_id: 'conv_1',
        parent_message_id: 'msg_user',
        message_id: 'msg_anchor',
        surface: 'telegram',
        telegram_chat_id: 'callback-supplied-chat-must-be-ignored',
        full_message: `Created ${syntheticLocalPath('private', 'report.md')}`,
      },
      deliveryContext: {
        bindingId: 'ghcb_binding_1',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        requestedParentMessageId: 'msg_user',
        destinations: [
          {
            surface: 'telegram',
            telegramChatId: 'chat_1',
            telegramUserId: 'telegram_user_1',
          },
          { surface: 'librechat' },
        ],
      },
      message: {
        messageId: 'msg_callback',
        text: 'Created [local path]',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Created [local path]',
      fullText: '',
    });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(summary).toEqual({
      configured: 1,
      enqueued: 0,
      unresolved: 0,
      deliveries: [],
      deferredToMain: true,
    });
  });

  test('immediate neutral attention status never falls back to raw callback full_message text', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_failed',
        event: 'run.failed',
        full_message: `Created ${syntheticLocalPath('private', 'report.md')}`,
      },
      deliveryContext: {
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat_1', telegramUserId: 'telegram_user_1' },
        ],
      },
      message: {
        messageId: 'msg_callback',
        text: 'Mission needs attention.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Mission needs attention.',
      fullText: '',
    });

    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.fullText).toBe('');
    expect(update.$setOnInsert.telegramChatId).toBe('chat_1');
    expect(JSON.stringify(update)).not.toContain(syntheticLocalPath());
  });

  test('semantic silence persists one suppressed row for a resolved terminal Telegram destination', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'main:origin:silent:evidence-1',
        event: 'main.followup',
        origin_ref: 'origin-1',
        work_ref: 'work-1',
      },
      message: {
        messageId: 'silent:evidence-1',
        text: '',
        metadata: { viventium: { callbackKey: 'silent:evidence-1' } },
      },
      text: '',
      fullText: '',
      suppress: true,
      deliveryContext: {
        ownerId: 'user-1',
        originRef: 'origin-1',
        workRef: 'work-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-1', telegramUserId: 'telegram-user-1' },
        ],
      },
    });

    expect(summary).toMatchObject({ configured: 1, enqueued: 1, unresolved: 0 });
    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert).toMatchObject({
      status: 'suppressed',
      nextAttemptAt: null,
      telegramChatId: 'chat-1',
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'origin-1',
      state: 'suppressed',
    });
  });

  test('does not enqueue external delivery without a resolved Core binding', async () => {
    const result = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_unbound',
        event: 'run.completed',
        user_id: 'user_1',
        conversation_id: 'conv_1',
        surface: 'telegram',
        telegram_chat_id: 'untrusted-chat',
      },
      message: {
        messageId: 'msg_callback',
        text: 'Mission completed.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Mission completed.',
    });

    expect(result).toEqual({ configured: 0, enqueued: 0, unresolved: 0, deliveries: [] });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('alerts and persists unresolved truth when a configured terminal destination cannot resolve', async () => {
    const { logger } = require('@librechat/data-schemas');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'cb_unresolved', event: 'main.followup' },
      deliveryContext: {
        originRef: 'ghi_origin_unresolved',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', unresolvedReason: 'telegram_account_not_linked' },
          { surface: 'librechat' },
        ],
      },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    });

    expect(result).toEqual({
      configured: 1,
      enqueued: 0,
      unresolved: 1,
      deliveries: [expect.objectContaining({ status: 'unresolved' })],
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_unresolved',
      state: 'unresolved',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved',
      expect.objectContaining({
        originRef: 'ghi_origin_unresolved',
        event: 'main.followup',
        configured: 1,
        unresolved: 1,
      }),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const unresolvedUpdate = mockFindOneAndUpdate.mock.calls[0][1];
    expect(unresolvedUpdate.$setOnInsert).toEqual(
      expect.objectContaining({
        surface: 'telegram',
        status: 'unresolved',
        unresolvedReason: 'telegram_account_not_linked',
      }),
    );
  });

  test('persists mixed resolved and unresolved destinations as partial durable truth', async () => {
    const { logger } = require('@librechat/data-schemas');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'cb_partial', event: 'main.followup' },
      deliveryContext: {
        originRef: 'ghi_origin_partial',
        workRef: 'ghw_work_partial',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat_1', telegramUserId: 'telegram_user_1' },
          { surface: 'voice', unresolvedReason: 'voice_session_not_bound' },
        ],
      },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    });

    expect(result).toEqual({
      configured: 2,
      enqueued: 1,
      unresolved: 1,
      deliveries: [
        expect.objectContaining({ surface: 'telegram', status: 'pending' }),
        expect.objectContaining({ surface: 'voice', status: 'unresolved' }),
      ],
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_partial',
      state: 'unresolved',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved',
      expect.objectContaining({ configured: 2, enqueued: 1, unresolved: 1 }),
    );
  });

  test('same callback id on the same surface is isolated by trusted owner and origin', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const common = {
      body: { callback_id: 'cb_shared_vendor_id', event: 'main.followup' },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'same_callback_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    };

    await enqueueGlassHiveCallbackDelivery({
      ...common,
      deliveryContext: {
        originRef: 'ghi_owner_a_origin',
        ownerId: 'owner_a',
        conversationId: 'conv_a',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat_a' }],
      },
    });
    await enqueueGlassHiveCallbackDelivery({
      ...common,
      deliveryContext: {
        originRef: 'ghi_owner_b_origin',
        ownerId: 'owner_b',
        conversationId: 'conv_b',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat_b' }],
      },
    });

    const firstFilter = mockFindOneAndUpdate.mock.calls[0][0];
    const secondFilter = mockFindOneAndUpdate.mock.calls[1][0];
    const firstKey = firstFilter.$or[0].deliveryKey;
    const secondKey = secondFilter.$or[0].deliveryKey;
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain('owner_a:ghi_owner_a_origin:telegram:cb_shared_vendor_id');
    expect(secondKey).toContain('owner_b:ghi_owner_b_origin:telegram:cb_shared_vendor_id');
    expect(firstFilter.$or[1]).toEqual({
      deliveryKey: 'telegram:cb_shared_vendor_id',
      userId: 'owner_a',
      originRef: 'ghi_owner_a_origin',
    });
    expect(secondFilter.$or[1]).toEqual({
      deliveryKey: 'telegram:cb_shared_vendor_id',
      userId: 'owner_b',
      originRef: 'ghi_owner_b_origin',
    });
  });

  test('one sent target cannot clear a sibling unresolved target from Core projection', async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_partial_sent',
        callbackMessageId: 'msg_callback',
        originRef: 'ghi_origin_partial',
        conversationId: 'conv_1',
        event: 'main.followup',
        surface: 'telegram',
        status: 'sent',
        claimId: 'claim_partial',
      }),
    );
    mockFindDeliveries.mockReturnValueOnce(
      leanResult([{ status: 'sent' }, { status: 'unresolved' }]),
    );

    await markGlassHiveCallbackDeliverySent({
      deliveryId: 'ghcd_partial_sent',
      claimId: 'claim_partial',
    });

    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_partial',
      state: 'unresolved',
    });
  });

  test('repairs an unresolved Telegram target after account linking without a GH replay', async () => {
    const unresolvedQuery = {
      sort: jest.fn(() => unresolvedQuery),
      limit: jest.fn(() => unresolvedQuery),
      lean: jest.fn().mockResolvedValue([
        {
          deliveryId: 'ghcd_unresolved_link',
          userId: 'owner_linked',
          originRef: 'ghi_origin_linked',
          surface: 'telegram',
          status: 'unresolved',
        },
      ]),
    };
    mockFindDeliveries
      .mockReturnValueOnce(unresolvedQuery)
      .mockReturnValueOnce(leanResult([{ status: 'pending' }]));
    mockResolveTelegramMappingByUserId.mockResolvedValueOnce({
      telegramUserId: 'tg_linked',
      telegramChatId: 'chat_linked',
    });
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_unresolved_link',
        userId: 'owner_linked',
        originRef: 'ghi_origin_linked',
        surface: 'telegram',
        status: 'pending',
        telegramUserId: 'tg_linked',
        telegramChatId: 'chat_linked',
      }),
    );

    await expect(
      reconcileUnresolvedGlassHiveCallbackDeliveries({ userId: 'owner_linked' }),
    ).resolves.toEqual({ scanned: 1, repaired: 1, pending: 0 });
    expect(mockResolveTelegramMappingByUserId).toHaveBeenCalledWith({
      libreChatUserId: 'owner_linked',
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        deliveryId: 'ghcd_unresolved_link',
        userId: 'owner_linked',
        surface: 'telegram',
        status: 'unresolved',
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          telegramUserId: 'tg_linked',
          telegramChatId: 'chat_linked',
          unresolvedReason: '',
        }),
      }),
      { new: true },
    );
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_linked',
      state: 'enqueued',
    });
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
