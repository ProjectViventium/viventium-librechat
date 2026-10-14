import { currentNativeHumanInputSource } from './sourceAuthor';
import {
  createWebInteractionContext,
  bindInteractionSourceSegments,
  bindLogicalTurnContext,
  setTrustedInteractionContext,
  bindOriginalInteractionInputReceipt,
} from '../agents/interactionContext';
import { mergeLogicalTurnInput } from '../stream/implementations/logicalTurnInput';
import { normalizeSourceSegmentsWithOverflow } from '../stream/sourceSegments';
import { nativeQueenInputResponseSchema, nativeWorkInputResponseSchema } from './nativeWorkInput';

const body = {
  conversationId: 'conversation',
  messageId: 'assistant',
  viventiumStreamId: 'stream',
  viventiumLogicalTurnId: 'turn',
  viventiumLogicalTurnRevision: 2,
  viventiumAuthoringSourceEventId: 'source',
  viventiumAuthoringSourceRevision: 2,
};
function originalJob() {
  return {
    streamId: 'stream',
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'assistant',
    status: 'running' as const,
    interactionContext: {
      actor_kind: 'external_user' as const,
      origin: 'interactive' as const,
      surface: 'voice' as const,
      conversation_id: 'conversation',
      logical_turn_id: 'turn',
      revision: 2,
      source_event_id: 'source',
      source_segments: [
        {
          ordinal: 0,
          source_event_id: 'source',
          source_index: 0,
          source_message_id: 'human',
          source_persisted: true as const,
          authoring_revision: 2,
          source_received_at: 2000,
          text: 'Approve this operation once.',
        },
      ],
    },
  };
}
const attest = (job: ReturnType<typeof originalJob>) =>
  currentNativeHumanInputSource({
    userId: 'owner',
    requestBody: body,
    getJob: async () => job,
    getOriginalInputReceipt: async () => ({ sourceEventId: 'source', receivedAt: 2000 }),
  });
test('attests the original current source, never the assistant anchor or generation clock', async () => {
  const job = originalJob();
  const getJob = jest.fn(async () => ({ ...job, createdAt: 999999 }));
  const result = await currentNativeHumanInputSource({
    userId: 'owner',
    requestBody: body,
    getJob,
    getOriginalInputReceipt: async () => ({ sourceEventId: 'source', receivedAt: 2000 }),
  });
  expect(result).toEqual({
    version: 1,
    actorKind: 'external_user',
    origin: 'interactive',
    sourceEventId: 'source',
    sourceIndex: 0,
    sourceMessageId: 'human',
    authoringRevision: 2,
    logicalTurnId: 'turn',
    conversationId: 'conversation',
    receivedAt: 2000,
  });
  expect(getJob).toHaveBeenCalledTimes(1);
});
test.each([
  'system',
  'worker',
  'callback',
  'scheduler',
  'older_revision',
  'different_source',
  'missing_receipt',
  'truncated',
  'unpersisted',
  'ambiguous',
  'overflow',
  'cancelled',
])('rejects %s natural permission source', async (mutation) => {
  const job = originalJob();
  const context = job.interactionContext;
  const source = context.source_segments[0];
  if (['system', 'worker'].includes(mutation)) context.actor_kind = mutation;
  if (['callback', 'scheduler'].includes(mutation)) context.origin = mutation;
  if (mutation === 'older_revision') source.authoring_revision = 1;
  if (mutation === 'different_source') source.source_event_id = 'another';
  if (mutation === 'missing_receipt') delete source.source_received_at;
  if (mutation === 'truncated') source.truncated = true;
  if (mutation === 'unpersisted') delete source.source_persisted;
  if (mutation === 'ambiguous') context.source_segments.push({ ...source, source_index: 1 });
  if (mutation === 'overflow') context.source_segments_overflow_count = 1;
  if (mutation === 'cancelled') job.nativeResponseCancelled = true;
  await expect(attest(job)).rejects.toBeInstanceOf(Error);
});
test('normalization and revision recovery keep first exact receipt and never backfill legacy', () => {
  const original = originalJob().interactionContext;
  const newer = {
    ...original,
    revision: 3,
    source_segments: [{ ...original.source_segments[0], source_received_at: 9999 }],
  };
  expect(mergeLogicalTurnInput([original], newer).source_segments?.[0].source_received_at).toBe(
    2000,
  );
  const legacy = {
    ...original,
    source_segments: original.source_segments.map(({ source_received_at, ...source }) => source),
  };
  expect(
    mergeLogicalTurnInput([legacy], newer).source_segments?.[0].source_received_at,
  ).toBeUndefined();
  expect(
    normalizeSourceSegmentsWithOverflow(original.source_segments).segments[0].source_received_at,
  ).toBe(2000);
});
test('a server receipt can be restored before source bind; legacy restore does not use now', () => {
  const req = {};
  setTrustedInteractionContext(
    req,
    createWebInteractionContext({
      source_event_id: 'source',
      conversation_id: 'conversation',
      received_at: 2000,
    }),
  );
  bindOriginalInteractionInputReceipt(req, undefined);
  expect(
    bindInteractionSourceSegments(req, 'Original input')?.source_segments?.[0].source_received_at,
  ).toBeUndefined();
});
test('Queen union accepts exact current choice and clarification; mixed or caller authority rejects', () => {
  const identity = {
    version: 1,
    requestId: 'request',
    requestFingerprint: 'a'.repeat(64),
    action: 'accept',
  };
  expect(
    nativeQueenInputResponseSchema.parse({ ...identity, content: { optionId: 'native-choice' } })
      .content,
  ).toEqual({ optionId: 'native-choice' });
  expect(
    nativeQueenInputResponseSchema.parse({
      ...identity,
      content: { answers: { 'Which shape?': ['Blue'] } },
    }).content,
  ).toEqual({ answers: { 'Which shape?': ['Blue'] } });
  expect(
    nativeQueenInputResponseSchema.safeParse({
      ...identity,
      content: { optionId: 'x', answers: { 'Which?': ['Blue'] } },
    }).success,
  ).toBe(false);
  expect(
    nativeQueenInputResponseSchema.safeParse({
      ...identity,
      content: { optionId: 'x' },
      nativeHumanInput: { receivedAt: 1 },
    }).success,
  ).toBe(false);
  expect(nativeWorkInputResponseSchema.parse({ ...identity, action: 'decline' }).action).toBe(
    'decline',
  );
});

test.each([
  undefined,
  { sourceEventId: 'other', receivedAt: 2000 },
  { sourceEventId: 'source', receivedAt: 9999 },
])('original source row receipt cannot be replaced by job/admission time (%p)', async (receipt) => {
  await expect(
    currentNativeHumanInputSource({
      userId: 'owner',
      requestBody: body,
      getJob: async () => originalJob(),
      getOriginalInputReceipt: async () => receipt,
    }),
  ).rejects.toMatchObject({ code: 'native_input_human_source_unavailable' });
});
