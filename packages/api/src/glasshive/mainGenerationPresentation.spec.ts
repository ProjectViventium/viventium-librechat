import { createHash } from 'crypto';
import {
  buildMainGenerationPresentation,
  createMainGenerationPresentationVerifier,
  nativeCoordinatorResultVoiceTurnId,
} from './mainGenerationPresentation';
import type { MainGenerationDelivery, MainGenerationMessage } from './mainGenerationPresentation';
import type {
  ScheduleDueAdmission,
  ScheduledConversationBinding,
} from '../scheduling/scheduleDueReceiver';

function nativeFixture() {
  const f = fixture('voice');
  const source = {
    bindingRef: 'native-binding',
    nativeConversationId: 'native-conversation',
    goalId: 'goal-one',
    runId: 'native-run',
    resultRevision: 1,
    resultDigest: 'sha256:' + 'a'.repeat(64),
    sourceTurnId: 'native-turn',
    sourceCallSessionId: 'call-a',
  };
  f.row.originRef = source.bindingRef;
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { nativeCoordinatorResult: source },
    f.message.messageId,
    f.message.text!,
  )!;
  const native = jest.fn(async () => true);
  const active = jest.fn(async () => ({ callSessionId: 'call-a' }));
  return {
    ...f,
    source,
    native,
    active,
    verify: createMainGenerationPresentationVerifier({
      ...f.deps,
      readNativeCoordinatorResult: native,
      readActiveCall: active,
    }),
  };
}

test('Native result v2 uses its genuine source without a fabricated Main job or schedule admission', async () => {
  const f = nativeFixture();
  expect(f.row.mainGenerationPresentation).toMatchObject({
    version: 2,
    nativeCoordinatorResult: { kind: 'native_coordinator_goal', ...f.source },
  });
  expect(f.row.mainGenerationPresentation).not.toHaveProperty('streamId');
  expect(f.row.mainGenerationPresentation).not.toHaveProperty('admissionId');
  expect(await f.verify(f.row)).toBe(true);
  expect(f.deps.readAdmission).not.toHaveBeenCalled();
  expect(f.deps.readBinding).not.toHaveBeenCalled();
  expect(nativeCoordinatorResultVoiceTurnId(f.source, f.message.messageId)).toMatch(
    /^native-result-[a-f0-9]{64}$/,
  );
  expect(nativeCoordinatorResultVoiceTurnId(f.source, f.message.messageId)).toBe(
    nativeCoordinatorResultVoiceTurnId(f.source, f.message.messageId),
  );
});

test.each([
  'ended',
  'moved_call',
  'foreign_owner',
  'foreign_conversation',
  'source_changed',
  'message_changed',
])(
  'Native result audio rejects %s while its linked text remains independently persisted',
  async (change) => {
    const f = nativeFixture();
    if (change === 'ended') f.call.status = 'ended';
    if (change === 'moved_call') f.active.mockResolvedValue({ callSessionId: 'different-call' });
    if (change === 'foreign_owner') f.call.userId = 'foreign';
    if (change === 'foreign_conversation') f.call.conversationId = 'foreign';
    if (change === 'source_changed') f.native.mockResolvedValue(false);
    if (change === 'message_changed') f.message.text = 'Different source text';
    expect(await f.verify(f.row)).toBe(false);
    expect(f.message.messageId).toBe('message-a');
  },
);

test('Native result Telegram uses current owner mapping and source proof independently of an ended Call', async () => {
  const f = nativeFixture();
  f.row.surface = 'telegram';
  f.call.status = 'ended';
  f.active.mockResolvedValue({ callSessionId: 'another-call' });
  expect(await f.verify(f.row)).toBe(true);
  expect(f.active).not.toHaveBeenCalled();
  expect(f.native).toHaveBeenCalledWith(expect.objectContaining({ destination: f.row }));
  f.row.telegramChatId = 'foreign-chat';
  expect(await f.verify(f.row)).toBe(false);
});

