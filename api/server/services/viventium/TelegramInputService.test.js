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
const mockNativeSourceMatches = jest.fn(async () => true);
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
  telegramTerminalPresentationScope: (...args) =>
    jest.requireActual('@librechat/api').telegramTerminalPresentationScope(...args),
  telegramInputConversationGeneration: (...args) => mockConversationGeneration(...args),
  GenerationJobManager: { getJob: (...args) => mockGetJob(...args) },
}));
jest.mock('~/db/models', () => ({
  Message: mockMessage,
  ViventiumTelegramIngressEvent: mockIngress,
}));
jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  nativeResponseSourceMatches: (...args) => mockNativeSourceMatches(...args),
}));
jest.mock('../TelegramLinkService', () => ({
  resolveTelegramMapping: (...args) => mockResolveMapping(...args),
}));
jest.mock('./GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (...args) => mockTransaction(...args),
}));
const mockReadHostFinal = jest.fn(async () => null);
jest.mock('./nativeResponseService', () => ({
  readRetainedHostFinal: (...args) => mockReadHostFinal(...args),
  readRetainedMainFinal: (...args) => mockReadHostFinal(...args),
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
  mockReadHostFinal.mockResolvedValue(null);
  mockGetJob.mockResolvedValue(undefined);
  mockNativeSourceMatches.mockResolvedValue(true);
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
test.each(['cached job', 'retained host final'])(
  'uncertain file delivery after completed Main settles without replay through %s',
  async (retention) => {
    const { createTelegramInputService } = jest.requireActual('@librechat/api');
    let clock = 1_000_000;
    const acknowledgement = {
      logical_turn_id: 'turn',
      revision: 2,
      state: 'failed',
      presentation_refs: ['telegram:chat:confirmed-file'],
    };
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
      responseBinding: {
        streamId: 'stream',
        responseMessageId: 'reply',
        logicalTurnId: 'turn',
        revision: 2,
      },
    };
    const hostFinal = {
      responseMessageId: 'reply',
      conversationId: 'conversation',
      interactionContext: {
        source_event_id: row.sourceEventId,
        logical_turn_id: 'turn',
        revision: 2,
      },
      finalEvent: {
        requestMessage: { messageId: row.sourceMessageId },
        responseMessage: { text: '{NTA}', files: [{ file_id: 'accepted-file' }] },
      },
      acknowledgement,
    };
    mockIngress.findOne.mockImplementation(() => ({ lean: async () => retained }));
    mockIngress.exists.mockResolvedValue(true);
    mockReadHostFinal.mockResolvedValue(hostFinal);
    mockGetJob.mockResolvedValue(
      retention === 'cached job'
        ? {
            status: 'complete',
            metadata: {
              userId: 'owner',
              generationCompleted: true,
              deliveryAcknowledgement: acknowledgement,
            },
          }
        : undefined,
    );
    const writes = [];
    const prepare = jest.fn();
    const service = createTelegramInputService({
      ...mockDependencies,
      now: () => clock,
      verifyOwner: async () => true,
      hasCommittedDelivery: async () => false,
      persistPrepared: prepare,
      transaction: async (operation) => operation(),
      repository: {
        read: async () => structuredClone(retained),
        due: async () =>
          retained.state === 'admitted' && retained.leaseUntil <= clock
            ? [structuredClone(retained)]
            : [],
        replace: async (previous, next) => {
          if (JSON.stringify(previous) !== JSON.stringify(retained)) return false;
          writes.push(structuredClone(next));
          retained = structuredClone(next);
          return true;
        },
      },
    });
    // Use the real host readStream and terminal-settlement consumers, not a synthetic 'failed'.
    expect(await service.claimPending(1)).toEqual([]);
    expect(retained).toMatchObject({
      state: 'failed',
      failureCode: 'accepted_response_unavailable',
      leaseUntil: 0,
      retryAt: 0,
      attempts: 0,
      claimToken: '00000000-0000-4000-8000-000000000001',
    });
    clock += 120_001;
    expect(await service.claimPending(1)).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(mockMessage.updateOne).not.toHaveBeenCalled();
    expect(mockIngress.updateOne).not.toHaveBeenCalled();
    expect(hostFinal.acknowledgement).toEqual(acknowledgement);
    expect(hostFinal.finalEvent.responseMessage).toEqual({
      text: '{NTA}',
      files: [{ file_id: 'accepted-file' }],
    });
  },
);
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
  const MessageModel = {
    findOne: jest.fn(() => ({
      select() {
        return this;
      },
      lean: async () => message,
    })),
  };
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
    deletedAt: null,
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
    $or: expect.arrayContaining([{ 'hostFinal.version': 1, error: { $ne: true } }]),
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

test('the same exact ingress reader accepts host final and rejects replaced or mismatched binding', async () => {
  const f = terminalFixture();
  const terminal = {
    responseMessageId: 'reply',
    conversationId: row.conversationId,
    interactionContext: f.message.metadata.viventium.interactionContext,
    finalEvent: {
      final: true,
      requestMessage: { messageId: row.sourceMessageId },
      responseMessage: { messageId: 'reply', text: 'Final' },
    },
  };
  mockReadHostFinal.mockResolvedValue(terminal);
  expect(await f.read()).toEqual(terminal);
  f.MessageModel.findOne.mockReturnValue({ lean: async () => null });
  mockReadHostFinal.mockResolvedValue({ ...terminal, conversationId: 'foreign' });
  expect(await f.read()).toBeNull();
  mockReadHostFinal.mockResolvedValue(terminal);
  f.IngressModel.exists.mockResolvedValue(false);
  expect(await f.read()).toBeNull();
  mockReadHostFinal.mockResolvedValue(null);
});

describe('obsolete accepted terminal recovery', () => {
  const record = {
    ...row,
    telegramChatId: 'chat',
    telegramMessageThreadId: '',
    conversationGeneration: 'generation',
    state: 'admitted',
    claimToken: 'claim',
    leaseUntil: 100,
    streamId: 'old-stream',
  };
  const context = { source_event_id: row.sourceEventId, logical_turn_id: 'old-turn', revision: 2 };
  const binding = {
    streamId: 'old-stream',
    responseMessageId: 'old-answer',
    logicalTurnId: 'old-turn',
    revision: 2,
  };
  beforeEach(() => {
    mockReadHostFinal.mockResolvedValue(null);
    mockIngress.findOne.mockReturnValue({
      lean: async () => ({ ...record, responseBinding: binding }),
    });
    mockIngress.exists.mockResolvedValue(true);
    mockIngress.updateOne.mockResolvedValue({ matchedCount: 1 });
    mockResolveMapping.mockResolvedValue({ libreChatUserId: row.libreChatUserId });
    mockMessage.exists.mockResolvedValue(true);
    mockMessage.findOne.mockReturnValue({
      select() {
        return this;
      },
      lean: async () => ({
        messageId: 'old-answer',
        error: true,
        unfinished: false,
        content: [{ type: 'error', error_class: 'native_response_failed', error: 'Known failure' }],
        metadata: { viventium: { interactionContext: context } },
      }),
    });
  });
  test('known failed obsolete presentation settles failed, preserves source and invalidates old lease', async () => {
    expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(true);
    expect(mockIngress.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBinding: binding,
        inputState: 'admitted',
        inputClaimToken: 'claim',
      }),
      {
        $set: {
          inputState: 'failed',
          inputFailureCode: 'source_terminal_superseded',
          inputLeaseUntil: 0,
          inputRetryAt: 0,
          inputClaimToken: '',
        },
      },
    );
    expect(mockMessage.updateOne).not.toHaveBeenCalled();
  });
  test('later completion alone cannot settle an unknown accepted action', async () => {
    mockReadHostFinal.mockResolvedValue(null);
    mockMessage.findOne.mockReturnValue({
      select() {
        return this;
      },
      lean: async () => null,
    });
    expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(false);
    expect(mockIngress.updateOne).not.toHaveBeenCalled();
  });
  test('a current terminal remains recoverable when no newer completed source exists', async () => {
    mockIngress.exists.mockResolvedValue(false);
    mockMessage.exists.mockImplementation(async (filter) => !filter.$or);
    expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(false);
    expect(mockIngress.updateOne).not.toHaveBeenCalled();
  });
  test('a changed current response binding cannot settle old claimed presentation', async () => {
    mockIngress.findOne.mockReturnValue({
      lean: async () => ({ ...record, responseBinding: { ...binding, revision: 3 } }),
    });
    expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(false);
    expect(mockIngress.updateOne).not.toHaveBeenCalled();
  });
  test.each(['newer-failed', 'new-conversation', 'expired-ingress'])(
    'durable chat source %s retires only old failed presentation',
    async (kind) => {
      const newer = {
        libreChatUserId: record.libreChatUserId,
        telegramUserId: record.telegramUserId,
        telegramChatId: record.telegramChatId,
        telegramMessageThreadId: record.telegramMessageThreadId,
        sourceOrderScope: record.sourceOrderScope,
        sourceEventId: 'f'.repeat(64),
        sourceSequence: 13,
        inputState: 'failed',
        conversationId:
          kind === 'new-conversation' ? 'different-conversation' : record.conversationId,
      };
      const matches = require('sift').default;
      mockIngress.exists.mockImplementation(async (filter) =>
        filter.sourceSequence ? kind !== 'expired-ingress' && matches(filter)(newer) : true,
      );
      const saved = {
        user: record.libreChatUserId,
        deletedAt: null,
        isCreatedByUser: true,
        metadata: {
          viventium: {
            interactionContext: {
              source_order_scope: record.sourceOrderScope,
              source_sequence: 13,
              source_event_id: newer.sourceEventId,
            },
            originalInputReceipt: { sourceEventId: newer.sourceEventId },
          },
        },
      };
      mockMessage.exists.mockImplementation(async (filter) => {
        if (!filter.$or) return true;
        expect(filter.$or[0].$expr).toEqual({
          $eq: [
            '$metadata.viventium.originalInputReceipt.sourceEventId',
            '$metadata.viventium.interactionContext.source_event_id',
          ],
        });
        const query = structuredClone(filter);
        delete query.$or[0].$expr;
        return (
          saved.metadata.viventium.originalInputReceipt.sourceEventId ===
            saved.metadata.viventium.interactionContext.source_event_id && matches(query)(saved)
        );
      });
      expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(true);
      expect(mockIngress.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ inputState: 'admitted' }),
        {
          $set: {
            inputState: 'failed',
            inputFailureCode: 'source_terminal_superseded',
            inputLeaseUntil: 0,
            inputRetryAt: 0,
            inputClaimToken: '',
          },
        },
      );
    },
  );
  test('own merged A+B sources are compared at their actual later presentation sequence', async () => {
    const mergedContext = {
      ...context,
      source_sequence: 13,
      ready_input_continuation: { presentation_source_sequence: 14 },
      source_segments: [{ source_event_id: 'd'.repeat(64), source_sequence: 13 }],
    };
    mockMessage.findOne.mockReturnValue({
      select() {
        return this;
      },
      lean: async () => ({
        messageId: 'old-answer',
        error: true,
        unfinished: false,
        content: [{ type: 'error', error_class: 'native_response_failed', error: 'Known failure' }],
        metadata: { viventium: { interactionContext: mergedContext } },
      }),
    });
    mockIngress.exists.mockImplementation(async (filter) => (filter.sourceSequence ? false : true));
    mockMessage.exists.mockImplementation(async (filter) => !filter.$or);
    expect(await mockDependencies.settleObsoleteTerminal(record)).toBe(false);
    expect(mockIngress.exists).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSequence: { $gt: 14 },
        sourceEventId: { $nin: [record.sourceEventId, 'd'.repeat(64)] },
      }),
    );
    expect(mockIngress.updateOne).not.toHaveBeenCalled();
  });
});

