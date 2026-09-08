/* === VIVENTIUM START === Actual authored history snapshot and native source admission. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  createModels,
  createNativeResponseMethods,
  nativeResponseParentSource,
  mainContinuityMessageEvidence,
} = require('@librechat/data-schemas');
const { formatMessage } = require('@librechat/agents');
const {
  normalizeTextPartsInPayload,
} = require('~/server/services/viventium/normalizeTextContentParts');
jest.mock('~/models', () => ({
  getMessages: (filter) => require('mongoose').models.Message.find(filter).lean(),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/models/balanceMethods', () => ({ checkBalance: jest.fn() }));
const BaseClient = require('../BaseClient');
let server, methods;
const user = new mongoose.Types.ObjectId().toString();
const filter = { user, conversationId: 'conversation', messageId: 'prior' };
beforeAll(async () => {
  process.env.MEILI_HOST = '';
  process.env.MEILI_MASTER_KEY = '';
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  createModels(mongoose);
  await mongoose.models.Message.init();
  methods = createNativeResponseMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.models.Message.deleteMany({});
  await mongoose.models.Message.create([
    {
      user,
      conversationId: 'conversation',
      messageId: 'original',
      sender: 'User',
      text: 'Start.',
      isCreatedByUser: true,
    },
    {
      ...filter,
      parentMessageId: 'original',
      sender: 'AI',
      text: 'Old cached text.',
      content: [{ type: 'text', text: 'Authored partial.' }],
      unfinished: true,
      isCreatedByUser: false,
    },
  ]);
});
function client() {
  const instance = new BaseClient('synthetic');
  instance.options = { resendFiles: false };
  instance.getSaveOptions = () => ({});
  instance.processOverideIds = () => [];
  return instance;
}
test('onStart binds the loaded authored parent, never a newer DB row after a content-only edit', async () => {
  const instance = client(),
    original = await mongoose.models.Message.findOne(filter).lean();
  instance.addPreviousAttachments = async (messages) => {
    await mongoose.models.Message.updateOne(filter, {
      $set: { 'content.0.text': 'Edited after history loaded.' },
    });
    return messages;
  };
  let source;
  await instance.handleStartMethods('Continue', {
    user,
    conversationId: 'conversation',
    parentMessageId: 'prior',
    overrideParentMessageId: 'continue',
    responseMessageId: 'answer',
    onStart: async (userMessage) => {
      await mongoose.models.Message.create([
        { ...userMessage, user },
        {
          user,
          conversationId: 'conversation',
          messageId: 'answer',
          parentMessageId: 'continue',
          isCreatedByUser: false,
          unfinished: true,
        },
      ]);
      source = await methods.captureNativeResponseSource(
        user,
        'conversation',
        'continue',
        instance.nativeResponseParentSource ?? null,
      );
    },
  });
  expect(source.parent).toEqual(nativeResponseParentSource(original));
  expect(mainContinuityMessageEvidence(instance.currentMessages.at(-1)).text).toBe(
    'Authored partial.',
  );
  const now = Date.now();
  await expect(
    methods.admitNativeResponse(
      {
        userId: user,
        conversationId: 'conversation',
        responseMessageId: 'answer',
        streamId: 'stream',
        jobCreatedAt: 1,
        logicalTurnId: 'logical',
        revision: 1,
        invocationId: 'invocation',
        bodySha256: 'b'.repeat(64),
        providerId: 'provider',
        agentId: 'agent',
        originSha256: 'c'.repeat(64),
        source,
        admittedAt: now,
        recoverUntil: now + 86_400_000,
      },
      (operation) => mongoose.connection.transaction(operation),
    ),
  ).rejects.toThrow('parent_changed');
});
test('retracted response leaves both authored user segments in loaded native history', async () => {
  const instance = client();
  await mongoose.models.Message.deleteOne(filter);
  let proof;
  await instance.handleStartMethods('Second segment.', {
    user, conversationId: 'conversation', parentMessageId: 'original',
    overrideParentMessageId: 'second-input', responseMessageId: 'answer',
    onStart: async (input) => {
      await mongoose.models.Message.create({ ...input, user });
      proof = await methods.captureNativeResponseSource(user, 'conversation', input.messageId,
        instance.nativeResponseParentSource);
      expect(input).toMatchObject({ parentMessageId: 'original', text: 'Second segment.' });
    },
  });
  expect(instance.currentMessages.map(({ messageId, text }) => ({ messageId, text }))).toEqual([
    { messageId: 'original', text: 'Start.' },
  ]);
  expect(proof.parent).toMatchObject({ messageId: 'original', isCreatedByUser: true });
});

test('file hydration cannot change the frozen authored proof or the selected parent relationship', async () => {
  const instance = client(),
    original = await mongoose.models.Message.findOne(filter).lean();
  instance.addPreviousAttachments = async (messages) => {
    messages.at(-1).content.push({ type: 'text', text: 'Hydrated file context.' });
    return messages;
  };
  await instance.loadHistory('conversation', 'prior');
  expect(instance.nativeResponseParentSource).toEqual(nativeResponseParentSource(original));
  expect(instance.currentMessages).toEqual([]);
  await instance.loadHistory('conversation', 'prior', 'missing');
  expect(instance.nativeResponseParentSource).toBeNull();
});
test.each([
  [{ text: 'Text-only answer.' }, 'Text-only answer.'],
  [
    { text: 'Old cached text.', content: [{ type: 'text', text: 'Edited content.' }] },
    'Edited content.',
  ],
  [{ text: 'Old cached text.', content: [{ type: 'text', text: '' }] }, ''],
  [
    {
      text: 'Old cached text.',
      content: [{ type: 'text', text: { value: 'Structured content.' } }],
    },
    'Structured content.',
  ],
])('shared Main evidence agrees with the actual native formatter for %j', (message, expected) => {
  const formatted = normalizeTextPartsInPayload([
    formatMessage({ message: { sender: 'AI', ...message } }),
  ])[0];
  const visible =
    typeof formatted.content === 'string'
      ? formatted.content
      : formatted.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
  expect(visible).toBe(expected);
  expect(mainContinuityMessageEvidence(message).text).toBe(visible);
});


test('captures the exact direct-parent interruption before hydration changes presentation fields', async () => {
  await mongoose.models.Message.updateOne(filter, {$set: {finish_reason: 'incomplete', content: [{type: 'harness_activity', harness_activity: {event: 'task_started', summary: 'Synthetic activity'}}]}});
  const instance = client();
  instance.addPreviousAttachments = async (messages) => {
    messages.at(-1).finish_reason = 'stop';
    messages.at(-1).unfinished = false;
    return messages;
  };
  await instance.loadHistory('conversation', 'prior');
  expect(JSON.parse(instance.directParentTurnContext)).toEqual({direct_parent_response: {
    messageId: 'prior', parentMessageId: 'original', unfinished: true, finish_reason: 'incomplete',
  }});
  await instance.loadHistory('conversation', 'prior', 'missing');
  expect(instance.directParentTurnContext).toBe('');
});

/* === VIVENTIUM START === Web source files must precede native source capture. === */
test.each(['unchanged', 'file_replaced', 'text_edited'])(
  'normal source attachment persistence keeps admission exact: %s', async (change) => {
    const instance = client();
    const file = { file_id: 'b29b732f-f71a-4a3f-8844-c34a23bb3a8c', filename: 'recording.m4a',
      type: 'audio/x-m4a', bytes: 123, source: 'local', context: 'message_attachment',
      text: 'Storage-only text', _id: 'storage-only-id' };
    instance.options.req = { body: { files: [{ file_id: file.file_id }] } };
    instance.options.attachments = Promise.resolve([file]);
    let source, input;
    await instance.handleStartMethods('Use the attached recording.', {
      user, conversationId: 'conversation', parentMessageId: 'original',
      overrideParentMessageId: 'uploaded-input', responseMessageId: 'uploaded-answer',
      onStart: async (userMessage) => {
        input = userMessage;
        await mongoose.models.Message.create([
          { ...input, user },
          { user, conversationId: 'conversation', messageId: 'uploaded-answer',
            parentMessageId: input.messageId, isCreatedByUser: false, unfinished: true },
        ]);
        source = await methods.captureNativeResponseSource(user, 'conversation', input.messageId,
          instance.nativeResponseParentSource);
      },
    });
    // The normal later save retains the same source files after provider preparation.
    const { buildMessageFiles } = require('@librechat/api');
    input.files = buildMessageFiles(instance.options.req.body.files, [file]);
    await mongoose.models.Message.updateOne({ user, messageId: input.messageId }, {$set: input});
    if (change === 'file_replaced') {
      await mongoose.models.Message.updateOne({ user, messageId: input.messageId },
        {$set: {'files.0.file_id': 'cf5f56f8-b118-4f8d-aedc-3537cfaeb477'}});
    } else if (change === 'text_edited') {
      await mongoose.models.Message.updateOne({ user, messageId: input.messageId },
        {$set: {text: 'A different request.'}});
    }
    const now = Date.now();
    const admission = methods.admitNativeResponse({
      userId: user, conversationId: 'conversation', responseMessageId: 'uploaded-answer',
      streamId: 'upload-stream', jobCreatedAt: now, logicalTurnId: 'upload-turn', revision: 1,
      invocationId: 'upload-invocation', bodySha256: 'b'.repeat(64), providerId: 'provider',
      agentId: 'agent', originSha256: 'c'.repeat(64), source,
      admittedAt: now, recoverUntil: now + 86_400_000,
    }, (operation) => mongoose.connection.transaction(operation));
    if (change === 'unchanged') {
      await expect(admission).resolves.toBeUndefined();
      expect((await methods.getNativeResponse(user, 'uploaded-answer')).nativeResponse)
        .toMatchObject({ invocationId: 'upload-invocation', status: 'pending', source });
      expect(input.files).toEqual([{ file_id: file.file_id, filename: file.filename,
        type: file.type, bytes: file.bytes, source: file.source, context: file.context }]);
    } else {
      await expect(admission).rejects.toThrow('native_response_source_changed');
    }
  },
);
/* === VIVENTIUM END === */
