/* VIVENTIUM START: persisted input ownership and the existing transaction/source guards. */
let mockDependencies;
const mockMessage = {
  collection: { name: 'messages' },
  exists: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
};
const mockIngress = {
  aggregate: jest.fn(),
  exists: jest.fn(),
  updateOne: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
};
const mockGetFiles = jest.fn();
const mockResolveMapping = jest.fn();
const mockTransaction = jest.fn((operation) => operation());
const mockSourceMutation = jest.fn((_filter, operation) => operation());
const mockGetJob = jest.fn();
const mockConversationGeneration = jest.fn(() => 'bound-generation');
jest.mock('@librechat/api', () => ({
  createTelegramInputService: (dependencies) => {
    mockDependencies = dependencies;
    return {};
  },
  telegramIngressDedupeTtlSeconds: () => 86400,
  telegramInputConversationGeneration: (...args) => mockConversationGeneration(...args),
  GenerationJobManager: { getJob: (...args) => mockGetJob(...args) },
}));
jest.mock('~/db/models', () => ({
  Message: mockMessage,
  ViventiumTelegramIngressEvent: mockIngress,
}));
jest.mock('~/models', () => ({ getFiles: (...args) => mockGetFiles(...args) }));
jest.mock('../TelegramLinkService', () => ({
  resolveTelegramMapping: (...args) => mockResolveMapping(...args),
}));
jest.mock('./GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (...args) => mockTransaction(...args),
}));
jest.mock('./nativeResponseService', () => ({
  mutateNativeResponseSources: (...args) => mockSourceMutation(...args),
}));
const inputService = require('./TelegramInputService');
const row = {
  libreChatUserId: 'owner',
  telegramUserId: 'sender',
  conversationId: 'conversation',
  sourceMessageId: 'original-message',
  sourceEventId: 'a'.repeat(64),
  sourceOrderScope: 'b'.repeat(64),
  sourceSequence: 12,
};
const prepared = {
  text: 'Original voice request',
  fileIds: ['file-1'],
  imageUrls: [],
};
test('coverage recovery binds the exact original owner, conversation, generation, event, message and sequence', async () => {
  mockMessage.exists.mockResolvedValueOnce(true);
  expect(await mockDependencies.hasCommittedDelivery(row)).toBe(true);
  expect(mockMessage.exists).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: 'conversation',
    isCreatedByUser: false,
    unfinished: { $ne: true },
    'metadata.viventium.deliveryAcknowledgement.state': 'committed',
    'metadata.viventium.deliverySourceCoverage.source_order_scope': row.sourceOrderScope,
    'metadata.viventium.deliverySourceCoverage.source_conversation_generation': {
      $in: ['bound-generation'],
    },
    'metadata.viventium.deliverySourceCoverage.sources': {
      $elemMatch: {
        source_event_id: row.sourceEventId,
        source_message_id: row.sourceMessageId,
        source_sequence: 12,
        owned: { $ne: false },
      },
    },
    $expr: {
      $and: [
        {
          $eq: [
            '$metadata.viventium.deliverySourceCoverage.logical_turn_id',
            '$metadata.viventium.deliveryAcknowledgement.logical_turn_id',
          ],
        },
        {
          $eq: [
            '$metadata.viventium.deliverySourceCoverage.revision',
            '$metadata.viventium.deliveryAcknowledgement.revision',
          ],
        },
      ],
    },
  });
  mockMessage.exists.mockResolvedValueOnce(false);
  expect(await mockDependencies.hasCommittedDelivery(row)).toBe(false);
});
/* VIVENTIUM: only an input bound to its own started stream accepts another answer's coverage. */
test('coverage by an answer that did not author the input settles only an admitted input', async () => {
  mockMessage.exists.mockResolvedValue(true);
  mockIngress.findOne.mockReturnValue({ lean: async () => null });
  await mockDependencies.hasCommittedDelivery({ ...row, state: 'ready' });
  await mockDependencies.hasCommittedDelivery({ ...row, state: 'admitted' });
  const [ready, admitted] = mockMessage.exists.mock.calls.map(
    ([filter]) => filter['metadata.viventium.deliverySourceCoverage.sources'].$elemMatch,
  );
  expect(ready).toMatchObject({ owned: { $ne: false } });
  expect(admitted).not.toHaveProperty('owned');
});
beforeEach(() => {
  jest.clearAllMocks();
  mockConversationGeneration.mockImplementation(() => 'bound-generation');
  mockResolveMapping.mockResolvedValue({ libreChatUserId: 'owner' });
  mockMessage.exists.mockResolvedValue(true);
  mockMessage.updateOne.mockResolvedValue({ matchedCount: 1 });
  mockGetFiles.mockResolvedValue([{ file_id: 'file-1', user: 'owner' }]);
});
test('recovery requires both the current account mapping and the exact owned original Message', async () => {
  expect(await mockDependencies.verifyOwner(row)).toBe(true);
  expect(mockResolveMapping).toHaveBeenCalledWith({ telegramUserId: 'sender' });
  expect(mockMessage.exists).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: 'conversation',
    messageId: 'original-message',
    isCreatedByUser: true,
    'metadata.viventium.telegramInput.sourceEventId': row.sourceEventId,
  });
  mockResolveMapping.mockResolvedValue({ libreChatUserId: 'other' });
  expect(await mockDependencies.verifyOwner(row)).toBe(false);
});
test('ready persistence uses owned attachments, the existing Message, and the native source mutation guard', async () => {
  await mockDependencies.transaction(() => mockDependencies.persistPrepared(row, prepared));
  expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
    retry: 'native',
  });
  expect(mockGetFiles).toHaveBeenCalledWith({
    user: 'owner',
    file_id: { $in: ['file-1'] },
  });
  expect(mockSourceMutation).toHaveBeenCalledWith(
    expect.objectContaining({ user: 'owner', messageId: 'original-message' }),
    expect.any(Function),
  );
  expect(mockMessage.updateOne).toHaveBeenCalledWith(expect.anything(), {
    $set: {
      text: prepared.text,
      files: [{ file_id: 'file-1', user: 'owner' }],
      content: [],
      'metadata.viventium.telegramInput.state': 'ready',
    },
  });
});
/* VIVENTIUM: a ready input keeps its quoted document's text for an identity-only continuation. */
test('a ready input keeps its quoted document text, which its envelope returns for continuation', async () => {
  const quotedAttachmentTexts = [
    { fileId: 'quoted-doc', extractedText: 'Willow 4.10 per booklet' },
  ];
  await mockDependencies.persistPrepared(row, { ...prepared, quotedAttachmentTexts });
  expect(mockMessage.updateOne).toHaveBeenCalledWith(expect.anything(), {
    $set: expect.objectContaining({
      'metadata.viventium.telegramInput.state': 'ready',
      'metadata.viventium.telegramInput.quotedAttachmentTexts': quotedAttachmentTexts,
    }),
  });
  mockMessage.findOne.mockReturnValueOnce({
    lean: async () => ({
      text: prepared.text,
      metadata: {
        viventium: { telegramInput: { preparation: { message: {} }, quotedAttachmentTexts } },
      },
    }),
  });
  await expect(inputService.inputEnvelope(row)).resolves.toMatchObject({
    preparation: { message: {} },
    quotedAttachmentTexts,
  });
});
test('missing attachments or a removed original Message cannot be accepted as ready', async () => {
  mockGetFiles.mockResolvedValueOnce([]);
  await expect(mockDependencies.persistPrepared(row, prepared)).rejects.toMatchObject({
    code: 'source_input_attachment_unavailable',
  });
  expect(mockMessage.updateOne).not.toHaveBeenCalled();
  mockMessage.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(mockDependencies.persistPrepared(row, prepared)).rejects.toMatchObject({
    code: 'source_input_message_unavailable',
  });
});
test('stream binding requires original source ownership; completion requires the committed delivery acknowledgement', async () => {
  const job = {
    status: 'completed',
    metadata: {
      userId: 'owner',
      conversationId: 'conversation',
      interactionContext: {
        source_event_id: row.sourceEventId,
        source_order_scope: row.sourceOrderScope,
        source_sequence: 12,
      },
    },
  };
  mockGetJob.mockResolvedValue(job);
  expect(await mockDependencies.verifyStream(row, 'stream')).toBe(true);
  expect(await mockDependencies.readStream('stream', 'owner')).toBe('pending');
  job.metadata.deliveryAcknowledgement = { state: 'committed' };
  expect(await mockDependencies.readStream('stream', 'owner')).toBe('completed');
  job.metadata.interactionContext.source_sequence = 13;
  expect(await mockDependencies.verifyStream(row, 'stream')).toBe(false);
  expect(await mockDependencies.readStream('stream', 'other')).toBe('missing');
});
test('an adapter failed acknowledgement ends its stream answer instead of waiting on the job', async () => {
  mockGetJob.mockResolvedValue({
    status: 'running',
    metadata: { userId: 'owner', deliveryAcknowledgement: { state: 'failed' } },
  });
  expect(await mockDependencies.readStream('stream', 'owner')).toBe('failed');
});
test('a failed carrier is only a newer input of the same conversation that was admitted to a stream', async () => {
  mockIngress.exists = jest.fn().mockResolvedValue(true);
  const sibling = {
    ...row,
    telegramChatId: 'chat',
    telegramMessageThreadId: 'thread',
    conversationGeneration: 'generation',
  };
  expect(await inputService.hasNewerFailedAdmittedInput(sibling)).toBe(true);
  expect(mockIngress.exists).toHaveBeenCalledWith({
    libreChatUserId: 'owner',
    telegramUserId: 'sender',
    telegramChatId: 'chat',
    telegramMessageThreadId: 'thread',
    sourceOrderScope: row.sourceOrderScope,
    conversationGeneration: 'generation',
    conversationId: 'conversation',
    sourceSequence: { $gt: 12 },
    inputState: 'failed',
    streamId: { $nin: ['', null] },
  });
});
/* VIVENTIUM END */