function nativeFilesFixture() {
  const f = nativeFixture();
  f.row.surface = 'telegram';
  f.message.text = '';
  f.row.text = '';
  const attachment = {
    user: f.row.userId,
    file_id: 'native-file',
    nativeOutputFile: { version: 1, status: 'available', messageId: f.message.messageId },
  };
  f.message.attachments = [attachment];
  f.row.attachments = JSON.parse(JSON.stringify(f.message.attachments));
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { nativeCoordinatorResult: f.source },
    f.message.messageId,
    '',
  )!;
  return { ...f, attachment };
}

test('Native file-only result uses the exact saved owner attachments and current source proof', async () => {
  const f = nativeFilesFixture();
  expect(await f.verify(f.row)).toBe(true);
  expect(f.native).toHaveBeenCalled();
  f.native.mockResolvedValue(false);
  expect(await f.verify(f.row)).toBe(false);
});

test.each(['absent', 'different', 'owner', 'message', 'status', 'version', 'file', 'voice'])(
  'Native file-only result rejects %s attachment authority',
  async (change) => {
    const f = nativeFilesFixture();
    const attachment = f.attachment;
    if (change === 'absent') f.message.attachments = [];
    if (change === 'different') f.row.attachments = [];
    if (change === 'owner') attachment.user = 'foreign-owner';
    if (change === 'message') attachment.nativeOutputFile.messageId = 'other-message';
    if (change === 'status') attachment.nativeOutputFile.status = 'unavailable';
    if (change === 'version') attachment.nativeOutputFile.version = 2;
    if (change === 'file') attachment.file_id = '';
    if (change === 'voice') f.row.surface = 'voice';
    if (!['absent', 'different', 'voice'].includes(change))
      f.row.attachments = JSON.parse(JSON.stringify(f.message.attachments));
    expect(await f.verify(f.row)).toBe(false);
  },
);

test('Native result Telegram requires no invented Call while Voice still requires the original Call', async () => {
  const f = nativeFixture();
  const source = { ...f.source, sourceCallSessionId: '' };
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { nativeCoordinatorResult: source },
    f.message.messageId,
    f.message.text!,
  );
  f.row.surface = 'telegram';
  expect(await f.verify(f.row)).toBe(true);
  f.row.surface = 'voice';
  expect(await f.verify(f.row)).toBe(false);
});

function fixture(surface: 'telegram' | 'voice' = 'telegram') {
  const binding: ScheduledConversationBinding = {
    _id: 'binding-a',
    kind: 'schedule_binding',
    ownerId: 'owner-a',
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    taskText: 'Original authorized task',
    sourceEventId: 'source-a',
    active: true,
    createdAt: new Date(),
    destinations: [
      { surface: 'librechat' },
      { surface: 'telegram', telegramChatId: 'chat-a', telegramUserId: 'tg-a' },
    ],
  };
  const admission: ScheduleDueAdmission = {
    _id: 'admission-a',
    kind: 'schedule_due',
    userId: 'owner-a',
    idempotencyKey: 'idempotency-a',
    streamId: 'stream-a',
    conversationId: 'conversation-a',
    status: 'accepted',
    dueState: 'delivery_queued',
    eventId: 'event-a',
    requestDigest: 'digest-a',
    bindingRef: 'binding-a',
    resultMessageId: 'message-a',
    admittedAt: new Date(),
    updatedAt: new Date(),
    envelope: {
      type: 'schedule.due',
      schedule_id: 'schedule-a',
      schedule_version: 1,
      occurrence_id: 'occurrence-a',
      scheduled_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      principal: { tenant_id: 'tenant-a', owner_id: 'owner-a' },
      request_data: { request_ref: 'binding-a' },
    },
  };
  const message: MainGenerationMessage = {
    messageId: 'message-a',
    user: 'owner-a',
    conversationId: 'conversation-a',
    isCreatedByUser: false,
    text: 'Actual Main reply. ',
  };
  const presentation = buildMainGenerationPresentation(
    { streamId: admission.streamId, admissionId: admission._id },
    message.messageId,
    message.text!,
  )!;
  const row: MainGenerationDelivery = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    callbackMessageId: 'message-a',
    originRef: 'binding-a',
    event: 'main.followup',
    surface,
    text: message.text!.trim(),
    telegramChatId: 'chat-a',
    telegramUserId: 'tg-a',
    voiceCallSessionId: 'call-a',
    mainGenerationPresentation: presentation,
  };
  const mapping = { telegramChatId: 'chat-a', telegramUserId: 'tg-a' };
  const call = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    status: 'active',
    mode: 'call',
  };
  const deps = {
    readAdmission: jest.fn(async () => admission),
    readBinding: jest.fn(async () => binding),
    readMessage: jest.fn(async () => message),
    readOwner: jest.fn(async () => true),
    readConversation: jest.fn(async (_ownerId: string, _conversationId: string) => ({
      endpoint: 'agents',
    })),
    readTelegram: jest.fn(async () => mapping),
    readCall: jest.fn(async () => call),
  };
  return {
    binding,
    admission,
    message,
    presentation,
    row,
    mapping,
    call,
    deps,
    verify: createMainGenerationPresentationVerifier(deps),
  };
}

