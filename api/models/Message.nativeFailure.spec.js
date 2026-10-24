/* === VIVENTIUM START === Terminal host failures use the Native response owner. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
let mockManager;

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: {
      getJobStore: () => mockManager.getJobStore(),
      revokeNativeResponse: (...args) => mockManager.revokeNativeResponse(...args),
      retireNativeResponse: (...args) => mockManager.retireNativeResponse(...args),
      failRevokedNativeResponse: (...args) => mockManager.failRevokedNativeResponse(...args),
    },
  };
});
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  ...jest.requireActual('@librechat/data-schemas').createNativeResponseMethods(require('mongoose')),
}));
jest.mock('~/server/services/Config/app');
jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  ...jest.requireActual('~/server/services/viventium/conversationRecallService'),
  scheduleConversationRecallSync: jest.fn(),
}));

const { Message } = require('~/db/models');
const db = require('~/models');
const { saveMessage, updateMessage } = require('./Message');
const user = 'synthetic-failure-owner';
const conversationId = '00000000-0000-4000-8000-000000000025';
const transaction = (operation) => mongoose.connection.transaction(operation);
const failure = {
  type: 'error',
  error_class: 'source_context_unavailable',
  error: 'The conversation context could not be preserved. Please retry this turn.',
};
let server;
let store;
let transport;
let identity;
let req;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  await Message.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Message.deleteMany({});
  const { InMemoryJobStore, InMemoryEventTransport, GenerationJobManagerClass } =
    jest.requireActual('@librechat/api');
  store = new InMemoryJobStore();
  transport = new InMemoryEventTransport();
  mockManager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: transport,
  });
  mockManager.initialize();
  await Message.create([
    { user, conversationId, messageId: 'parent', isCreatedByUser: false, text: '' },
    {
      user,
      conversationId,
      messageId: 'question',
      parentMessageId: 'parent',
      isCreatedByUser: true,
      text: 'Inspect the current state.',
    },
    {
      user,
      conversationId,
      messageId: 'answer',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: true,
      error: false,
      text: 'Working.',
      content: [{ type: 'text', text: 'Working.' }],
    },
  ]);
  const claim = await store.claimLogicalTurn('stream', user, {
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'telegram',
    conversation_id: conversationId,
    revision: 1,
    source_event_id: 'question',
  });
  const job = await store.createJob('stream', user, conversationId, {
    responseMessageId: 'answer',
    interactionContext: claim.interactionContext,
    userMessage: { messageId: 'question' },
  });
  const parent = await Message.findOne({ user, messageId: 'parent' }).lean();
  const { nativeResponseParentSource } = jest.requireActual('@librechat/data-schemas');
  const admittedAt = Date.now();
  identity = {
    userId: user,
    conversationId,
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: job.createdAt,
    logicalTurnId: claim.interactionContext.logical_turn_id,
    revision: 1,
    invocationId: 'invocation',
    bodySha256: 'b'.repeat(64),
    providerId: 'provider',
    agentId: 'agent',
    originSha256: 'c'.repeat(64),
    source: await db.captureNativeResponseSource(
      user,
      conversationId,
      'question',
      nativeResponseParentSource(parent),
    ),
    admittedAt,
    recoverUntil: admittedAt + 86_400_000,
  };
  await mockManager.bindNativeResponse(identity);
  await db.admitNativeResponse(identity, transaction);
  req = { user: { id: user }, body: {}, _viventiumNativeResponseIdentity: identity };
});
afterEach(async () => {
  await mockManager.destroy();
});
const read = () => Message.findOne({ user, messageId: 'answer' }).select('+nativeResponse').lean();
const saveFailure = () =>
  saveMessage(
    req,
    {
      messageId: 'answer',
      conversationId,
      parentMessageId: 'question',
      isCreatedByUser: false,
      text: 'Working.',
      content: [{ type: 'text', text: 'Working.' }, failure],
      error: true,
      unfinished: false,
    },
    { operationKind: 'system' },
  );
const prepare = () =>
  db.prepareNativeResponse(
    identity,
    {
      text: 'Canonical answer.',
      authoritySha256: 'a'.repeat(64),
      requestId: 'request',
      runId: 'run',
      responseJson: '{"saved":true}',
    },
    transaction,
  );

function rejectTerminalWriteOnce() {
  const original = db.materializeNativeResponseTerminal;
  const error = new Error('Synthetic exhausted Mongo finalization');
  const spy = jest
    .spyOn(db, 'materializeNativeResponseTerminal')
    .mockImplementationOnce((bound, status, authorize, run, project, errorClass, terminalError) =>
      original(
        bound,
        status,
        authorize,
        (operation) =>
          run(async () => {
            await operation();
            throw error;
          }),
        project,
        errorClass,
        terminalError,
      ),
    );
  return { error, restore: () => spy.mockRestore() };
}

async function recordExhaustedFailure() {
  const fault = rejectTerminalWriteOnce();
  try {
    await expect(saveFailure()).rejects.toBe(fault.error);
  } finally {
    fault.restore();
  }
  expect(await read()).toMatchObject({
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending' },
  });
  expect(
    await mockManager.failRevokedNativeResponse(identity, failure.error, failure.error_class),
  ).toBe(true);
}

test.each(['pending', 'prepared'])(
  'actual error snapshot settles the exact %s Native response',
  async (state) => {
    if (state === 'prepared') await prepare();
    await saveFailure();
    expect(await read()).toMatchObject({
      unfinished: false,
      error: true,
      finish_reason: 'incomplete',
      nativeResponse: { status: 'failed', terminalSnapshotStoredAt: expect.any(Number) },
    });
    expect((await read()).content).toContainEqual(failure);
    expect(await store.getNativeResponseCommit(identity)).toEqual({ status: 'revoked' });
  },
);

test('changed authored parent may fail truthfully without accepting its stale successful answer', async () => {
  await Message.updateOne(
    { user, messageId: 'parent' },
    { $set: { text: 'The scheduler finished.' } },
  );
  await expect(prepare()).rejects.toMatchObject({ code: 'native_response_parent_changed' });
  await saveFailure();
  expect(await read()).toMatchObject({
    error: true,
    unfinished: false,
    nativeResponse: { status: 'failed' },
  });
  expect((await read()).content).toContainEqual(failure);
});

test('late Cortex augmentation cannot reopen or replace a failed response', async () => {
  await saveFailure();
  await updateMessage(
    req,
    {
      messageId: 'answer',
      text: 'Late replacement.',
      error: false,
      unfinished: true,
      content: [
        { type: 'text', text: 'Late replacement.' },
        {
          type: 'cortex_insight',
          cortex_id: 'background',
          status: 'complete',
          insight: 'A useful finding.',
        },
      ],
    },
    { operationKind: 'system' },
  );
  expect(await read()).toMatchObject({
    text: 'Working.',
    error: true,
    unfinished: false,
    nativeResponse: { status: 'failed' },
  });
  expect((await read()).content).toContainEqual(failure);
  expect((await read()).content.some((part) => part.cortex_id === 'background')).toBe(true);
});

test('a Mongo retry retains this exact failure authorization', async () => {
  const original = db.materializeNativeResponseTerminal;
  const retry = new Error('Synthetic transaction retry');
  const spy = jest
    .spyOn(db, 'materializeNativeResponseTerminal')
    .mockImplementationOnce((bound, status, authorize, run, project, errorClass, terminalError) =>
      original(
        bound,
        status,
        authorize,
        async (operation) => {
          try {
            await run(async () => {
              await operation();
              throw retry;
            });
          } catch (error) {
            if (error !== retry) throw error;
          }
          return run(operation);
        },
        project,
        errorClass,
        terminalError,
      ),
    );
  try {
    await require('~/server/services/viventium/nativeResponseService').persistNativeResponseFailure(
      identity,
      { error: true, unfinished: false, content: [failure] },
    );
    expect(await read()).toMatchObject({
      error: true,
      unfinished: false,
      nativeResponse: { status: 'failed' },
    });
  } finally {
    spy.mockRestore();
  }
});

test('terminal failure recovery reads its saved outcome without provider or task replay', async () => {
  await saveFailure();
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('No provider call allowed'));
  try {
    const recovered =
      await require('~/server/services/viventium/nativeResponseService').recoverSavedNativeResponse(
        identity,
      );
    expect(recovered).toMatchObject({ messageId: 'answer', error: true, unfinished: false });
    expect(recovered.content).toContainEqual(failure);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test('actual controller snapshot closes its revoked Native error stream with the same typed cause', async () => {
  const { persistAssistantSnapshot, finishFailedNativeResponse } =
    require('~/server/controllers/agents/request').__testables;
  const errors = jest.spyOn(transport, 'emitError');
  const receipt = await persistAssistantSnapshot({
    req,
    streamId: 'stream',
    userId: user,
    conversationId,
    client: { sender: 'AI', options: { endpoint: 'agents' } },
    aggregatedContent: [{ type: 'text', text: 'Working.' }, failure],
    userMessage: { messageId: 'question', conversationId, text: 'Inspect the current state.' },
    responseMessageId: 'answer',
    unfinished: false,
    error: true,
  });
  expect(receipt.nativeFailureSettled).toBe(true);
  await mockManager.emitError('stream', failure.error, failure.error_class);
  expect(errors).not.toHaveBeenCalled();
  expect(
    await finishFailedNativeResponse(req, 'stream', failure, receipt.nativeFailureSettled),
  ).toBe(true);
  expect(errors).toHaveBeenCalledWith('stream', failure.error, failure.error_class);
  expect(await store.getJob('stream')).toMatchObject({
    status: 'error',
    errorClass: failure.error_class,
  });
  expect(await finishFailedNativeResponse(req, 'other-stream', failure, true)).toBe(false);
});

test('exhausted terminal Mongo write still closes only this request own revoked stream', async () => {
  const { persistAssistantSnapshot, finishFailedNativeResponse } =
    require('~/server/controllers/agents/request').__testables;
  const errors = jest.spyOn(transport, 'emitError');
  const fault = rejectTerminalWriteOnce();
  try {
    await expect(
      persistAssistantSnapshot({
        req,
        streamId: 'stream',
        userId: user,
        conversationId,
        client: { sender: 'AI', options: { endpoint: 'agents' } },
        aggregatedContent: [{ type: 'text', text: 'Working.' }, failure],
        userMessage: { messageId: 'question', conversationId, text: 'Inspect the current state.' },
        responseMessageId: 'answer',
        unfinished: false,
        error: true,
      }),
    ).rejects.toBe(fault.error);
  } finally {
    fault.restore();
  }
  expect(await read()).toMatchObject({
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending' },
  });
  expect(await finishFailedNativeResponse(req, 'stream', failure, false, fault.error)).toBe(true);
  expect(errors).toHaveBeenCalledWith('stream', failure.error, failure.error_class);
  expect(await store.getJob('stream')).toMatchObject({
    status: 'error',
    errorClass: failure.error_class,
  });
});

test('recorded failure recovery settles Mongo later without provider or goal replay', async () => {
  await recordExhaustedFailure();
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('No provider call allowed'));
  try {
    expect(
      await require('~/server/services/viventium/nativeResponseService').recoverNativeResponse(
        identity,
      ),
    ).toBe(false);
    expect(await read()).toMatchObject({
      error: true,
      unfinished: false,
      nativeResponse: { status: 'failed', terminalSnapshotStoredAt: expect.any(Number) },
    });
    expect((await read()).content).toContainEqual(failure);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test('own revoke proof cannot replace a subsequently confirmed Stop', async () => {
  const fault = rejectTerminalWriteOnce();
  try {
    await expect(saveFailure()).rejects.toBe(fault.error);
  } finally {
    fault.restore();
  }
  const stopped = await db.settleNativeResponse(identity, 'cancelled', {
    text: 'Stopped partial.',
    content: [{ type: 'text', text: 'Stopped partial.' }],
  });
  expect(
    await mockManager.finishNativeResponse(
      identity,
      { final: true, responseMessage: stopped },
      'cancelled',
    ),
  ).toBe(true);
  const before = await read();
  expect(
    await require('~/server/controllers/agents/request').__testables.finishFailedNativeResponse(
      req,
      'stream',
      failure,
      false,
      fault.error,
    ),
  ).toBe(false);
  expect((await read()).nativeResponse).toEqual(before.nativeResponse);
  expect(await read()).toMatchObject({ text: 'Stopped partial.', error: false, unfinished: true });
});

test('recorded failure settles its history after a successor without publishing into that successor', async () => {
  await recordExhaustedFailure();
  const claim = await store.claimLogicalTurn('successor', user, {
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'telegram',
    conversation_id: conversationId,
    revision: 1,
    source_event_id: 'next-input',
  });
  await store.createJob('successor', user, conversationId, {
    responseMessageId: 'successor-answer',
    interactionContext: claim.interactionContext,
    userMessage: { messageId: 'next-input' },
  });
  const done = jest.spyOn(transport, 'emitDone');
  expect(
    await require('~/server/services/viventium/nativeResponseService').recoverNativeResponse(
      identity,
    ),
  ).toBe(false);
  expect(await read()).toMatchObject({
    error: true,
    unfinished: false,
    nativeResponse: { status: 'failed' },
  });
  expect(await store.getJob('successor')).toMatchObject({
    status: 'running',
    responseMessageId: 'successor-answer',
  });
  expect(done).not.toHaveBeenCalled();
});

test('recorded failure receipt cannot authorize a different failure payload', async () => {
  await recordExhaustedFailure();
  const saved =
    await require('~/server/services/viventium/nativeResponseService').persistNativeResponseFailure(
      identity,
      {
        error: true,
        unfinished: false,
        content: [{ ...failure, error_class: 'provider_auth_missing' }],
      },
    );
  expect(saved).toBeNull();
  expect(await read()).toMatchObject({
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending' },
  });
});

test('ordinary partial and successful host snapshots cannot finalize Native ownership', async () => {
  await saveMessage(
    req,
    {
      messageId: 'answer',
      conversationId,
      isCreatedByUser: false,
      text: 'A partial.',
      unfinished: true,
      error: false,
    },
    { operationKind: 'system' },
  );
  await saveMessage(
    req,
    {
      messageId: 'answer',
      conversationId,
      isCreatedByUser: false,
      text: 'An uncommitted final.',
      unfinished: false,
      error: false,
    },
    { operationKind: 'system' },
  );
  expect(await read()).toMatchObject({
    text: 'A partial.',
    unfinished: true,
    error: false,
    nativeResponse: { status: 'pending' },
  });
});

test('a confirmed Stop snapshot keeps its own terminal partial', async () => {
  await mockManager.revokeNativeResponse(identity);
  await db.settleNativeResponse(identity, 'cancelled', {
    text: 'The stopped partial.',
    content: [{ type: 'text', text: 'The stopped partial.' }],
  });
  const before = await read();
  await saveFailure();
  const after = await read();
  expect(after.nativeResponse).toEqual(before.nativeResponse);
  expect(after).toMatchObject({ text: 'The stopped partial.', error: false, unfinished: true });
});

test('an already-revoked publication cannot be claimed by a late failure snapshot', async () => {
  await mockManager.revokeNativeResponse(identity);
  const before = await read();
  await saveFailure();
  const after = await read();
  expect(after.nativeResponse).toEqual(before.nativeResponse);
  expect(after).toMatchObject({
    text: before.text,
    error: before.error,
    unfinished: before.unfinished,
  });
});

test('a committed candidate before Mongo materialization cannot become a failure', async () => {
  const digest = await prepare();
  expect(await mockManager.commitNativeResponse(identity, digest)).toEqual({
    status: 'committed',
    candidateSha256: digest,
  });
  await saveFailure();
  expect(await read()).toMatchObject({
    unfinished: true,
    error: false,
    nativeResponse: { status: 'prepared' },
  });
  expect(await store.getNativeResponseCommit(identity)).toEqual({
    status: 'committed',
    candidateSha256: digest,
  });
});

test('a completed Native answer cannot become a failure', async () => {
  const digest = await prepare();
  await db.materializeNativeResponse(
    identity,
    digest,
    (bound, value) => mockManager.commitNativeResponse(bound, value),
    transaction,
  );
  await saveFailure();
  expect(await read()).toMatchObject({
    text: 'Canonical answer.',
    error: false,
    unfinished: false,
    nativeResponse: { status: 'completed' },
  });
});

test('an explicit source edit keeps the response cancelled', async () => {
  await updateMessage(req, { messageId: 'question', text: 'An edited source.' });
  await saveFailure();
  expect(await read()).toMatchObject({
    unfinished: false,
    nativeResponse: { status: 'cancelled' },
  });
  expect((await read()).content).not.toContainEqual(failure);
});

test('a removed canonical response cannot be recreated by the error owner', async () => {
  await Message.deleteOne({ user, messageId: 'answer' });
  await expect(saveFailure()).rejects.toMatchObject({ code: 'native_response_message_deleted' });
  expect(await read()).toBeNull();
});

test('a stale request identity cannot finalize the current response', async () => {
  req._viventiumNativeResponseIdentity = { ...identity, invocationId: 'stale' };
  await saveFailure();
  expect(await read()).toMatchObject({
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending', invocationId: 'invocation' },
  });
});

test('a different request owner cannot use a copied identity to fail another owner response', async () => {
  req.user.id = 'foreign-owner';
  await expect(saveFailure()).rejects.toMatchObject({ code: 'native_response_message_deleted' });
  expect(await read()).toMatchObject({
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending' },
  });
  expect(await store.getNativeResponseCommit(identity)).toEqual({ status: 'unavailable' });
});

test('a different conversation cannot use a copied identity to fail this response', async () => {
  await saveMessage(
    req,
    {
      messageId: 'answer',
      conversationId: '00000000-0000-4000-8000-000000000026',
      isCreatedByUser: false,
      text: 'Wrong conversation.',
      content: [failure],
      error: true,
      unfinished: false,
    },
    { operationKind: 'system' },
  );
  expect(await read()).toMatchObject({
    conversationId,
    error: false,
    unfinished: true,
    nativeResponse: { status: 'pending' },
  });
});

test.each([
  ['native_response_parent_changed', 'source_context_unavailable'],
  ['provider_auth_missing', 'provider_auth_missing'],
  ['provider_unauthorized', 'provider_unauthorized'],
  ['provider_rate_limited', 'provider_rate_limited'],
  [undefined, 'completion_error'],
])('typed failure %s preserves its public class %s', (code, expected) => {
  const error = Object.assign(new Error('native_response_parent_changed'), code ? { code } : {});
  const part = require('~/server/controllers/agents/client').createCompletionErrorContentPart(
    error,
  );
  expect(part.error_class).toBe(expected);
  if (expected === 'source_context_unavailable') expect(part.error).toBe(failure.error);
});
/* === VIVENTIUM END === */
