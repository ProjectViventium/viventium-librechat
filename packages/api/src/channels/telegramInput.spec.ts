import {
  createTelegramInputService,
  TELEGRAM_INPUT_LEASE_MS,
  telegramInputDeliveryCoverage,
  telegramInputConversationGeneration,
} from './telegramInput';
import type { DeliveryAcknowledgementResult } from '../stream/interfaces/IJobStore';
import type {
  TelegramInputIdentity,
  TelegramInputRecord,
  TelegramPreparedInput,
} from './telegramInput';

function fixture() {
  let clock = 1_000_000;
  const rows = new Map<string, TelegramInputRecord>();
  const messages = new Map<string, TelegramPreparedInput>();
  const streams = new Map<string, 'missing' | 'pending' | 'completed' | 'failed'>();
  let authorized = true;
  const repository = {
    read: async (identity: Pick<TelegramInputIdentity, 'libreChatUserId' | 'sourceEventId'>) => {
      const row = rows.get(identity.sourceEventId);
      return row?.libreChatUserId === identity.libreChatUserId ? structuredClone(row) : null;
    },
    insert: async (row: TelegramInputRecord) => {
      if (!rows.has(row.sourceEventId)) rows.set(row.sourceEventId, structuredClone(row));
      return structuredClone(rows.get(row.sourceEventId)!);
    },
    replace: async (previous: TelegramInputRecord, next: TelegramInputRecord) => {
      if (JSON.stringify(rows.get(previous.sourceEventId)) !== JSON.stringify(previous))
        return false;
      rows.set(next.sourceEventId, structuredClone(next));
      return true;
    },
    due: async (now: number, limit: number) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.primarySourceEventId === row.sourceEventId &&
            !['completed', 'cancelled'].includes(row.state) &&
            row.leaseUntil <= now &&
            row.retryAt <= now &&
            (row.state !== 'failed' || row.retryAt > 0),
        )
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    group: async (record: TelegramInputRecord) =>
      [...rows.values()]
        .filter(
          (row) =>
            ['preparing', 'failed'].includes(row.state) &&
            row.libreChatUserId === record.libreChatUserId &&
            row.mediaGroupId === record.mediaGroupId &&
            row.conversationGeneration === record.conversationGeneration,
        )
        .map((row) => structuredClone(row)),
  };
  const persistPrepared = jest.fn(
    async (record: TelegramInputIdentity, input: TelegramPreparedInput) => {
      messages.set(record.sourceMessageId, structuredClone(input));
    },
  );
  const deps = {
    repository,
    persistPrepared,
    transaction: async <T>(operation: () => Promise<T>): Promise<T> => {
      const priorRows = structuredClone(rows),
        priorMessages = structuredClone(messages);
      try {
        return await operation();
      } catch (error) {
        rows.clear();
        priorRows.forEach((value, key) => rows.set(key, value));
        messages.clear();
        priorMessages.forEach((value, key) => messages.set(key, value));
        throw error;
      }
    },
    verifyOwner: async (_record?: TelegramInputIdentity) => authorized,
    verifyStream: async () => true,
    hasCommittedDelivery: jest.fn(async (_record: TelegramInputIdentity) => false),
    readPrepared: async (record: TelegramInputIdentity) =>
      messages.get(record.sourceMessageId) || null,
    readStream: async (streamId: string) => streams.get(streamId) || ('missing' as const),
    now: () => clock,
  };
  const service = createTelegramInputService(deps);
  return {
    service,
    deps,
    rows,
    messages,
    streams,
    persistPrepared,
    advance: () => {
      clock += TELEGRAM_INPUT_LEASE_MS + 1;
    },
    revoke: () => {
      authorized = false;
    },
  };
}
const id = (sequence = 1, group = ''): TelegramInputIdentity => ({
  sourceEventId: String(sequence).padStart(64, '0'),
  sourceOrderScope: 'a'.repeat(64),
  sourceSequence: sequence,
  libreChatUserId: 'owner',
  telegramUserId: 'sender',
  telegramChatId: 'chat',
  telegramMessageThreadId: '',
  conversationId: 'conversation',
  requestedConversationId: 'new',
  conversationGeneration: 'b'.repeat(64),
  sourceMessageId: `input-${sequence}`,
  mediaGroupId: group,
});
const registration = '11111111-1111-4111-8111-111111111111';
const input: TelegramPreparedInput = {
  text: 'Original voice goal',
  fileIds: ['owned-document'],
  imageUrls: [],
};
const claim = (row: TelegramInputRecord) => ({
  sourceEventId: row.sourceEventId,
  claimToken: row.claimToken,
});