const pendingIdentity = {
  libreChatUserId: 'owner',
  telegramUserId: 'sender',
  telegramChatId: 'chat',
  telegramMessageThreadId: 'thread',
  sourceOrderScope: 'scope',
  conversationGeneration: 'generation',
  requestedConversationId: 'fresh-conversation',
  sourceSequence: 13,
};
test('pending conversation reuse requires the active exact owner, source scope and generation', async () => {
  mockIngress.findOne.mockReturnValue({
    lean: async () => ({ ...row, conversationId: 'fresh-conversation' }),
  });
  const result = await inputService.resolvePendingConversation(pendingIdentity);
  expect(result).toEqual({ conversationId: 'fresh-conversation' });
  expect(mockIngress.findOne).toHaveBeenCalledWith({
    libreChatUserId: 'owner',
    telegramUserId: 'sender',
    telegramChatId: 'chat',
    telegramMessageThreadId: 'thread',
    sourceOrderScope: 'scope',
    conversationGeneration: 'generation',
    conversationId: 'fresh-conversation',
    sourceSequence: { $lt: 13 },
    inputState: { $in: ['preparing', 'ready', 'admitted'] },
    $or: [{ inputState: 'ready' }, { inputLeaseUntil: { $gt: expect.any(Number) } }],
  });
  expect(mockMessage.exists).toHaveBeenCalledWith(
    expect.objectContaining({
      user: 'owner',
      conversationId: 'fresh-conversation',
      messageId: 'original-message',
      'metadata.viventium.telegramInput.sourceEventId': row.sourceEventId,
    }),
  );
});
test('missing, reset, foreign mapping and deleted original cannot revive a conversation', async () => {
  mockIngress.findOne.mockReturnValue({ lean: async () => null });
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
  expect(
    await inputService.resolvePendingConversation({
      ...pendingIdentity,
      requestedConversationId: 'new',
    }),
  ).toBeNull();
  expect(mockIngress.findOne).toHaveBeenCalledTimes(1);
  mockIngress.findOne.mockReturnValue({
    lean: async () => ({ ...row, conversationId: 'fresh-conversation' }),
  });
  mockResolveMapping.mockResolvedValue({ libreChatUserId: 'foreign' });
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
  mockResolveMapping.mockResolvedValue({ libreChatUserId: 'owner' });
  mockMessage.exists.mockResolvedValue(false);
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
});