test('a complete cached stream before adapter ACK remains presentable even if retained proof is unavailable', async () => {
  mockGetJob.mockResolvedValue({ status: 'complete', metadata: { userId: 'owner' } });
  mockReadHostFinal.mockResolvedValue(null);
  mockIngress.findOne.mockReturnValue({ lean: async () => null });
  expect(await mockDependencies.readStream('complete-before-ack', 'owner')).toBe('terminal');
});

test('current failed presentation ACK settles the exact source through the real retained ACK owner', async () => {
  const record = {
    ...row,
    inputState: 'admitted',
    state: 'admitted',
    streamId: 'stream',
    inputClaimToken: 'claim',
    claimToken: 'claim',
    inputLeaseUntil: 100,
    leaseUntil: 100,
    authorityBoundAt: new Date(1),
    responseBinding: {
      streamId: 'stream',
      responseMessageId: 'reply',
      logicalTurnId: 'turn',
      revision: 2,
    },
  };
  const ack = {
    logical_turn_id: 'turn',
    revision: 2,
    state: 'failed',
    presentation_ref: 'telegram:chat',
  };
  const message = {
    messageId: 'reply',
    parentMessageId: row.sourceMessageId,
    error: true,
    unfinished: false,
    content: [
      { type: 'error', error_class: 'native_response_failed', error: 'Known terminal failure' },
    ],
    metadata: {
      viventium: {
        interactionContext: {
          source_event_id: row.sourceEventId,
          logical_turn_id: 'turn',
          revision: 2,
        },
        deliveryAcknowledgement: ack,
      },
    },
  };
  mockGetJob.mockResolvedValue(undefined);
  mockReadHostFinal.mockResolvedValue(null);
  mockIngress.findOne.mockReturnValue({ lean: async () => record });
  mockIngress.exists.mockImplementation(async (filter) => !filter.sourceSequence);
  mockMessage.exists.mockImplementation(async (filter) => !filter.$or);
  mockMessage.findOne.mockReturnValue({
    select() {
      return this;
    },
    lean: async () => message,
  });
  mockMessage.updateOne.mockResolvedValue({ matchedCount: 1 });
  mockIngress.updateOne.mockImplementation(async (_filter, patch) => {
    Object.assign(record, patch.$set);
    return { matchedCount: 1 };
  });
  expect(await mockDependencies.settleObsoleteTerminal({ ...record })).toBe(true);
  expect(record).toMatchObject({
    inputState: 'failed',
    inputFailureCode: 'source_terminal_presented',
    inputClaimToken: '',
    inputLeaseUntil: 0,
    inputRetryAt: 0,
  });
  expect(mockTransaction).toHaveBeenCalled();
  expect(mockMessage.updateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId: 'reply',
      parentMessageId: row.sourceMessageId,
      error: true,
      unfinished: false,
      'metadata.viventium.interactionContext.logical_turn_id': 'turn',
    }),
    { $set: { 'metadata.viventium.deliveryAcknowledgement': ack } },
  );
});