test('restart settles the exact covered original after its stream expired, without another generation', async () => {
  const f = fixture();
  const row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  await f.service.bindStream('owner', claim(row), 'old-stream');
  f.advance();
  f.deps.hasCommittedDelivery.mockResolvedValue(true);
  const recovered = createTelegramInputService(f.deps);
  expect(await recovered.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)?.state).toBe('completed');
  expect(f.deps.hasCommittedDelivery).toHaveBeenCalledWith(expect.objectContaining(id()));
  expect(await recovered.claimPending()).toEqual([]);
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
});
test('receipt storage failure preserves the accepted input for recovery without replaying preparation', async () => {
  const f = fixture();
  const row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  await f.service.bindStream('owner', claim(row), 'old-stream');
  f.advance();
  f.deps.hasCommittedDelivery.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(f.service.claimPending()).rejects.toThrow('storage unavailable');
  expect(f.rows.get(row.sourceEventId)?.state).toBe('admitted');
  f.deps.hasCommittedDelivery.mockResolvedValue(true);
  expect(await f.service.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)?.state).toBe('completed');
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
});
test('a ready source covered by the newer response settles without admitting its own superseded request', async () => {
  const f = fixture();
  const row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  f.advance();
  f.deps.hasCommittedDelivery.mockResolvedValue(true);
  expect(await f.service.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)).toMatchObject({ state: 'completed', streamId: '' });
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
});

function committedCoverage(): DeliveryAcknowledgementResult {
  const original = id();
  return {
    status: 'recorded',
    acknowledgement: { state: 'committed', logical_turn_id: 'turn', revision: 2 },
    presentation: {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conversation',
        logical_turn_id: 'turn',
        revision: 2,
        source_event_id: id(2).sourceEventId,
        source_order_scope: original.sourceOrderScope,
        source_conversation_generation: telegramInputConversationGeneration(original),
        source_segments: [
          {
            ordinal: 0,
            source_index: 0,
            source_event_id: original.sourceEventId,
            source_message_id: original.sourceMessageId,
            source_sequence: original.sourceSequence,
            source_persisted: true,
            text: 'Private original goal',
            source_files: [{ file_id: 'private-file' }],
          },
        ],
      },
    },
  };
}
test('a committed Main receipt retains exact source references without text or attachment data', () => {
  const result = committedCoverage();
  expect(telegramInputDeliveryCoverage(result)).toEqual({
    logical_turn_id: 'turn',
    revision: 2,
    source_order_scope: id().sourceOrderScope,
    source_conversation_generation: telegramInputConversationGeneration(id()),
    sources: [
      {
        source_event_id: id().sourceEventId,
        source_message_id: id().sourceMessageId,
        source_sequence: 1,
        owned: true,
      },
    ],
  });
  expect(
    telegramInputConversationGeneration({ ...id(), conversationGeneration: 'c'.repeat(64) }),
  ).not.toBe(telegramInputConversationGeneration(id()));
});
/* VIVENTIUM: a receipt records which covered sources its revision authored. */
test('a committed receipt marks the sources its revision authored', () => {
  const result = committedCoverage();
  const [original] = result.presentation!.interactionContext!.source_segments!;
  const later = id(2);
  result.presentation!.interactionContext!.source_segments = [
    { ...original, authoring_revision: 1 },
    {
      ...original,
      ordinal: 1,
      source_event_id: later.sourceEventId,
      source_message_id: later.sourceMessageId,
      source_sequence: later.sourceSequence,
      authoring_revision: 2,
    },
  ];
  expect(
    telegramInputDeliveryCoverage(result)?.sources.map(({ source_event_id, owned }) => [
      source_event_id,
      owned,
    ]),
  ).toEqual([
    [original.source_event_id, false],
    [later.sourceEventId, true],
  ]);
});
test('partial, stale, wrong-conversation, internal, unpersisted and non-Main receipts attest no source completion', () => {
  const original = committedCoverage();
  const invalid = [
    { ...original, status: 'stale_revision' },
    { ...original, transportOnly: true },
    { ...original, acknowledgement: { ...original.acknowledgement!, state: 'committed_effect' } },
    { ...original, acknowledgement: { ...original.acknowledgement!, revision: 1 } },
    { ...original, acknowledgement: { ...original.acknowledgement!, source_kind: 'callback' } },
    ...[
      { conversation_id: 'other' },
      { origin: 'callback' },
      { actor_kind: 'system' },
      {
        source_segments: [
          {
            ...original.presentation!.interactionContext!.source_segments![0],
            source_persisted: undefined,
          },
        ],
      },
    ].map((context) => ({
      ...original,
      presentation: {
        ...original.presentation!,
        interactionContext: { ...original.presentation!.interactionContext!, ...context },
      },
    })),
  ] as DeliveryAcknowledgementResult[];
  invalid.forEach((result) => expect(telegramInputDeliveryCoverage(result)).toBeNull());
});