test('binds exact canonical Main text and accepted admission without a worker result', async () => {
  const f = fixture();
  expect(f.presentation.responseDigest).toBe(
    'sha256:' + createHash('sha256').update(f.message.text!).digest('hex'),
  );
  expect(await f.verify(f.row, {})).toBe(true);
  expect(f.deps.readMessage).toHaveBeenCalledWith('owner-a', 'conversation-a', 'message-a', {});
});

test.each([
  'owner',
  'conversation',
  'stream',
  'binding',
  'response',
  'status',
  'generation',
  'tenant',
  'binding-conversation',
  'active',
  'canonical-text',
  'user-message',
  'chat',
  'account',
])('rejects changed %s evidence before presentation', async (kind) => {
  const f = fixture();
  if (kind === 'owner') f.admission.userId = 'other-owner';
  if (kind === 'conversation') f.admission.conversationId = 'other-conversation';
  if (kind === 'stream') f.admission.streamId = 'other-stream';
  if (kind === 'binding') f.admission.bindingRef = 'other-binding';
  if (kind === 'response') f.admission.resultMessageId = 'other-message';
  if (kind === 'status') f.admission.status = 'reserved';
  if (kind === 'generation') f.admission.dueState = 'cancelled';
  if (kind === 'tenant') f.binding.tenantId = 'other-tenant';
  if (kind === 'binding-conversation') f.binding.conversationId = 'other-conversation';
  if (kind === 'active') f.binding.active = false;
  if (kind === 'canonical-text') f.message.text = 'Changed canonical reply.';
  if (kind === 'user-message') f.message.isCreatedByUser = true;
  if (kind === 'chat') f.row.telegramChatId = 'other-chat';
  if (kind === 'account') f.mapping.telegramUserId = 'other-account';
  expect(await f.verify(f.row)).toBe(false);
});

test('checks current conversation access and account existence', async () => {
  const f = fixture();
  f.deps.readOwner.mockResolvedValue(false);
  expect(await f.verify(f.row)).toBe(false);
  f.deps.readOwner.mockResolvedValue(true);
  f.deps.readConversation.mockResolvedValue({ endpoint: 'other-endpoint' });
  expect(await f.verify(f.row)).toBe(false);
});

test('eligible live Voice uses the same Main evidence and current owner/conversation', async () => {
  const f = fixture('voice');
  expect(await f.verify(f.row)).toBe(true);
  f.call.mode = 'listen_only';
  expect(await f.verify(f.row)).toBe(false);
  f.call.mode = 'call';
  f.call.status = 'ended';
  expect(await f.verify(f.row)).toBe(false);
  f.call.status = 'active';
  f.call.userId = 'other-owner';
  expect(await f.verify(f.row)).toBe(false);
});

