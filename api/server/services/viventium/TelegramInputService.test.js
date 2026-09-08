/* VIVENTIUM START: persisted input ownership and the existing transaction/source guards. */
let mockDependencies;
const mockMessage = {
  exists: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
};
const mockIngress = {
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
    user: 'owner', conversationId: 'conversation', isCreatedByUser: false,
    unfinished: { $ne: true },
    'metadata.viventium.deliveryAcknowledgement.state': 'committed',
    'metadata.viventium.deliverySourceCoverage.source_order_scope': row.sourceOrderScope,
    'metadata.viventium.deliverySourceCoverage.source_conversation_generation': { $in: ['bound-generation'] },
    'metadata.viventium.deliverySourceCoverage.sources': { $elemMatch: {
      source_event_id: row.sourceEventId, source_message_id: row.sourceMessageId, source_sequence: 12,
    } },
    $expr: { $and: [
      { $eq: ['$metadata.viventium.deliverySourceCoverage.logical_turn_id',
        '$metadata.viventium.deliveryAcknowledgement.logical_turn_id'] },
      { $eq: ['$metadata.viventium.deliverySourceCoverage.revision',
        '$metadata.viventium.deliveryAcknowledgement.revision'] },
    ] },
  });
  mockMessage.exists.mockResolvedValueOnce(false);
  expect(await mockDependencies.hasCommittedDelivery(row)).toBe(false);
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
/* VIVENTIUM END */

const pendingIdentity = {
  libreChatUserId: 'owner', telegramUserId: 'sender', telegramChatId: 'chat',
  telegramMessageThreadId: 'thread', sourceOrderScope: 'scope',
  conversationGeneration: 'generation', requestedConversationId: 'fresh-conversation',
  sourceSequence: 13,
};
test('pending conversation reuse requires the active exact owner, source scope and generation', async () => {
  mockIngress.findOne.mockReturnValue({lean: async () => ({...row, conversationId:'fresh-conversation'})});
  const result = await inputService.resolvePendingConversation(pendingIdentity);
  expect(result).toEqual({conversationId:'fresh-conversation'});
  expect(mockIngress.findOne).toHaveBeenCalledWith({
    libreChatUserId:'owner',telegramUserId:'sender',telegramChatId:'chat',
    telegramMessageThreadId:'thread',sourceOrderScope:'scope',conversationGeneration:'generation',
    conversationId:'fresh-conversation',sourceSequence:{$lt:13},
    inputState:{$in:['preparing','ready','admitted']},
    $or:[{inputState:'ready'},{inputLeaseUntil:{$gt:expect.any(Number)}}],
  });
  expect(mockMessage.exists).toHaveBeenCalledWith(expect.objectContaining({
    user:'owner',conversationId:'fresh-conversation',messageId:'original-message',
    'metadata.viventium.telegramInput.sourceEventId':row.sourceEventId,
  }));
});
test('missing, reset, foreign mapping and deleted original cannot revive a conversation', async () => {
  mockIngress.findOne.mockReturnValue({lean:async()=>null});
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
  expect(await inputService.resolvePendingConversation({...pendingIdentity,requestedConversationId:'new'})).toBeNull();
  expect(mockIngress.findOne).toHaveBeenCalledTimes(1);
  mockIngress.findOne.mockReturnValue({lean:async()=>({...row,conversationId:'fresh-conversation'})});
  mockResolveMapping.mockResolvedValue({libreChatUserId:'foreign'});
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
  mockResolveMapping.mockResolvedValue({libreChatUserId:'owner'});
  mockMessage.exists.mockResolvedValue(false);
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toBeNull();
});

test('committed coverage permits only the retained source original and canonical conversation generation aliases', async () => {
  mockConversationGeneration.mockImplementation(record => `generation:${record.requestedConversationId}`);
  await mockDependencies.hasCommittedDelivery({...row,requestedConversationId:'new'});
  expect(mockMessage.exists).toHaveBeenCalledWith(expect.objectContaining({
    conversationId:row.conversationId,
    'metadata.viventium.deliverySourceCoverage.source_conversation_generation':{$in:['generation:new','generation:conversation']},
    'metadata.viventium.deliverySourceCoverage.sources':{$elemMatch:{source_event_id:row.sourceEventId,source_message_id:row.sourceMessageId,source_sequence:12}},
  }));
});

test('a ready input waiting for Main preserves its conversation after releasing its preparation lease', async () => {
  mockIngress.findOne.mockReturnValue({lean:async()=>({...row,conversationId:'fresh-conversation',inputState:'ready',inputLeaseUntil:0})});
  expect(await inputService.resolvePendingConversation(pendingIdentity)).toEqual({conversationId:'fresh-conversation'});
  expect(mockIngress.findOne).toHaveBeenCalledWith(expect.objectContaining({
    inputState:{$in:['preparing','ready','admitted']},
    $or:[{inputState:'ready'},{inputLeaseUntil:{$gt:expect.any(Number)}}],
  }));
});