test('committed coverage permits only the retained source original and canonical conversation generation aliases', async () => {
  mockConversationGeneration.mockImplementation(
    (record) => `generation:${record.requestedConversationId}`,
  );
  await mockDependencies.hasCommittedDelivery({ ...row, requestedConversationId: 'new' });
  expect(mockMessage.exists).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: row.conversationId,
      'metadata.viventium.deliverySourceCoverage.source_conversation_generation': {
        $in: ['generation:new', 'generation:conversation'],
      },
      'metadata.viventium.deliverySourceCoverage.sources': {
        $elemMatch: {
          source_event_id: row.sourceEventId,
          source_message_id: row.sourceMessageId,
          source_sequence: 12,
          owned: { $ne: false },
        },
      },
    }),
  );
});

test('a ready input waiting for Main preserves its conversation after releasing its preparation lease', async () => {
  mockIngress.findOne.mockReturnValue({
    lean: async () => ({
      ...row,
      conversationId: 'fresh-conversation',
      inputState: 'ready',
      inputLeaseUntil: 0,
    }),
  });
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toEqual({
    conversationId: 'fresh-conversation',
  });
  expect(mockIngress.findOne).toHaveBeenCalledWith(
    expect.objectContaining({
      inputState: { $in: ['preparing', 'ready', 'admitted'] },
      $or: [{ inputState: 'ready' }, { inputLeaseUntil: { $gt: expect.any(Number) } }],
    }),
  );
});