test('new-conversation schedules retain their admitted destination conversation', async () => {
  const f = fixture();
  f.binding.conversationPolicy = 'new';
  f.binding.conversationId = 'original-conversation';
  expect(await f.verify(f.row)).toBe(true);
});

test('canonical file-only Main results can reach selected text channels', async () => {
  const f = fixture();
  f.message.text = '';
  f.message.attachments = [{ filename: 'result.txt' }];
  f.row.text = '';
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { streamId: f.admission.streamId, admissionId: f.admission._id },
    f.message.messageId,
    '',
  );
  expect(await f.verify(f.row)).toBe(true);
  f.message.attachments = [];
  expect(await f.verify(f.row)).toBe(false);
});

test.each(['explicit-source', 'legacy-new-conversation'])(
  'presentation rechecks distinct source access: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'explicit-source') f.binding.sourceConversationId = 'source-conversation';
    else {
      f.binding.conversationPolicy = 'new';
      f.binding.conversationId = 'source-conversation';
    }
    expect(await f.verify(f.row)).toBe(true);
    f.deps.readConversation.mockImplementation(async (_ownerId, conversationId) => ({
      endpoint: conversationId === 'source-conversation' ? 'revoked' : 'agents',
    }));
    expect(await f.verify(f.row)).toBe(false);
    expect(f.deps.readConversation).toHaveBeenCalledWith('owner-a', 'source-conversation');
  },
);

test('persisted web Main presentation requires its selected channel and exact current evidence', async () => {
  const f = fixture();
  f.row.surface = 'librechat';
  expect(await f.verify(f.row)).toBe(true);
  f.binding.destinations = [
    { surface: 'telegram', telegramChatId: 'chat-a', telegramUserId: 'tg-a' },
  ];
  expect(await f.verify(f.row)).toBe(false);
});

test('Telegram direct messages use the existing user-ID fallback when mapping has no chat ID', async () => {
  const f = fixture();
  f.mapping.telegramChatId = '';
  f.row.telegramChatId = 'tg-a';
  f.binding.destinations = [
    { surface: 'telegram', telegramChatId: 'tg-a', telegramUserId: 'tg-a' },
  ];
  expect(await f.verify(f.row)).toBe(true);
  f.row.telegramChatId = 'foreign-dm';
  expect(await f.verify(f.row)).toBe(false);
});

test.each(['wing', 'listen_only'])(
  'Main Voice authority stops when a selected call changes to %s mode',
  async (mode) => {
    const f = fixture('voice');
    expect(await f.verify(f.row)).toBe(true);
    f.call.mode = mode;
    expect(await f.verify(f.row)).toBe(false);
  },
);