test('a repeated observation retains one input and distinguishes a second preparation owner', async () => {
  const f = fixture(),
    first = await f.service.register(id(), registration);
  const second = await f.service.register(id(), '22222222-2222-4222-8222-222222222222');
  expect(second.registrationId).toBe(registration);
  expect(f.rows.size).toBe(1);
  expect(f.messages.size).toBe(0);
  expect(second).toEqual(first);
});
test('failed prepared storage leaves the source recoverable without an accepted empty result', async () => {
  const f = fixture(),
    original = await f.service.register(id(), registration);
  f.persistPrepared.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(f.service.ready('owner', claim(original), input)).rejects.toThrow(
    'storage unavailable',
  );
  expect(f.rows.get(original.sourceEventId)?.state).toBe('preparing');
  expect(f.messages.size).toBe(0);
  const ready = await f.service.ready('owner', claim(original), input);
  expect(ready.state).toBe('ready');
  expect(f.messages.get('input-1')).toEqual(input);
});
test('restart recovery retains original goal/files, rotates only the lease, and reuses the accepted stream', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  f.advance();
  const restarted = createTelegramInputService(f.deps),
    [ready] = await restarted.claimPending();
  expect(ready).toMatchObject({
    sourceSequence: 1,
    sourceMessageId: 'input-1',
    state: 'ready',
  });
  expect(ready.claimToken).not.toBe(row.claimToken);
  await expect(restarted.status('owner', claim(row), 'renew')).rejects.toMatchObject({
    code: 'source_input_claim_conflict',
  });
  await restarted.bindStream('owner', claim(ready), 'retained-stream');
  f.streams.set('retained-stream', 'pending');
  f.advance();
  const [admitted] = await restarted.claimPending();
  expect(admitted).toMatchObject({
    state: 'admitted',
    streamId: 'retained-stream',
  });
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
  await restarted.status('owner', claim(admitted), 'renew');
  f.streams.set('retained-stream', 'completed');
  f.advance();
  expect(await restarted.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)?.state).toBe('completed');
});
test('wrong owner and changed account mapping cannot acquire or modify original input', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await expect(f.service.ready('other', claim(row), input)).rejects.toMatchObject({
    statusCode: 409,
  });
  f.revoke();
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  await expect(f.service.status('owner', claim(row), 'renew')).rejects.toMatchObject({
    statusCode: 409,
  });
});
test('explicit reset cancellation retains the original source and forbids new readiness', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await f.service.status('owner', claim(row), 'cancelled');
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  await expect(f.service.ready('owner', claim(row), input)).rejects.toMatchObject({
    code: 'source_input_claim_expired',
  });
  expect(f.rows.get(row.sourceEventId)?.conversationGeneration).toBe(id().conversationGeneration);
});
test('a disappeared accepted response is a truthful failure and never reruns its model/effects', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  await f.service.bindStream('owner', claim(row), 'accepted');
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)).toMatchObject({
    state: 'failed',
    failureCode: 'accepted_response_unavailable',
    retryAt: 0,
  });
});
test('a retained unprepared album is claimed together even when the dispatcher asks for one group', async () => {
  const f = fixture();
  await f.service.register(id(1, 'album'), registration);
  await f.service.register(id(2, 'album'), registration);
  f.advance();
  const members = await f.service.claimPending(1);
  expect(members.map((row) => row.sourceSequence)).toEqual([1, 2]);
  expect(await f.service.claimPending()).toEqual([]);
});
test('prepared album members share one primary stream and never replay as individual inputs', async () => {
  const f = fixture(),
    a = await f.service.register(id(1, 'album'), registration),
    b = await f.service.register(id(2, 'album'), registration);
  await f.service.ready('owner', claim(b), input, [claim(a), claim(b)]);
  expect(f.rows.get(a.sourceEventId)?.primarySourceEventId).toBe(b.sourceEventId);
  await f.service.bindStream('owner', claim(b), 'album-stream');
  expect(f.rows.get(a.sourceEventId)?.streamId).toBe('album-stream');
  f.streams.set('album-stream', 'pending');
  f.advance();
  const pending = await f.service.claimPending();
  expect(pending).toHaveLength(1);
  expect(pending[0].sourceEventId).toBe(b.sourceEventId);
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
  f.streams.set('album-stream', 'completed');
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  expect(f.rows.get(a.sourceEventId)?.state).toBe('completed');
  expect(f.rows.get(b.sourceEventId)?.state).toBe('completed');
  expect((await f.service.status('owner', claim(pending[0]), 'renew')).state).toBe('completed');
});
test('unrelated files or a newer reset generation cannot be merged into an album claim', async () => {
  const f = fixture(),
    a = await f.service.register(id(1, 'album'), registration),
    b = await f.service.register(id(2, 'other'), registration);
  await expect(f.service.ready('owner', claim(b), input, [claim(a)])).rejects.toMatchObject({
    code: 'source_input_group_conflict',
  });
  expect(f.persistPrepared).not.toHaveBeenCalled();
  expect(f.rows.get(a.sourceEventId)?.state).toBe('preparing');
});