test('preparation group lookup binds owner, sender, chat, thread, source scope and exact conversation generation', async () => {
  const group = {
    ...row,
    telegramChatId: 'chat',
    telegramMessageThreadId: 'thread',
    conversationGeneration: 'generation',
    mediaGroupId: 'album',
  };
  mockIngress.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: async () => [] }) });
  expect(await mockDependencies.repository.group(group)).toEqual([]);
  expect(mockIngress.find).toHaveBeenCalledWith({
    libreChatUserId: 'owner',
    telegramUserId: 'sender',
    telegramChatId: 'chat',
    telegramMessageThreadId: 'thread',
    sourceOrderScope: row.sourceOrderScope,
    conversationGeneration: 'generation',
    conversationId: 'conversation',
    mediaGroupId: 'album',
    inputState: { $in: ['preparing', 'failed'] },
    $expr: { $eq: ['$inputPrimarySourceEventId', '$sourceEventId'] },
  });
});

/* VIVENTIUM START: terminal effect receipts settle their own accepted input, not another source. */
test.each(['committed', 'committed_effect'])(
  'owned %s acknowledgement is terminal for input recovery',
  async (state) => {
    mockGetJob.mockResolvedValue({
      status: 'completed',
      metadata: { userId: 'owner', deliveryAcknowledgement: { state, revision: 1 } },
    });
    expect(await mockDependencies.readStream('stream', 'owner')).toBe('completed');
    expect(await mockDependencies.readStream('stream', 'other')).toBe('missing');
  },
);
test.each([undefined, 'partial_removed', 'unknown'])(
  'unfinished %s acknowledgement does not suppress recovery',
  async (state) => {
    mockGetJob.mockResolvedValue({
      status: 'completed',
      metadata: { userId: 'owner', deliveryAcknowledgement: { state } },
    });
    expect(await mockDependencies.readStream('stream', 'owner')).toBe('pending');
  },
);
test('effect-committed input settles once instead of reopening the saved receipt each lease', async () => {
  const { createTelegramInputService } = jest.requireActual('@librechat/api');
  let clock = 1_000_000;
  let retained = {
    ...row,
    telegramChatId: 'chat',
    telegramMessageThreadId: '',
    requestedConversationId: 'conversation',
    conversationGeneration: 'c'.repeat(64),
    state: 'admitted',
    claimToken: '00000000-0000-4000-8000-000000000001',
    registrationId: '00000000-0000-4000-8000-000000000002',
    leaseUntil: 0,
    retryAt: 0,
    attempts: 0,
    streamId: 'stream',
    failureCode: '',
    preparedDigest: 'd'.repeat(64),
    failures: [],
    primarySourceEventId: row.sourceEventId,
    relatedSourceEventIds: [],
    mediaGroupId: '',
  };
  mockGetJob.mockResolvedValue({
    status: 'completed',
    metadata: {
      userId: 'owner',
      deliveryAcknowledgement: {
        state: 'committed_effect',
        revision: 1,
        effect_ref: 'work-reference',
      },
    },
  });
  const writes = [];
  const service = createTelegramInputService({
    ...mockDependencies,
    now: () => clock,
    verifyOwner: async () => true,
    hasCommittedDelivery: async () => false,
    transaction: async (operation) => operation(),
    repository: {
      read: async () => structuredClone(retained),
      due: async () =>
        retained.state === 'admitted' && retained.leaseUntil <= clock
          ? [structuredClone(retained)]
          : [],
      replace: async (previous, next) => {
        if (JSON.stringify(previous) !== JSON.stringify(retained)) return false;
        writes.push(next.state);
        retained = structuredClone(next);
        return true;
      },
    },
  });
  expect(await service.claimPending(1)).toEqual([]);
  expect(retained.state).toBe('completed');
  expect(retained.leaseUntil).toBe(0);
  clock += 120_001;
  expect(await service.claimPending(1)).toEqual([]);
  expect(writes).toEqual(['completed']);
});
/* VIVENTIUM END */