describe('distinct Native turn result source', () => {
  const goal = {
    bindingRef: 'binding',
    nativeConversationId: 'native',
    goalId: 'goal',
    runId: 'run',
    resultRevision: 1,
    resultDigest: 'sha256:' + 'a'.repeat(64),
    sourceTurnId: 'source',
    sourceCallSessionId: '',
  };
  const turn = {
    kind: 'native_coordinator_turn' as const,
    bindingRef: 'binding',
    nativeConversationId: 'native',
    turnId: 'turn',
    requestId: 'request',
    runId: 'run',
    resultRevision: 1,
    resultDigest: goal.resultDigest,
    sourceTurnId: 'source',
    sourceCallSessionId: '',
  };
  test('preserves legacy goal authority bytes and Voice identity exactly', () => {
    expect(
      JSON.stringify(
        buildMainGenerationPresentation(
          { nativeCoordinatorResult: goal },
          'message',
          'Native reply.',
        ),
      ),
    ).toBe(
      '{"version":2,"nativeCoordinatorResult":{"bindingRef":"binding","nativeConversationId":"native","goalId":"goal","runId":"run","resultRevision":1,"resultDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceTurnId":"source","sourceCallSessionId":"","kind":"native_coordinator_goal"},"responseMessageId":"message","responseDigest":"sha256:d622399f41a0d48539b51a710529b67b09de3efbf8a3d1e83c1a70b82a661809"}',
    );
    expect(nativeCoordinatorResultVoiceTurnId(goal, 'message')).toBe(
      'native-result-b6694a91700d976ad01882df973cbfdcfaea5b2518aabbaa17e46aefc2fc6d70',
    );
  });
  test('retains a distinct turn/request source without a goal', () => {
    const built = buildMainGenerationPresentation(
      { nativeCoordinatorResult: turn },
      'message',
      'Native reply.',
    )!;
    expect(built).toMatchObject({ version: 2, nativeCoordinatorResult: turn });
    expect(built).not.toHaveProperty('nativeCoordinatorResult.goalId');
    expect(nativeCoordinatorResultVoiceTurnId(turn, 'message')).toMatch(
      /^native-turn-result-[a-f0-9]{64}$/,
    );
    expect(nativeCoordinatorResultVoiceTurnId(turn, 'message')).not.toBe(
      nativeCoordinatorResultVoiceTurnId({ ...turn, requestId: 'other-request' }, 'message'),
    );
  });
  test.each([
    { ...turn, goalId: 'fake-goal' },
    { ...goal, kind: 'native_coordinator_turn' },
    { ...goal, kind: 'native_coordinator_goal', turnId: 'cross-kind' },
    { ...turn, requestId: '' },
    { ...turn, kind: 'unknown' },
  ])('rejects cross-kind or incomplete sources', (value) => {
    const { nativeCoordinatorResultSource } = jest.requireActual('./mainGenerationPresentation');
    expect(nativeCoordinatorResultSource(value)).toBeNull();
  });
  test('uses the same live Call and current Main guards for a turn source', async () => {
    const f = nativeFixture();
    f.row.mainGenerationPresentation = buildMainGenerationPresentation(
      {
        nativeCoordinatorResult: {
          ...turn,
          bindingRef: f.source.bindingRef,
          sourceCallSessionId: f.source.sourceCallSessionId,
        },
      },
      f.message.messageId,
      f.message.text!,
    );
    expect(await f.verify(f.row)).toBe(true);
    f.call.status = 'ended';
    expect(await f.verify(f.row)).toBe(false);
  });
});

function progressFixture() {
  const f = fixture('voice');
  const source = {
    kind: 'native_coordinator_progress' as const,
    bindingRef: 'native-binding',
    nativeConversationId: 'native-conversation',
    goalId: 'goal',
    runId: 'run',
    attemptId: 'attempt',
    progressId: 'c'.repeat(64),
    progressDigest: 'sha256:' + 'd'.repeat(64),
    sourceTurnId: 'source-turn',
    sourceCallSessionId: 'call-a',
  };
  f.row.originRef = source.bindingRef;
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { nativeCoordinatorProgress: source },
    f.message.messageId,
    f.message.text!,
  );
  const progress = jest.fn(
    async ({ source: current }) => current.progressDigest === source.progressDigest,
  );
  const terminal = jest.fn(async () => true);
  const active = jest.fn(async () => ({ callSessionId: 'call-a' }));
  const deps = {
    ...f.deps,
    readNativeCoordinatorProgress: progress,
    readNativeCoordinatorResult: terminal,
    readActiveCall: active,
  };
  return {
    ...f,
    source,
    progress,
    terminal,
    active,
    progressDeps: deps,
    verify: createMainGenerationPresentationVerifier(deps),
  };
}