test('malformed claims and empty preparation cannot create an accepted input', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await expect(f.service.read('owner', null as never)).rejects.toMatchObject({
    code: 'source_input_claim_conflict',
  });
  await expect(
    f.service.ready('owner', claim(row), {
      text: ' ',
      fileIds: [],
      imageUrls: [],
    }),
  ).rejects.toMatchObject({ code: 'source_input_preparation_empty' });
  expect(f.persistPrepared).not.toHaveBeenCalled();
  expect(f.rows.get(row.sourceEventId)?.state).toBe('preparing');
});
test('a concurrent insert cannot replace authenticated input identity', async () => {
  const f = fixture();
  f.deps.repository.insert = async (row) => ({
    ...row,
    conversationGeneration: 'c'.repeat(64),
  });
  const service = createTelegramInputService(f.deps);
  await expect(service.register(id(), registration)).rejects.toMatchObject({
    code: 'source_input_identity_conflict',
  });
});
test('an explicit preparation failure is terminal unless its owner declares retryability', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await f.service.status('owner', claim(row), 'failed', 'transcription_unavailable');
  f.advance();
  expect(await f.service.claimPending()).toEqual([]);
  expect(f.rows.get(row.sourceEventId)).toMatchObject({
    state: 'failed',
    retryAt: 0,
    failures: [{ code: 'transcription_unavailable', at: expect.any(Number) }],
  });
});
test('retryable preparation failures retain an album as one recoverable group', async () => {
  const f = fixture(),
    a = await f.service.register(id(1, 'album'), registration),
    b = await f.service.register(id(2, 'album'), registration);
  await f.service.status('owner', claim(a), 'failed', 'transcription_unavailable', true);
  await f.service.status('owner', claim(b), 'failed', 'download_unavailable', true);
  f.advance();
  const claimed = await f.service.claimPending(1);
  expect(claimed.map((row) => row.sourceSequence)).toEqual([1, 2]);
  expect(
    claimed.every(
      (row) => row.state === 'preparing' && row.attempts === 1 && row.failures.length === 1,
    ),
  ).toBe(true);
});

test('ready input yields its preparation lease promptly and a trailing heartbeat cannot delay recovery', async () => {
  const f = fixture(),
    row = await f.service.register(id(), registration);
  await f.service.ready('owner', claim(row), input);
  const waiting = await f.service.defer('owner', claim(row));
  expect(waiting.leaseUntil).toBe(0);
  expect(waiting.retryAt).toBeLessThan(1_000_000 + TELEGRAM_INPUT_LEASE_MS);
  expect((await f.service.status('owner', claim(row), 'renew')).leaseUntil).toBe(0);
  expect(await f.service.claimPending()).toEqual([]);
  f.advance();
  const [next] = await f.service.claimPending();
  expect(next).toMatchObject({
    state: 'ready',
    sourceMessageId: row.sourceMessageId,
    sourceSequence: 1,
  });
  expect(next.claimToken).not.toBe(row.claimToken);
});

