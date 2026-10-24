import { readRetainedNativeMainFinal } from './retainedMainFinal';
import type { NativeResponseAdmission } from '@librechat/data-schemas';

function fixture() {
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    logicalTurnId: 'turn',
    revision: 1,
    invocationId: 'invocation',
    bodySha256: 'a'.repeat(64),
    jobCreatedAt: 1,
    source: { id: 'source-id', messageId: 'source', digest: 'b'.repeat(64) },
    status: 'completed',
    candidateSha256: 'c'.repeat(64),
  } as NativeResponseAdmission;
  const context = {
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'telegram',
    conversation_id: 'conversation',
    logical_turn_id: 'turn',
    revision: 1,
    source_event_id: 'event',
  } as const;
  const row = {
    user: 'owner',
    conversationId: 'conversation',
    messageId: 'answer',
    parentMessageId: 'source',
    isCreatedByUser: false,
    unfinished: false,
    error: false,
    text: 'A useful answer',
    metadata: { viventium: { interactionContext: context } },
    nativeResponse: identity,
  };
  const source = {
    user: 'owner',
    conversationId: 'conversation',
    messageId: 'source',
    isCreatedByUser: true,
    text: 'Original goal',
  };
  const deps = {
    readCandidates: jest.fn(async () => [row]),
    sourceMatches: jest.fn(async () => true),
    isCurrent: jest.fn(async () => true),
    readCompleted: jest.fn(async () => row),
    readSource: jest.fn(async () => source),
  };
  return {
    row,
    identity,
    deps,
    scope: { userId: 'owner', streamId: 'stream', surface: 'telegram' as const },
  };
}
test('a retained completed native final needs no stream or provider execution', async () => {
  const f = fixture();
  expect(await readRetainedNativeMainFinal(f.scope, f.deps)).toMatchObject({
    responseMessageId: 'answer',
    finalEvent: { responseMessage: { text: 'A useful answer' } },
  });
  expect(f.deps.readCompleted).toHaveBeenCalledWith(f.identity);
});
test.each(['pending', 'prepared', 'cancelled', 'failed'])(
  'never recovers %s as a successful final',
  async (status) => {
    const f = fixture();
    f.identity.status = status as NativeResponseAdmission['status'];
    expect(await readRetainedNativeMainFinal(f.scope, f.deps)).toBeNull();
    expect(f.deps.readCompleted).not.toHaveBeenCalled();
  },
);
test.each(['source', 'author', 'owner', 'revision', 'duplicate'])(
  'refuses changed/ambiguous %s proof',
  async (kind) => {
    const f = fixture();
    if (kind === 'source') f.deps.sourceMatches.mockResolvedValue(false);
    if (kind === 'author') f.deps.isCurrent.mockResolvedValue(false);
    if (kind === 'owner') f.row.user = 'other-owner';
    if (kind === 'revision') f.identity.revision = 2;
    if (kind === 'duplicate') f.deps.readCandidates.mockResolvedValue([f.row, { ...f.row }]);
    expect(await readRetainedNativeMainFinal(f.scope, f.deps)).toBeNull();
  },
);
test('revalidates canonical identity after all saved-result reads', async () => {
  const f = fixture();
  f.deps.readCompleted.mockImplementation(async () => {
    f.deps.readCandidates.mockResolvedValue([]);
    return f.row;
  });
  expect(await readRetainedNativeMainFinal(f.scope, f.deps)).toBeNull();
});

describe('retained final inspection reasons', () => {
  const inspect = require('./retainedMainFinal').inspectRetainedMainFinalState;
  test.each([true, false])(
    'newer durable author=%s distinguishes superseded from unavailable',
    async (newer) => {
      const f = fixture();
      const deps = {
        ...f.deps,
        readFinal: jest.fn(async () => null),
        hasNewerSource: jest.fn(async () => newer),
      };
      expect(await inspect(f.scope, deps)).toMatchObject({
        state: newer ? 'superseded' : 'unavailable',
      });
    },
  );
  test('source mutation cannot supply a supersession receipt', async () => {
    const f = fixture();
    f.deps.sourceMatches.mockResolvedValue(false);
    const newer = jest.fn(async () => true);
    expect(
      await inspect(f.scope, { ...f.deps, readFinal: async () => null, hasNewerSource: newer }),
    ).toEqual({ state: 'unavailable' });
    expect(newer).not.toHaveBeenCalled();
  });
});