/* VIVENTIUM START: exact durable terminal recovery, with no provider or Redis resurrection. */
const {
  bindRetainedTelegramResponse,
  readRetainedTelegramTerminal,
  acknowledgeRetainedTelegramFailure,
} = require('./TelegramIngressAuthorityService');
function terminalFixture() {
  const binding = {
    streamId: 'stream',
    responseMessageId: 'reply',
    logicalTurnId: 'turn',
    revision: 2,
  };
  const record = {
    ...row,
    streamId: 'stream',
    inputState: 'admitted',
    claimToken: 'claim',
    responseBinding: binding,
  };
  const context = { source_event_id: row.sourceEventId, logical_turn_id: 'turn', revision: 2 };
  const message = {
    messageId: 'reply',
    content: [
      { type: 'error', error_class: 'source_context_unavailable', error: 'Context unavailable.' },
    ],
    metadata: { viventium: { interactionContext: context } },
  };
  const IngressModel = {
    findOne: jest.fn(() => ({ lean: async () => record })),
    exists: jest.fn(async () => true),
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
  };
  const MessageModel = { findOne: jest.fn(() => ({ lean: async () => message })) };
  const identity = {
    record,
    streamId: 'stream',
    conversationId: row.conversationId,
    sourceMessageId: row.sourceMessageId,
    responseMessageId: 'reply',
    interactionContext: context,
    IngressModel,
  };
  const read = () =>
    readRetainedTelegramTerminal({
      ownerId: 'owner',
      streamId: 'stream',
      telegramUserId: 'sender',
      IngressModel,
      MessageModel,
    });
  return { record, binding, message, IngressModel, MessageModel, identity, read };
}
test('binds the actual onStart author with exact source, owner, stream and current claim CAS', async () => {
  const f = terminalFixture();
  await bindRetainedTelegramResponse(f.identity);
  await bindRetainedTelegramResponse(f.identity);
  expect(f.IngressModel.updateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      libreChatUserId: 'owner',
      sourceEventId: row.sourceEventId,
      streamId: 'stream',
      inputClaimToken: 'claim',
      sourceMessageId: row.sourceMessageId,
      conversationId: row.conversationId,
      inputState: 'admitted',
      $or: [
        { responseBinding: { $exists: false } },
        { responseBinding: f.binding },
        { 'responseBinding.streamId': { $ne: 'stream' } },
      ],
    }),
    { $set: { responseBinding: f.binding } },
  );
  f.IngressModel.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(bindRetainedTelegramResponse(f.identity)).rejects.toMatchObject({
    code: 'TELEGRAM_RESPONSE_IDENTITY_UNAVAILABLE',
  });
});
test.each(['streamId', 'sourceMessageId', 'conversationId'])(
  'refuses onStart changed %s before persistence',
  async (field) => {
    const f = terminalFixture();
    await expect(
      bindRetainedTelegramResponse({ ...f.identity, [field]: 'foreign' }),
    ).rejects.toMatchObject({ code: 'TELEGRAM_RESPONSE_IDENTITY_UNAVAILABLE' });
    expect(f.IngressModel.updateOne).not.toHaveBeenCalled();
  },
);
test('recovers only the exact bound terminal and preserves its typed class', async () => {
  const f = terminalFixture();
  await expect(f.read()).resolves.toMatchObject({
    error_class: 'source_context_unavailable',
    responseMessageId: 'reply',
  });
  expect(f.MessageModel.findOne).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: row.conversationId,
    messageId: 'reply',
    parentMessageId: row.sourceMessageId,
    isCreatedByUser: false,
    unfinished: false,
    error: true,
    'metadata.viventium.interactionContext.source_event_id': row.sourceEventId,
    'metadata.viventium.interactionContext.logical_turn_id': 'turn',
    'metadata.viventium.interactionContext.revision': 2,
  });
  expect(f.IngressModel.findOne).toHaveBeenCalledWith(
    expect.objectContaining({
      libreChatUserId: 'owner',
      streamId: 'stream',
      telegramUserId: 'sender',
    }),
  );
});
test.each(['no-binding', 'wrong-stream', 'empty', 'untyped', 'duplicate-error', 'replaced'])(
  'does not recover %s terminal evidence',
  async (kind) => {
    const f = terminalFixture();
    if (kind === 'no-binding') delete f.record.responseBinding;
    if (kind === 'wrong-stream') f.binding.streamId = 'other-stream';
    if (kind === 'empty') f.message.content = [];
    if (kind === 'untyped') f.message.content = [{ type: 'text', text: 'A failure happened.' }];
    if (kind === 'duplicate-error') f.message.content.push({ ...f.message.content[0] });
    if (kind === 'replaced') f.IngressModel.exists.mockResolvedValue(false);
    await expect(f.read()).resolves.toBeNull();
  },
);
test('late durable terminal due query joins only failed rows and retains the regular bounded query', async () => {
  const boundedRead = { lean: async () => [] };
  const limitRead = jest.fn(() => boundedRead);
  mockIngress.find.mockReturnValue({ sort: jest.fn(() => ({ limit: limitRead })) });
  mockIngress.aggregate.mockResolvedValue([]);
  await mockDependencies.repository.due(123, 5);
  expect(limitRead).toHaveBeenCalledWith(5);
  expect(mockIngress.find).toHaveBeenCalledWith(
    expect.objectContaining({
      $or: [{ inputState: { $ne: 'failed' } }, { inputRetryAt: { $gt: 0 } }],
    }),
  );
  const pipeline = mockIngress.aggregate.mock.calls[0][0];
  expect(pipeline[0].$match).toMatchObject({
    inputState: 'failed',
    inputRetryAt: 0,
    inputFailureCode: 'accepted_response_unavailable',
  });
  const join = pipeline.find((stage) => stage.$lookup).$lookup;
  expect(join.from).toBe('messages');
  expect(join.pipeline[0].$match).toMatchObject({
    unfinished: false,
    error: true,
    isCreatedByUser: false,
    'metadata.viventium.deliveryAcknowledgement.state': {
      $nin: ['committed', 'committed_effect', 'failed'],
    },
  });
  expect(join.pipeline[0].$match.$expr.$and).toContainEqual({
    $eq: ['$messageId', '$$binding.responseMessageId'],
  });
  expect(pipeline.at(-2)).toEqual({ $limit: 5 });
});
/* VIVENTIUM END */