/* VIVENTIUM: permanent preparation failure belongs to the whole verified upload group. */
async function registerAlbum(f: ReturnType<typeof fixture>, count = 8) {
  const members: TelegramInputRecord[] = [];
  for (let sequence = 1; sequence <= count; sequence++)
    members.push(await f.service.register(id(sequence, 'album'), registration));
  return members;
}

test('permanent pre-ready upload failure terminalizes all eight original group claims exactly once', async () => {
  const f = fixture();
  const members = await registerAlbum(f);
  const primary = members[7];
  await f.service.status(
    'owner',
    claim(primary),
    'failed',
    'unsupported_file_type',
    false,
    members.map(claim),
  );
  for (const original of members) {
    expect(f.rows.get(original.sourceEventId)).toMatchObject({
      ...id(original.sourceSequence, 'album'),
      state: 'failed',
      streamId: '',
      preparedDigest: '',
      failureCode: 'unsupported_file_type',
      retryAt: 0,
      leaseUntil: 0,
      failures: [{ code: 'unsupported_file_type', at: expect.any(Number) }],
    });
  }
  await f.service.status(
    'owner',
    claim(primary),
    'failed',
    'unsupported_file_type',
    false,
    members.map(claim),
  );
  expect([...f.rows.values()].every((row) => row.failures.length === 1)).toBe(true);
  f.advance();
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.messages.size).toBe(0);
});

test('restart reconciles an old permanent failed group and releases independent committed settlement', async () => {
  const f = fixture();
  const members = await registerAlbum(f);
  await f.service.status('owner', claim(members[7]), 'failed', 'unsupported_file_type');
  const later = await f.service.register(id(9), registration);
  await f.service.ready('owner', claim(later), input);
  await f.service.bindStream('owner', claim(later), 'accepted-later');
  f.streams.set('accepted-later', 'completed');
  f.advance();
  const restarted = createTelegramInputService(f.deps);
  expect(await restarted.claimPending(1)).toEqual([]);
  expect(members.every((row) => f.rows.get(row.sourceEventId)?.state === 'failed')).toBe(true);
  expect(f.rows.get(later.sourceEventId)?.state).toBe('admitted');
  expect(await restarted.claimPending(1)).toEqual([]);
  expect(f.rows.get(later.sourceEventId)?.state).toBe('completed');
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
});

test.each([
  'libreChatUserId',
  'telegramUserId',
  'telegramChatId',
  'telegramMessageThreadId',
  'conversationId',
  'conversationGeneration',
  'sourceOrderScope',
  'mediaGroupId',
] as const)('group failure refuses a different %s before any member is changed', async (field) => {
  const f = fixture();
  const a = await f.service.register(id(1, 'album'), registration);
  const foreignIdentity = {
    ...id(2, 'album'),
    [field]:
      field === 'conversationGeneration' || field === 'sourceOrderScope' ? 'c'.repeat(64) : 'other',
  };
  const b = await f.service.register(foreignIdentity, registration);
  await expect(
    f.service.status('owner', claim(a), 'failed', 'unsupported_file_type', false, [
      claim(a),
      claim(b),
    ]),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect([...f.rows.values()].every((row) => row.state === 'preparing')).toBe(true);
});

test('group failure rejects an expired or rotated source claim without partial settlement', async () => {
  const f = fixture();
  const [a, b] = await registerAlbum(f, 2);
  f.advance();
  await expect(
    f.service.status('owner', claim(b), 'failed', 'unsupported_file_type', false, [
      claim(a),
      claim(b),
    ]),
  ).rejects.toMatchObject({ code: 'source_input_claim_expired' });
  const recovered = await f.service.claimPending(1);
  await expect(
    f.service.status('owner', claim(recovered[1]), 'failed', 'unsupported_file_type', false, [
      claim(a),
      claim(recovered[1]),
    ]),
  ).rejects.toMatchObject({ code: 'source_input_claim_conflict' });
  expect([...f.rows.values()].every((row) => row.state === 'preparing')).toBe(true);
});

test('a late member cannot prepare a fragment of a permanently failed group and recovery retains its source', async () => {
  const f = fixture();
  const [a] = await registerAlbum(f, 1);
  await f.service.status('owner', claim(a), 'failed', 'unsupported_file_type');
  const late = await f.service.register(id(2, 'album'), registration);
  await expect(f.service.ready('owner', claim(late), input)).rejects.toMatchObject({
    code: 'source_input_group_failed',
  });
  expect(f.persistPrepared).not.toHaveBeenCalled();
  f.advance();
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.rows.get(late.sourceEventId)).toMatchObject({
    ...id(2, 'album'),
    state: 'failed',
    failureCode: 'unsupported_file_type',
    streamId: '',
  });
});

