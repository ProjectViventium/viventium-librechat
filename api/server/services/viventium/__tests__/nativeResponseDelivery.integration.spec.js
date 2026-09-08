/* === VIVENTIUM START === Saved native result uses the normal typed delivery projection. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels, createNativeResponseMethods } = require('@librechat/data-schemas');

let mockDependencies;
const mockModels = {};
const mockJobs = {
  getJobStore: () => ({ getJob: async () => null }),
  finishNativeResponse: jest.fn(async () => true),
  getJob: jest.fn(async () => null),
  settleNativeResponse: jest.fn(async () => true),
};
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: mockJobs,
    createNativeResponseRecoveryService: (dependencies) => {
      mockDependencies = dependencies;
      return actual.createNativeResponseRecoveryService(dependencies);
    },
  };
});
jest.mock('~/models', () => mockModels);
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (operation) => operation(),
}));

const { createNativeResponseRecoveryService, nativeResponseOrigin } =
  jest.requireActual('@librechat/api');
const {
  getService,
  recoverSavedNativeResponse,
  recoverNativeResponse,
} = require('../nativeResponseService');
const { sanitizeVoiceAssistantMessageForPersistence } = require('../voiceArtifactText');
const modelDisposition = (audio = 'eligible') => ({
  version: 1,
  audio,
  required: true,
  valid: true,
  source: 'model',
});

let server;
let methods;
let projectMessage;
let identity;
const user = new mongoose.Types.ObjectId().toString();
const transaction = (operation) => mongoose.connection.transaction(operation);
const commit = async (_identity, digest) => ({ status: 'committed', candidateSha256: digest });

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  createModels(mongoose);
  await mongoose.models.Message.init();
  methods = createNativeResponseMethods(mongoose);
  Object.assign(mockModels, methods, {
    getMessages: (filter) => mongoose.models.Message.find(filter).lean(),
    getMessage: (filter) => mongoose.models.Message.findOne(filter).lean(),
  });
  getService();
  projectMessage = mockDependencies.projectMessage;
  Object.assign(mockDependencies, {
    transaction,
    commit,
    bind: async () => true,
    revoke: async () => ({ status: 'revoked' }),
    resolveRoute: async () => ({ baseURL: 'http://native.test/v1', headers: {} }),
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.models.Message.deleteMany({});
  await mongoose.models.Message.create([
    {
      messageId: 'question',
      user,
      conversationId: 'conversation',
      isCreatedByUser: true,
      text: 'A question.',
    },
    {
      messageId: 'answer',
      user,
      conversationId: 'conversation',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: true,
      text: 'In progress.',
      attachments: [{ type: 'file', file_id: 'kept' }],
      metadata: { kept: true, viventium: { keepSibling: true } },
    },
  ]);
  identity = {
    userId: user,
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: 1,
    logicalTurnId: 'logical',
    revision: 1,
    // Match the actual host request object: optional keys exist with undefined values.
    sourceOrderScope: undefined,
    sourceSequence: undefined,
    invocationId: 'invocation',
    bodySha256: 'b'.repeat(64),
    providerId: 'native',
    agentId: 'main',
    originSha256: nativeResponseOrigin('http://native.test/v1'),
    source: await methods.captureNativeResponseSource(user, 'conversation', 'question'),
    admittedAt: Date.now(),
    recoverUntil: Date.now() + 86400000,
    deliveryDispositionRequired: true,
    deliveryContext: { surface: 'telegram', authenticated: true, audioRequested: true },
  };
});

describe.each([false, true])(
  'native delivery recovery (prepared before interruption: %s)',
  (prepared) => {
    test.each([
      ['eligible', modelDisposition('eligible'), true, 'Answer.', modelDisposition('eligible')],
      ['skip', modelDisposition('skip'), true, 'Answer.', modelDisposition('skip')],
      [
        'missing',
        undefined,
        true,
        'Answer.',
        { version: 1, audio: 'skip', required: true, valid: false, source: 'required_missing' },
      ],
      [
        'malformed',
        { ...modelDisposition(), audio: 'guess' },
        true,
        'Answer.',
        { version: 1, audio: 'skip', required: true, valid: false, source: 'required_malformed' },
      ],
      [
        'legacy control',
        modelDisposition(),
        true,
        'Answer.\n{SKIP_VOICE}',
        { version: 1, audio: 'skip', required: true, valid: true, source: 'legacy_marker' },
      ],
      ['not eligible', modelDisposition(), false, 'Answer.', undefined],
      [
        'audio opt out',
        modelDisposition(),
        false,
        '<emotion>Answer.</emotion>',
        undefined,
        { surface: 'telegram', authenticated: true, audioRequested: false },
      ],
      [
        'voice',
        undefined,
        false,
        '**Answer.** https://example.test/a',
        undefined,
        { surface: 'voice' },
      ],
      [
        'web',
        undefined,
        false,
        '**Answer.** https://example.test/a',
        undefined,
        { surface: 'web' },
      ],
      [
        'unauthenticated Telegram controls',
        undefined,
        false,
        'Answer.\n{MSG_BREAK}\nMore.',
        undefined,
        { surface: 'telegram', authenticated: false, audioRequested: false },
      ],
      [
        'authenticated Telegram boundaries',
        undefined,
        false,
        'Answer.\n{MSG_BREAK}\nMore.',
        undefined,
        { surface: 'telegram', authenticated: true, audioRequested: false },
      ],
      [
        'quoted marker',
        undefined,
        false,
        'Example:\n```\n{SKIP_VOICE}\n```',
        undefined,
        { surface: 'telegram', authenticated: true, audioRequested: false },
      ],
    ])(
      'preserves %s through the actual host projection and Mongo publication',
      async (
        _label,
        disposition,
        required,
        text,
        expected,
        context = { surface: 'telegram', authenticated: true, audioRequested: true },
      ) => {
        identity.deliveryDispositionRequired = required;
        identity.deliveryContext = context;
        const response = {
          id: 'native-request',
          object: 'chat.completion',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: text,
                ...(disposition
                  ? {
                      provider_specific_fields: {
                        viventium: { delivery_disposition: disposition },
                      },
                    }
                  : {}),
              },
            },
          ],
        };
        const result = {
          version: 1,
          object: 'glasshive.request.result',
          state: 'completed',
          invocation_id: identity.invocationId,
          stream_id: identity.streamId,
          message_id: identity.responseMessageId,
          body_sha256: identity.bodySha256,
          authority_sha256: 'a'.repeat(64),
          agent_id: identity.agentId,
          conversation_id: identity.conversationId,
          request_id: response.id,
          run_id: 'native-run',
          response,
        };
        const fetchResult = jest.fn(
          async () => new Response(JSON.stringify(result), { status: 200 }),
        );
        const recovery = createNativeResponseRecoveryService({
          db: methods,
          transaction,
          commit,
          bind: async () => true,
          revoke: async () => ({ status: 'revoked' }),
          resolveRoute: async () => ({ baseURL: 'http://native.test/v1', headers: {} }),
          fetch: fetchResult,
          projectMessage,
        });
        await recovery.admit(identity);
        if (prepared) {
          await methods.prepareNativeResponse(
            identity,
            {
              text,
              authoritySha256: result.authority_sha256,
              requestId: result.request_id,
              runId: result.run_id,
              responseJson: JSON.stringify(response),
            },
            transaction,
          );
          // A later live/provider object must not replace the accepted private candidate.
          response.choices[0].message.content = 'A later mutable provider response.';
          response.choices[0].message.provider_specific_fields = {
            viventium: {
              delivery_disposition: modelDisposition(
                disposition?.audio === 'eligible' ? 'skip' : 'eligible',
              ),
            },
          };
        }
        await mongoose.models.Message.updateOne(
          { messageId: 'answer' },
          {
            $set: {
              content: [
                { type: 'think', think: 'Synthetic harness activity.' },
                {
                  type: 'harness_activity',
                  harness_activity: {
                    event: 'tool-start',
                    summary: 'Synthetic tool started.',
                    tool: 'synthetic-tool',
                  },
                },
                { type: 'background_cortex', cortex_id: 'synthetic-cortex', status: 'completed' },
              ],
            },
          },
        );
        const answer = await recovery.recover(identity);
        if (answer.content.some((part) => part.type === 'think'))
          throw new Error('Recovered native Mongo projection retained harness think content');
        expect(answer.content).toEqual(
          expect.arrayContaining([
            {
              type: 'harness_activity',
              harness_activity: {
                event: 'reasoning-summary',
                summary: 'Synthetic harness activity.',
              },
            },
            {
              type: 'harness_activity',
              harness_activity: {
                event: 'tool-start',
                summary: 'Synthetic tool started.',
                tool: 'synthetic-tool',
              },
            },
            { type: 'background_cortex', cortex_id: 'synthetic-cortex', status: 'completed' },
          ]),
        );
        expect(answer.text).toBe(
          sanitizeVoiceAssistantMessageForPersistence(
            {
              body: {
                viventiumSurface: context.surface,
                voiceMode: context.surface === 'voice',
                telegramAudioRequested: context.audioRequested,
              },
            },
            { text },
          ).text,
        );
        expect(answer.metadata.viventium.deliveryDisposition).toEqual(expected);
        expect(answer.metadata).toMatchObject({ kept: true, viventium: { keepSibling: true } });
        expect(answer.attachments).toEqual([{ type: 'file', file_id: 'kept' }]);
        expect(answer.nativeResponse).toBeUndefined();
        expect(fetchResult).toHaveBeenCalledTimes(prepared ? 0 : 1);
        const transmitted = await recoverSavedNativeResponse(identity);
        expect(transmitted.text).toBe(
          context.surface === 'telegram' && context.authenticated ? text : answer.text,
        );
        expect(transmitted.metadata).toEqual(answer.metadata);
        expect(transmitted.content).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'think' })]),
        );
        expect(
          (
            await recovery.projectForTransmit(identity, {
              ...transmitted,
              metadata: { viventium: { deliveryDisposition: modelDisposition('eligible') } },
            })
          ).metadata,
        ).toEqual(answer.metadata);
        expect(transmitted.attachments).toEqual(answer.attachments);
        expect(transmitted.nativeResponse).toBeUndefined();
        expect(JSON.stringify(transmitted)).not.toContain('candidateJson');
        expect(await recoverNativeResponse(identity)).toBe(true);
        expect(mockJobs.finishNativeResponse.mock.calls.at(-1)[1].responseMessage).toMatchObject({
          text: transmitted.text,
          content: transmitted.content,
          metadata: answer.metadata,
        });
        const stored = await methods.getNativeResponse(user, 'answer');
        expect(stored.nativeResponse.status).toBe('completed');
        expect(JSON.parse(stored.nativeResponse.candidateJson).text).toBe(text);
        expect(stored.metadata).toEqual(answer.metadata);
        expect((await recovery.recover(identity)).metadata).toEqual(answer.metadata);
        expect(fetchResult).toHaveBeenCalledTimes(prepared ? 0 : 1);
      },
    );
  },
);

test('failed projection leaves no partial public completion; a later explicit edit prevents transmission', async () => {
  const text = 'Answer.\n{SKIP_VOICE}';
  const response = {
    id: 'native-request',
    object: 'chat.completion',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  };
  const candidate = {
    text,
    responseJson: JSON.stringify(response),
    authoritySha256: 'a'.repeat(64),
    requestId: 'native-request',
    runId: 'native-run',
  };
  await methods.admitNativeResponse(identity, transaction);
  const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
  await expect(
    methods.materializeNativeResponse(identity, digest, commit, transaction, () => {
      throw new Error('projection failed');
    }),
  ).rejects.toThrow('projection failed');
  expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
    text: 'In progress.',
    unfinished: true,
    nativeResponse: { status: 'prepared' },
  });
  await methods.materializeNativeResponse(
    identity,
    digest,
    commit,
    transaction,
    (_candidate, message) => projectMessage(identity, response, message, 'persist'),
  );
  const publicRead = await recoverSavedNativeResponse(identity);
  await methods.mutateNativeResponseSources(
    { user, messageId: 'answer' },
    async () =>
      mongoose.models.Message.updateOne({ messageId: 'answer' }, { text: 'Explicit correction.' }),
    async () => ({ status: 'committed', candidateSha256: digest }),
    transaction,
    async () => undefined,
  );
  expect(await getService().projectForTransmit(identity, publicRead)).toBeNull();
  expect(await recoverNativeResponse(identity)).toBe(false);
  expect(mockJobs.finishNativeResponse).not.toHaveBeenCalled();
});