test('failed terminal ACK settles the existing ingress and Message once, including duplicate replay', async () => {
  const f = terminalFixture();
  f.record.inputClaimToken = 'claim';
  const acknowledgement = {
    logical_turn_id: 'turn',
    revision: 2,
    state: 'failed',
    presentation_ref: 'telegram:chat',
  };
  f.MessageModel.updateOne = jest.fn(async (_filter, update) => {
    f.message.metadata.viventium.deliveryAcknowledgement =
      update.$set['metadata.viventium.deliveryAcknowledgement'];
    return { matchedCount: 1 };
  });
  f.IngressModel.updateOne.mockImplementation(async (_filter, update) => {
    Object.assign(f.record, update.$set);
    return { matchedCount: 1 };
  });
  const models = { IngressModel: f.IngressModel, MessageModel: f.MessageModel };
  await expect(
    acknowledgeRetainedTelegramFailure(acknowledgement, 'telegram', models),
  ).resolves.toMatchObject({ status: 'recorded', idempotent: false, transportOnly: true });
  expect(f.record).toMatchObject({
    inputState: 'failed',
    inputFailureCode: 'source_terminal_presented',
    inputRetryAt: 0,
    inputLeaseUntil: 0,
  });
  await expect(
    acknowledgeRetainedTelegramFailure(acknowledgement, 'telegram', models),
  ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
  await expect(f.read()).resolves.toBeNull();
  expect(mockTransaction).toHaveBeenCalled();
});
test.each(['voice', 'committed', 'changed-author'])(
  'terminal fallback refuses %s without accepting or regenerating work',
  async (kind) => {
    const f = terminalFixture();
    const ack = {
      logical_turn_id: 'turn',
      revision: 2,
      state: kind === 'committed' ? 'committed' : 'failed',
    };
    f.MessageModel.updateOne = jest.fn();
    if (kind === 'changed-author') f.IngressModel.exists.mockResolvedValue(false);
    await expect(
      acknowledgeRetainedTelegramFailure(ack, kind === 'voice' ? 'voice' : 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toMatchObject({ status: 'not_found' });
    expect(f.MessageModel.updateOne).not.toHaveBeenCalled();
  },
);
test('a raced ingress settlement throws inside the existing transaction instead of leaving a successful ACK', async () => {
  const f = terminalFixture();
  f.MessageModel.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
  f.IngressModel.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(
    acknowledgeRetainedTelegramFailure(
      { logical_turn_id: 'turn', revision: 2, state: 'failed' },
      'telegram',
      { IngressModel: f.IngressModel, MessageModel: f.MessageModel },
    ),
  ).rejects.toMatchObject({ code: 'telegram_terminal_ack_conflict' });
});

test('a removed preview still permits one exact typed terminal and its failed ACK', async () => {
  const f = terminalFixture();
  const removed = { logical_turn_id: 'turn', revision: 2, state: 'partial_removed' };
  f.message.metadata.viventium.deliveryAcknowledgement = removed;
  await expect(f.read()).resolves.toMatchObject({ error_class: 'source_context_unavailable' });
  f.MessageModel.updateOne = jest.fn(async (_filter, update) => {
    f.message.metadata.viventium.deliveryAcknowledgement =
      update.$set['metadata.viventium.deliveryAcknowledgement'];
    return { matchedCount: 1 };
  });
  const ack = { logical_turn_id: 'turn', revision: 2, state: 'failed' };
  await expect(
    acknowledgeRetainedTelegramFailure(ack, 'telegram', {
      IngressModel: f.IngressModel,
      MessageModel: f.MessageModel,
    }),
  ).resolves.toMatchObject({ status: 'recorded', idempotent: false });
  expect(f.MessageModel.updateOne.mock.calls[0][0].$or).toContainEqual({
    'metadata.viventium.deliveryAcknowledgement': removed,
  });
  await expect(f.read()).resolves.toBeNull();
});
test('a conflicting terminal presentation ACK is not replaced', async () => {
  const f = terminalFixture();
  f.message.metadata.viventium.deliveryAcknowledgement = {
    logical_turn_id: 'turn',
    revision: 2,
    state: 'failed',
    presentation_ref: 'telegram:other',
  };
  f.MessageModel.updateOne = jest.fn();
  await expect(
    acknowledgeRetainedTelegramFailure(
      { logical_turn_id: 'turn', revision: 2, state: 'failed' },
      'telegram',
      { IngressModel: f.IngressModel, MessageModel: f.MessageModel },
    ),
  ).resolves.toEqual({ status: 'conflict' });
  expect(f.MessageModel.updateOne).not.toHaveBeenCalled();
});

test('regular and late terminal candidates keep one globally oldest bounded batch', async () => {
  const candidate = (sourceEventId, updatedAt) => ({
    ...row,
    sourceEventId,
    inputState: 'admitted',
    updatedAt: new Date(updatedAt),
  });
  mockIngress.find.mockReturnValue({
    sort: () => ({
      limit: () => ({
        lean: async () => [candidate('regular-old', 10), candidate('regular-new', 30)],
      }),
    }),
  });
  mockIngress.aggregate.mockResolvedValue([candidate('terminal-middle', 20)]);
  const result = await mockDependencies.repository.due(100, 2);
  expect(result.map((record) => record.sourceEventId)).toEqual(['regular-old', 'terminal-middle']);
});