test('terminal group reconciliation protects a separately admitted or prepared source and never replays it', async () => {
  const f = fixture();
  const [a, b, c] = await registerAlbum(f, 3);
  await f.service.ready('owner', claim(a), input);
  await f.service.bindStream('owner', claim(a), 'accepted');
  await f.service.ready('owner', claim(b), input);
  const failure = await f.service.register(id(4, 'album'), registration);
  await f.service.status('owner', claim(failure), 'failed', 'unsupported_file_type');
  f.streams.set('accepted', 'pending');
  f.advance();
  await f.service.claimPending();
  expect(f.rows.get(a.sourceEventId)).toMatchObject({ state: 'admitted', streamId: 'accepted' });
  expect(f.rows.get(b.sourceEventId)?.state).toBe('ready');
  expect(f.rows.get(c.sourceEventId)).toMatchObject({ state: 'failed', streamId: '' });
  expect(f.persistPrepared).toHaveBeenCalledTimes(2);
});

test('permanent group status cannot revoke a source that already became ready or admitted', async () => {
  const f = fixture();
  const [a, b] = await registerAlbum(f, 2);
  await f.service.ready('owner', claim(a), input);
  await f.service.bindStream('owner', claim(a), 'accepted');
  await expect(
    f.service.status('owner', claim(b), 'failed', 'unsupported_file_type', false, [
      claim(a),
      claim(b),
    ]),
  ).rejects.toMatchObject({ code: 'source_input_already_admitted' });
  expect(f.rows.get(a.sourceEventId)).toMatchObject({ state: 'admitted', streamId: 'accepted' });
  expect(f.rows.get(b.sourceEventId)?.state).toBe('preparing');
});

test('a raced group source change rolls back all permanent failure updates', async () => {
  const f = fixture();
  const [a, b] = await registerAlbum(f, 2);
  const replace = f.deps.repository.replace;
  f.deps.repository.replace = async (prior, next) =>
    prior.sourceEventId === b.sourceEventId ? false : replace(prior, next);
  await expect(
    f.service.status('owner', claim(a), 'failed', 'unsupported_file_type', false, [
      claim(a),
      claim(b),
    ]),
  ).rejects.toMatchObject({ code: 'source_input_claim_conflict' });
  expect(
    [...f.rows.values()].every((row) => row.state === 'preparing' && !row.failures.length),
  ).toBe(true);
});

test('recovery verifies every terminal group member owner before updating any source', async () => {
  const f = fixture();
  const [a, b] = await registerAlbum(f, 2);
  await f.service.status('owner', claim(b), 'failed', 'unsupported_file_type');
  f.deps.verifyOwner = async (record) => record?.sourceEventId !== b.sourceEventId;
  f.advance();
  await expect(f.service.claimPending(1)).rejects.toMatchObject({
    code: 'source_input_owner_changed',
  });
  expect(f.rows.get(a.sourceEventId)?.state).toBe('preparing');
  expect(f.rows.get(b.sourceEventId)?.state).toBe('failed');
});

test('a transient eight-member group retries as one group instead of becoming a permanent failure', async () => {
  const f = fixture();
  const members = await registerAlbum(f);
  for (const member of members)
    await f.service.status('owner', claim(member), 'failed', 'download_unavailable', true);
  f.advance();
  const recovered = await f.service.claimPending(1);
  expect(recovered).toHaveLength(8);
  expect(recovered.every((row) => row.state === 'preparing' && row.attempts === 1)).toBe(true);
  expect(await f.service.claimPending(1)).toEqual([]);
});

test('exhausted pre-admission retries settle the group and no longer block a later accepted input', async () => {
  const f = fixture();
  const [a, b] = await registerAlbum(f, 2);
  await f.service.status('owner', claim(b), 'failed', 'download_unavailable', true);
  const failed = f.rows.get(b.sourceEventId)!;
  f.rows.set(b.sourceEventId, { ...failed, attempts: 3 });
  const later = await f.service.register(id(3), registration);
  await f.service.ready('owner', claim(later), input);
  await f.service.bindStream('owner', claim(later), 'accepted-later');
  f.streams.set('accepted-later', 'completed');
  f.advance();
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.rows.get(a.sourceEventId)?.state).toBe('failed');
  expect(f.rows.get(b.sourceEventId)).toMatchObject({ state: 'failed', retryAt: 0 });
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.rows.get(later.sourceEventId)?.state).toBe('completed');
});

