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