describe('retained native failure ACK fences', () => {
  const ack = {
    logical_turn_id: 'turn',
    revision: 2,
    state: 'failed',
    presentation_ref: 'telegram:chat',
  };
  function nativeFixture() {
    const f = terminalFixture();
    f.record.inputClaimToken = 'claim';
    f.message.nativeResponse = {
      status: 'failed',
      finalReplayStoredAt: 10,
      userId: 'owner',
      conversationId: row.conversationId,
      streamId: 'stream',
      responseMessageId: 'reply',
      source: { messageId: row.sourceMessageId, digest: 'd'.repeat(64) },
      logicalTurnId: 'turn',
      revision: 2,
      invocationId: 'invocation',
      bodySha256: 'e'.repeat(64),
    };
    f.MessageModel.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    return f;
  }
  test('cacheless exact native final failure preserves its complete proof in ACK CAS', async () => {
    const f = nativeFixture();
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toMatchObject({ status: 'recorded' });
    expect(mockNativeSourceMatches).toHaveBeenCalledWith(f.message.nativeResponse);
    expect(f.MessageModel.updateOne.mock.calls[0][0]).toMatchObject({
      nativeResponse: f.message.nativeResponse,
    });
    expect(f.IngressModel.updateOne.mock.calls[0][1].$set).toMatchObject({
      inputState: 'failed',
      inputClaimToken: '',
    });
  });
  test.each([
    'running',
    'prepared',
    'pending',
    'missing-replay',
    'foreign-owner',
    'changed-source',
    'different-source-message',
  ])('does not settle %s native or fallback work', async (kind) => {
    const f = nativeFixture();
    if (kind === 'running')
      mockGetJob.mockResolvedValue({
        status: 'running',
        metadata: {
          userId: 'owner',
          conversationId: row.conversationId,
          responseMessageId: 'reply',
          interactionContext: { logical_turn_id: 'turn', revision: 2 },
        },
      });
    if (kind === 'prepared' || kind === 'pending') f.message.nativeResponse.status = kind;
    if (kind === 'missing-replay') f.message.nativeResponse.finalReplayStoredAt = 0;
    if (kind === 'foreign-owner') f.message.nativeResponse.userId = 'foreign';
    if (kind === 'changed-source') mockNativeSourceMatches.mockResolvedValue(false);
    if (kind === 'different-source-message')
      f.message.nativeResponse.source.messageId = 'different';
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toEqual({ status: 'not_found' });
    expect(f.MessageModel.updateOne).not.toHaveBeenCalled();
    expect(f.IngressModel.updateOne).not.toHaveBeenCalled();
  });
  test.each(['owner', 'conversation', 'response', 'revision'])(
    'a replacement cached %s binding cannot settle the former failure',
    async (kind) => {
      const f = nativeFixture();
      const metadata = {
        userId: 'owner',
        conversationId: row.conversationId,
        responseMessageId: 'reply',
        interactionContext: { logical_turn_id: 'turn', revision: 2 },
      };
      if (kind === 'owner') metadata.userId = 'foreign';
      if (kind === 'conversation') metadata.conversationId = 'foreign';
      if (kind === 'response') metadata.responseMessageId = 'replacement';
      if (kind === 'revision') metadata.interactionContext.revision = 3;
      mockGetJob.mockResolvedValue({ status: 'complete', metadata });
      await expect(
        acknowledgeRetainedTelegramFailure(ack, 'telegram', {
          IngressModel: f.IngressModel,
          MessageModel: f.MessageModel,
        }),
      ).resolves.toEqual({ status: 'not_found' });
      expect(f.IngressModel.updateOne).not.toHaveBeenCalled();
    },
  );
  test('a changed exact native snapshot cannot be acknowledged through a stale CAS', async () => {
    const f = nativeFixture();
    f.MessageModel.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toEqual({ status: 'conflict' });
    expect(f.IngressModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('failed ACK merged-source settlement', () => {
  const ack = {
    logical_turn_id: 'turn',
    revision: 2,
    state: 'failed',
    presentation_ref: 'telegram:chat',
  };
  function grouped() {
    const f = terminalFixture();
    const primary = {
      ...f.record,
      inputClaimToken: 'primary-claim',
      authorityBoundAt: new Date(1),
      inputRelatedSourceEventIds: ['b'.repeat(64)],
      inputPrimarySourceEventId: row.sourceEventId,
    };
    const child = {
      ...primary,
      sourceEventId: 'b'.repeat(64),
      sourceMessageId: 'child-original',
      inputClaimToken: 'child-claim',
      responseBinding: undefined,
      inputRelatedSourceEventIds: [],
    };
    const unlisted = { ...child, sourceEventId: 'c'.repeat(64), inputClaimToken: 'unlisted-claim' };
    const rows = [primary, child, unlisted];
    const matches = require('sift').default;
    f.IngressModel.findOne.mockImplementation((filter) => ({
      lean: async () => rows.find(matches(filter)) || null,
    }));
    f.IngressModel.exists.mockImplementation(async (filter) => rows.some(matches(filter)));
    f.IngressModel.updateOne.mockImplementation(async (filter, patch) => {
      const found = rows.find(matches(filter));
      if (!found) return { matchedCount: 0 };
      Object.assign(found, patch.$set);
      return { matchedCount: 1 };
    });
    f.MessageModel.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    return { ...f, primary, child, unlisted, rows };
  }
  test('one existing ACK transaction settles primary and listed admitted aliases, retaining original identities', async () => {
    const f = grouped();
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toMatchObject({ status: 'recorded' });
    for (const record of [f.primary, f.child])
      expect(record).toMatchObject({
        inputState: 'failed',
        inputFailureCode: 'source_terminal_presented',
        inputClaimToken: '',
        inputLeaseUntil: 0,
        inputRetryAt: 0,
      });
    expect(f.child.sourceMessageId).toBe('child-original');
    expect(f.child.sourceEventId).toBe('b'.repeat(64));
    expect(f.unlisted).toMatchObject({ inputState: 'admitted', inputClaimToken: 'unlisted-claim' });
    expect(f.IngressModel.updateOne.mock.calls[1][0]).toMatchObject({
      inputPrimarySourceEventId: row.sourceEventId,
      inputClaimToken: 'child-claim',
      streamId: 'stream',
      inputState: 'admitted',
      sourceEventId: 'b'.repeat(64),
    });
  });
  test.each([
    'foreign-owner',
    'other-stream',
    'other-primary',
    'other-conversation',
    'already-completed',
  ])('does not settle a listed alias with %s authority', async (kind) => {
    const f = grouped();
    if (kind === 'foreign-owner') f.child.libreChatUserId = 'foreign';
    if (kind === 'other-stream') f.child.streamId = 'different';
    if (kind === 'other-primary') f.child.inputPrimarySourceEventId = 'different';
    if (kind === 'other-conversation') f.child.conversationId = 'different';
    if (kind === 'already-completed') f.child.inputState = 'completed';
    const before = structuredClone(f.child);
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).resolves.toMatchObject({ status: 'recorded' });
    expect(f.child).toEqual(before);
    expect(f.IngressModel.updateOne).toHaveBeenCalledTimes(1);
  });
  test('a raced alias claim rejects the transaction instead of reporting complete settlement', async () => {
    const f = grouped();
    const update = f.IngressModel.updateOne.getMockImplementation();
    f.IngressModel.updateOne.mockImplementation(async (filter, patch) =>
      filter.sourceEventId === f.child.sourceEventId ? { matchedCount: 0 } : update(filter, patch),
    );
    await expect(
      acknowledgeRetainedTelegramFailure(ack, 'telegram', {
        IngressModel: f.IngressModel,
        MessageModel: f.MessageModel,
      }),
    ).rejects.toMatchObject({ code: 'telegram_terminal_ack_conflict' });
    expect(f.child.inputState).toBe('admitted');
    expect(f.child.inputClaimToken).toBe('child-claim');
  });
});