test('simultaneous permanent failure retries retain one terminal history event per source', async () => {
  const f = fixture();
  const members = await registerAlbum(f, 2);
  const nativeTransaction = f.deps.transaction;
  let held = Promise.resolve();
  f.deps.transaction = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = held;
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await nativeTransaction(operation);
    } finally {
      release();
    }
  };
  await Promise.all(
    members.map((member) =>
      f.service.status(
        'owner',
        claim(member),
        'failed',
        'unsupported_file_type',
        false,
        members.map(claim),
      ),
    ),
  );
  expect(
    [...f.rows.values()].every((row) => row.state === 'failed' && row.failures.length === 1),
  ).toBe(true);
  expect(f.persistPrepared).not.toHaveBeenCalled();
});

test('recovery cannot use a permanent failure from a different conversation or source scope', async () => {
  const f = fixture();
  const a = await f.service.register(id(1, 'album'), registration);
  const b = await f.service.register(
    { ...id(2, 'album'), sourceOrderScope: 'c'.repeat(64) },
    registration,
  );
  await f.service.status('owner', claim(b), 'failed', 'unsupported_file_type');
  f.advance();
  await expect(f.service.claimPending(1)).rejects.toMatchObject({
    code: 'source_input_group_conflict',
  });
  expect(f.rows.get(a.sourceEventId)?.state).toBe('preparing');
});

test('a refused group settles only its verified primary and never recovers it after lease expiry', async () => {
  const f = fixture();
  const [primary, sibling] = await registerAlbum(f, 2);
  const other = await f.service.register(id(3, 'other-group'), registration);
  await f.service.ready('owner', claim(other), input);
  await f.service.bindStream('owner', claim(other), 'other-accepted');
  f.streams.set('other-accepted', 'completed');
  const otherBefore = structuredClone(f.rows.get(other.sourceEventId));

  await expect(
    f.service.ready('owner', claim(primary), input, [claim(other)]),
  ).rejects.toMatchObject({ code: 'source_input_group_conflict' });
  await f.service.status('owner', claim(primary), 'failed', 'source_input_group_conflict', false, [
    claim(primary),
  ]);

  expect(f.rows.get(primary.sourceEventId)).toMatchObject({
    state: 'failed',
    failureCode: 'source_input_group_conflict',
    retryAt: 0,
    streamId: '',
  });
  expect(f.rows.get(sibling.sourceEventId)?.state).toBe('preparing');
  expect(f.rows.get(other.sourceEventId)).toEqual(otherBefore);
  f.advance();
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.rows.get(sibling.sourceEventId)).toMatchObject({
    state: 'failed',
    failureCode: 'source_input_group_conflict',
    streamId: '',
  });
  expect(await f.service.claimPending(1)).toEqual([]);
  expect(f.rows.get(other.sourceEventId)?.state).toBe('completed');
  expect(f.persistPrepared).toHaveBeenCalledTimes(1);
});

test.each([
  ['owner', 'source_input_claim_conflict'],
  ['claim', 'source_input_claim_conflict'],
  ['lease', 'source_input_claim_expired'],
  ['prepared', 'source_input_already_admitted'],
])(
  'primary-only group failure preserves the exact %s guard without mutations',
  async (guard, expectedCode) => {
    const f = fixture();
    const [primary, sibling] = await registerAlbum(f, 2);
    let ownerId = 'owner';
    let ownedClaim = claim(primary);
    if (guard === 'owner') ownerId = 'other-owner';
    if (guard === 'claim') ownedClaim = { ...ownedClaim, claimToken: registration };
    if (guard === 'lease') f.advance();
    if (guard === 'prepared') await f.service.ready('owner', claim(primary), input);
    const before = JSON.stringify([...f.rows]);

    await expect(
      f.service.status(ownerId, ownedClaim, 'failed', 'source_input_group_conflict', false, [
        ownedClaim,
      ]),
    ).rejects.toMatchObject({ code: expectedCode });

    expect(JSON.stringify([...f.rows])).toBe(before);
    expect(f.rows.get(sibling.sourceEventId)?.state).toBe('preparing');
  },
);