test('progress bridge builds strict version 3 goal or turn evidence without invented terminal or schedule authority', () => {
  const f = progressFixture();
  expect(f.row.mainGenerationPresentation).toEqual({
    version: 3,
    nativeCoordinatorProgress: f.source,
    responseMessageId: f.message.messageId,
    responseDigest: 'sha256:' + createHash('sha256').update(f.message.text!).digest('hex'),
  });
  const { goalId: _goalId, ...common } = f.source;
  const turn = { ...common, turnId: 'turn', requestId: 'request' };
  expect(
    buildMainGenerationPresentation({ nativeCoordinatorProgress: turn }, 'message', 'Progress.'),
  ).toMatchObject({ version: 3, nativeCoordinatorProgress: turn });
  const { mainGenerationPresentation } = jest.requireActual('./mainGenerationPresentation');
  for (const change of [
    { resultRevision: 1 },
    { resultDigest: 'sha256:' + 'e'.repeat(64) },
    { outputFiles: [] },
    { turnId: 'mixed-turn' },
    { kind: 'native_coordinator_goal' },
    { attemptId: '' },
    { sourceTurnId: '' },
    { progressId: 'bad-id' },
    { progressDigest: 'bad-digest' },
  ])
    expect(
      mainGenerationPresentation({
        ...f.row,
        mainGenerationPresentation: {
          ...f.row.mainGenerationPresentation,
          nativeCoordinatorProgress: { ...f.source, ...change },
        },
      }),
    ).toBeNull();
  for (const mixed of [
    { nativeCoordinatorResult: {} },
    { streamId: 'fake-job' },
    { admissionId: 'fake-admission' },
  ])
    expect(
      mainGenerationPresentation({
        ...f.row,
        mainGenerationPresentation: {
          ...f.row.mainGenerationPresentation,
          ...mixed,
        },
      }),
    ).toBeNull();
});

test('progress bridge requires exact owner, saved message, source proof and selected Telegram destination', async () => {
  const f = progressFixture();
  f.row.surface = 'telegram';
  const session = {};
  expect(await f.verify(f.row, session)).toBe(true);
  expect(f.progress).toHaveBeenCalledWith({
    source: f.source,
    ownerId: f.row.userId,
    conversationId: f.row.conversationId,
    message: f.message,
    destination: f.row,
    session,
  });
  expect(f.terminal).not.toHaveBeenCalled();
  expect(f.deps.readAdmission).not.toHaveBeenCalled();
  expect(f.deps.readBinding).not.toHaveBeenCalled();
  for (const change of [
    'owner',
    'conversation',
    'binding',
    'message',
    'text',
    'chat',
    'account',
    'source',
  ]) {
    const current = progressFixture();
    current.row.surface = 'telegram';
    if (change === 'owner') current.deps.readOwner.mockResolvedValue(false);
    if (change === 'conversation')
      current.deps.readConversation.mockResolvedValue({ endpoint: 'other' });
    if (change === 'binding') current.row.originRef = 'foreign-binding';
    if (change === 'message') current.message.isCreatedByUser = true;
    if (change === 'text') current.message.text = 'Changed canonical text.';
    if (change === 'chat') current.row.telegramChatId = 'foreign-chat';
    if (change === 'account') current.mapping.telegramUserId = 'foreign-account';
    if (change === 'source' && current.row.mainGenerationPresentation?.version === 3)
      current.row.mainGenerationPresentation.nativeCoordinatorProgress.progressDigest =
        'sha256:' + 'e'.repeat(64);
    expect(await current.verify(current.row)).toBe(false);
  }
  expect(
    await createMainGenerationPresentationVerifier({
      ...f.progressDeps,
      readNativeCoordinatorProgress: undefined,
    })(f.row),
  ).toBe(false);
});

test('progress bridge uses current original Call authority while Telegram progress survives an ended Call', async () => {
  for (const change of ['ended', 'moved', 'mode', 'owner', 'conversation']) {
    const f = progressFixture();
    expect(await f.verify(f.row)).toBe(true);
    if (change === 'ended') f.call.status = 'ended';
    if (change === 'moved') f.active.mockResolvedValue({ callSessionId: 'other-call' });
    if (change === 'mode') f.call.mode = 'listen_only';
    if (change === 'owner') f.call.userId = 'other-owner';
    if (change === 'conversation') f.call.conversationId = 'other-conversation';
    expect(await f.verify(f.row)).toBe(false);
  }
  const f = progressFixture();
  f.call.status = 'ended';
  f.row.surface = 'telegram';
  expect(await f.verify(f.row)).toBe(true);
  expect(f.active).not.toHaveBeenCalled();
  expect(f.terminal).not.toHaveBeenCalled();
});
