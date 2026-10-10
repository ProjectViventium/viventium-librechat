import { assertCurrentGlassHiveSourceAuthor } from './sourceAuthor';

type Input = Parameters<typeof assertCurrentGlassHiveSourceAuthor>[0];
type Job = NonNullable<Awaited<ReturnType<Input['getJob']>>>;
const body = {
  conversationId: 'conversation-synthetic',
  messageId: 'answer-synthetic',
  viventiumStreamId: 'stream-synthetic',
  viventiumLogicalTurnId: 'turn-synthetic',
  viventiumLogicalTurnRevision: '2',
  viventiumAuthoringSourceEventId: 'source-synthetic',
  viventiumAuthoringSourceRevision: 2,
};
function job(): Job {
  return {
    streamId: body.viventiumStreamId,
    userId: 'owner-synthetic',
    conversationId: body.conversationId,
    responseMessageId: body.messageId,
    status: 'running',
    interactionContext: {
      conversation_id: body.conversationId,
      logical_turn_id: body.viventiumLogicalTurnId,
      revision: 2,
      source_event_id: body.viventiumAuthoringSourceEventId,
      surface: 'voice',
      actor_kind: 'external_user',
      origin: 'interactive',
    },
  };
}
const check = (retained: Job | null, requestBody = body) =>
  assertCurrentGlassHiveSourceAuthor({
    userId: 'owner-synthetic',
    requestBody,
    getJob: async () => retained,
  });

test('admits the exact live managed Main on each interactive surface', async () => {
  for (const surface of ['voice', 'telegram', 'web', 'workbench'] as const) {
    const retained = job();
    retained.interactionContext!.surface = surface;
    await expect(check(retained)).resolves.toBeUndefined();
  }
});

test.each(['superseded', 'complete', 'error', 'aborted'] as const)(
  'rejects a retained %s Main without granting dispatch',
  async (status) => {
    await expect(check({ ...job(), status })).rejects.toMatchObject({
      code: 'source_authority_superseded',
      retryable: false,
    });
  },
);
test('rejects an exact running Main whose native publication was revoked', async () => {
  await expect(check({ ...job(), nativeResponseCancelled: true })).rejects.toMatchObject({
    code: 'source_authority_superseded',
  });
});

const changedJobs: Array<[string, (retained: Job) => Job]> = [
  ['owner', (retained) => ({ ...retained, userId: 'other-owner' })],
  ['stream', (retained) => ({ ...retained, streamId: 'other-stream' })],
  ['conversation', (retained) => ({ ...retained, conversationId: 'other-conversation' })],
  ['answer', (retained) => ({ ...retained, responseMessageId: 'other-answer' })],
  [
    'turn',
    (retained) => ({
      ...retained,
      interactionContext: { ...retained.interactionContext!, logical_turn_id: 'other-turn' },
    }),
  ],
  [
    'revision',
    (retained) => ({
      ...retained,
      interactionContext: { ...retained.interactionContext!, revision: 3 },
    }),
  ],
  [
    'source',
    (retained) => ({
      ...retained,
      interactionContext: { ...retained.interactionContext!, source_event_id: 'other-source' },
    }),
  ],
  [
    'context conversation',
    (retained) => ({
      ...retained,
      interactionContext: {
        ...retained.interactionContext!,
        conversation_id: 'other-conversation',
      },
    }),
  ],
];
test.each(changedJobs)('rejects a different retained %s binding', async (_name, change) => {
  await expect(check(change(job()))).rejects.toMatchObject({
    code: 'source_authority_binding_mismatch',
  });
});

test('rejects a missing job and a store failure without guessing current ownership', async () => {
  await expect(check(null)).rejects.toMatchObject({ code: 'source_authority_unavailable' });
  await expect(
    assertCurrentGlassHiveSourceAuthor({
      userId: 'owner-synthetic',
      requestBody: body,
      getJob: async () => {
        throw new Error('synthetic store outage');
      },
    }),
  ).rejects.toMatchObject({ code: 'source_authority_unavailable' });
});
test('rejects an incomplete or contradictory managed scope', async () => {
  await expect(
    check(job(), { ...body, viventiumAuthoringSourceRevision: 1 }),
  ).rejects.toMatchObject({ code: 'source_authority_binding_incomplete' });
  await expect(check(job(), { ...body, viventiumStreamId: '' })).rejects.toMatchObject({
    code: 'source_authority_binding_incomplete',
  });
});
test('keeps independent unmanaged worker and scheduler grants outside Main ownership', async () => {
  const getJob = jest.fn();
  await expect(
    assertCurrentGlassHiveSourceAuthor({
      userId: 'owner-synthetic',
      requestBody: {},
      getJob,
    }),
  ).resolves.toBeUndefined();
  expect(getJob).not.toHaveBeenCalled();
});
test('preserves the exact live scheduled or callback Main under its existing grants', async () => {
  for (const origin of ['scheduler', 'callback'] as const) {
    const retained = job();
    retained.interactionContext!.origin = origin;
    retained.interactionContext!.actor_kind = 'system';
    await expect(check(retained)).resolves.toBeUndefined();
  }
});
