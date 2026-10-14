import type { SerializableJobData } from '../stream/interfaces/IJobStore';

/* === VIVENTIUM START === Exact managed Main ownership at broker mutation boundaries. === */
export interface GlassHiveSourceAuthorBody {
  conversationId?: string;
  messageId?: string;
  viventiumStreamId?: string;
  viventiumLogicalTurnId?: string;
  viventiumLogicalTurnRevision?: string | number;
  viventiumAuthoringSourceEventId?: string;
  viventiumAuthoringSourceRevision?: string | number;
  viventiumSourceEventId?: string;
}

type SourceAuthorJob = Pick<
  SerializableJobData,
  | 'streamId'
  | 'userId'
  | 'conversationId'
  | 'responseMessageId'
  | 'status'
  | 'interactionContext'
  | 'nativeResponseCancelled'
>;

function authorityError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(code), { code, retryable: false as const });
}

/** A read guard rejects proved stale calls; it does not certify absence of in-flight effects. */
export async function assertCurrentGlassHiveSourceAuthor({
  userId,
  requestBody = {},
  getJob,
}: {
  userId: string;
  requestBody?: GlassHiveSourceAuthorBody;
  getJob(streamId: string): Promise<SourceAuthorJob | null>;
}): Promise<void> {
  const streamId = requestBody.viventiumStreamId;
  const turnId = requestBody.viventiumLogicalTurnId;
  const revision = Number(requestBody.viventiumLogicalTurnRevision);
  if (!streamId && !turnId && requestBody.viventiumLogicalTurnRevision == null) return;
  if (
    !userId ||
    !streamId ||
    !turnId ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !requestBody.conversationId ||
    !requestBody.messageId ||
    !requestBody.viventiumAuthoringSourceEventId ||
    Number(requestBody.viventiumAuthoringSourceRevision) !== revision
  ) {
    throw authorityError('source_authority_binding_incomplete');
  }
  let job: SourceAuthorJob | null;
  try {
    job = await getJob(streamId);
  } catch {
    throw authorityError('source_authority_unavailable');
  }
  if (!job) throw authorityError('source_authority_unavailable');
  const context = job.interactionContext;
  if (
    job.streamId !== streamId ||
    job.userId !== userId ||
    job.conversationId !== requestBody.conversationId ||
    job.responseMessageId !== requestBody.messageId ||
    context?.conversation_id !== requestBody.conversationId ||
    context?.logical_turn_id !== turnId ||
    context?.revision !== revision ||
    context?.source_event_id !== requestBody.viventiumAuthoringSourceEventId
  ) {
    throw authorityError('source_authority_binding_mismatch');
  }
  if (job.status !== 'running' || job.nativeResponseCancelled === true) {
    throw authorityError('source_authority_superseded');
  }
}
/* === VIVENTIUM END === */

/** Attest the original current human source; native owns offered-option and chronology checks. */
export async function currentNativeHumanInputSource(
  options: Parameters<typeof assertCurrentGlassHiveSourceAuthor>[0] & {
    getOriginalInputReceipt?: (input: {
      userId: string;
      conversationId: string;
      sourceMessageId: string;
    }) => Promise<unknown>;
  },
) {
  let job: SourceAuthorJob | null | undefined;
  await assertCurrentGlassHiveSourceAuthor({
    ...options,
    getJob: async (streamId) => {
      job = await options.getJob(streamId);
      return job;
    },
  });
  const context = job?.interactionContext;
  const denied = () => authorityError('native_input_human_source_unavailable');
  if (
    !context ||
    context.actor_kind !== 'external_user' ||
    context.origin !== 'interactive' ||
    !context.logical_turn_id ||
    context.source_segments_overflow_count
  )
    throw denied();
  const sources = (context.source_segments || []).filter(
    (segment) =>
      segment.source_event_id === context.source_event_id &&
      segment.authoring_revision === context.revision,
  );
  if (sources.length !== 1) throw denied();
  const source = sources[0];
  if (
    source.truncated ||
    source.source_persisted !== true ||
    !source.source_message_id ||
    !source.text.trim() ||
    !Number.isSafeInteger(source.source_received_at) ||
    Number(source.source_received_at) <= 0 ||
    !options.getOriginalInputReceipt
  )
    throw denied();
  const receipt = await options.getOriginalInputReceipt({
    userId: options.userId,
    conversationId: context.conversation_id,
    sourceMessageId: source.source_message_id,
  });
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    (receipt as { sourceEventId?: unknown }).sourceEventId !== source.source_event_id ||
    (receipt as { receivedAt?: unknown }).receivedAt !== source.source_received_at
  )
    throw denied();
  return {
    version: 1 as const,
    actorKind: 'external_user' as const,
    origin: 'interactive' as const,
    sourceEventId: source.source_event_id,
    sourceIndex: source.source_index,
    sourceMessageId: source.source_message_id,
    authoringRevision: context.revision,
    logicalTurnId: context.logical_turn_id,
    conversationId: context.conversation_id,
    receivedAt: Number(source.source_received_at),
  };
}
