/* === VIVENTIUM START === Internal, durable authority for removed predecessor replies. === */
import { logger } from '@librechat/data-schemas';
import type { SerializableJobData } from '../stream/interfaces/IJobStore';
import type { SourceEffectScope, SourceRecoveryFacts } from './sourceMutation';

export type NativeAcceptedSource = { id: string; sha256: string };
export type NativePredecessor = {
  streamId: string;
  createdAt: number;
  responseMessageId: string;
  invocationId: string;
  /** Exact consecutive Core revisions positively fenced before native admission. */
  unadmittedRevisions?: readonly number[];
};
const verifiedSources = new WeakMap<RequestInit, NativeAcceptedSource[]>();

/** Guard diagnostics contain disposition and identity comparisons, never input or identifiers. */
export function nativeSourceRecoveryUnconfirmed(
  stage: 'author_lookup' | 'native_identity' | 'capture' | 'author_commit' | 'author_relinquish',
  current: SerializableJobData | null | undefined,
  previous: SerializableJobData | null | undefined,
  currentLogicalTurn?: boolean,
  captureIdentity?: { currentCreatedAtMatches: boolean; previousCreatedAtMatches: boolean },
): Error & { code: string } {
  const ref = current?.nativePredecessor;
  const native = previous?.nativeResponse;
  const ack = previous?.deliveryAcknowledgement;
  logger.warn(`[GenerationJobManager] Native source recovery decision ${JSON.stringify({
    stage,
    currentPresent: Boolean(current), previousPresent: Boolean(previous),
    currentStatus: current?.status ?? null, previousStatus: previous?.status ?? null,
    previousCancelled: previous?.nativeResponseCancelled === true,
    previousFinished: previous?.nativeResponseFinished === true,
    previousSettled: previous?.nativeResponseSettled === true,
    previousGenerationCompleted: previous?.generationCompleted === true,
    predecessorPresent: Boolean(ref), nativePresent: Boolean(native),
    previousCreatedAtType: typeof previous?.createdAt, nativeCreatedAtType: typeof native?.jobCreatedAt,
    nativeCreatedAtMatches: Boolean(native && previous && native.jobCreatedAt === previous.createdAt),
    predecessorCreatedAtMatches: Boolean(ref && previous && ref.createdAt === previous.createdAt),
    predecessorStreamMatches: Boolean(ref && previous && ref.streamId === previous.streamId),
    predecessorResponseMatches: Boolean(ref && native && ref.responseMessageId === native.responseMessageId),
    predecessorInvocationMatches: Boolean(ref && native && ref.invocationId === native.invocationId),
    sameOwner: Boolean(current && previous && current.userId === previous.userId),
    sameConversation: Boolean(current && previous && current.conversationId === previous.conversationId),
    sameLogicalTurn: Boolean(current?.interactionContext?.logical_turn_id &&
      current.interactionContext.logical_turn_id === previous?.interactionContext?.logical_turn_id),
    currentRevision: current?.interactionContext?.revision ?? null,
    previousRevision: previous?.interactionContext?.revision ?? null,
    nativeRevision: native?.revision ?? null,
    acknowledgement: ack?.state ?? null,
    acknowledgementTurnMatches: Boolean(ack && native && ack.logical_turn_id === native.logicalTurnId),
    acknowledgementRevisionMatches: Boolean(ack && native && ack.revision === native.revision),
    acceptedSourceCount: previous?.nativeAcceptedSources?.sources.length ?? 0,
    acceptedSourceInvocationMatches: Boolean(native &&
      previous?.nativeAcceptedSources?.invocationId === native.invocationId),
    ...(currentLogicalTurn === undefined ? {} : { currentLogicalTurn }),
    ...captureIdentity,
  })}`);
  return Object.assign(new Error('native_source_recovery_unconfirmed'), {
    code: 'native_source_recovery_unconfirmed',
  });
}
export function retainVerifiedNativeSources(
  init: RequestInit,
  chain: Array<NativeAcceptedSource & { role: string; accepted_source?: boolean }>,
): void {
  verifiedSources.set(
    init,
    chain
      .filter((item) => item.role === 'user' && item.accepted_source === true)
      .map(({ id, sha256 }) => ({ id, sha256 })),
  );
}
export function getVerifiedNativeSources(init?: RequestInit): NativeAcceptedSource[] | undefined {
  return init ? verifiedSources.get(init)?.map((item) => ({ ...item })) : undefined;
}

function nativeRevisionContinuity(current: SerializableJobData, previous: SerializableJobData): boolean {
  const revision = current.interactionContext?.revision;
  const before = previous.nativeResponse?.revision;
  const skipped = current.nativePredecessor?.unadmittedRevisions ?? [];
  return Boolean(revision && before && revision > before && revision - before <= 9 &&
    skipped.length === revision - before - 1 && skipped.every((value, index) => value === before + index + 1));
}

export function nativePredecessorSupersession(
  current: SerializableJobData,
  previous: SerializableJobData | null | undefined,
  sources: NativeAcceptedSource[],
) {
  const ref = current.nativePredecessor;
  const old = previous?.nativeResponse;
  const ack = previous?.deliveryAcknowledgement;
  const turn = current.interactionContext;
  const retained = previous?.nativeAcceptedSources;
  if (
    !ref ||
    !previous ||
    !old ||
    !ack ||
    !turn ||
    !retained ||
    previous.streamId !== ref.streamId ||
    previous.createdAt !== ref.createdAt ||
    previous.responseMessageId !== ref.responseMessageId ||
    old.responseMessageId !== ref.responseMessageId ||
    old.invocationId !== ref.invocationId ||
    retained.invocationId !== ref.invocationId ||
    previous.userId !== current.userId ||
    previous.conversationId !== current.conversationId ||
    previous.status !== 'superseded' ||
    ack.state !== 'partial_removed' ||
    ack.logical_turn_id !== old.logicalTurnId ||
    ack.revision !== old.revision ||
    turn.logical_turn_id !== old.logicalTurnId ||
    !nativeRevisionContinuity(current, previous) ||
    retained.sources.length === 0
  )
    return undefined;
  const currentSources = new Map(sources.map((source) => [source.id, source.sha256]));
  if (retained.sources.some((source) => currentSources.get(source.id) !== source.sha256))
    return undefined;
  return {
    version: 1 as const,
    previous_response_message_id: ref.responseMessageId,
    logical_turn_id: turn.logical_turn_id,
    previous_revision: old.revision,
    revision: turn.revision,
    disposition: 'partial_removed' as const,
    accepted_sources: retained.sources.map((source) => ({ ...source })),
    ...(ref.unadmittedRevisions?.length ? { unadmitted_revisions: [...ref.unadmittedRevisions] } : {}),
  };
}

/** Exact native cancellation and delivery removal return unanswered input on every surface. */
export function nativePredecessorSourceRecovery(
  current: SerializableJobData,
  previous: SerializableJobData | null | undefined,
): previous is SerializableJobData {
  return Boolean(
    current.status === 'running' &&
    previous?.nativeResponseCancelled === true &&
    previous.interactionContext?.source_event_id &&
    previous.interactionContext.logical_turn_id === current.interactionContext?.logical_turn_id &&
    nativeRevisionContinuity(current, previous) &&
    nativePredecessorSupersession(current, previous, previous.nativeAcceptedSources?.sources ?? []),
  );
}

/** A positive persisted cancellation tombstone fences both native bind calls before dispatch. */
export function unboundPredecessorSourceRecovery(current: SerializableJobData, previous: SerializableJobData | null | undefined, unboundCancelled = false): previous is SerializableJobData {
  const turn = current.interactionContext;
  const old = previous?.interactionContext;
  return Boolean(current.status === 'running' &&
    previous?.status === 'superseded' &&
    previous.nativeResponseCancelled === true && unboundCancelled && previous.userId === current.userId &&
    previous.conversationId === current.conversationId && old?.logical_turn_id === turn?.logical_turn_id &&
    old && turn && old.revision < turn.revision && turn.source_segments?.some((source) =>
      source.source_event_id === old.source_event_id && source.authoring_revision === old.revision));
}

/** Fresh Core facts are taken only after the exact cancelled Native family released. */
export async function prepareNativeSourceRecovery(
  current: SerializableJobData,
  previous: SerializableJobData,
  deps: {
    beforeCapture(current: SerializableJobData): Promise<number | void>;
    isUnboundCancelled?(previous: SerializableJobData): Promise<boolean>;
    getJob(streamId: string): Promise<SerializableJobData | null>;
    readFacts(scope: SourceEffectScope): Promise<{ facts: SourceRecoveryFacts; pending: boolean }>;
    sleep(milliseconds: number): Promise<void>;
    now?(): number;
  },
): Promise<SourceRecoveryFacts> {
  for (;;) {
    const deadline = await deps.beforeCapture(current);
    const [live, stopped] = await Promise.all([
      deps.getJob(current.streamId),
      deps.getJob(previous.streamId),
    ]);
    if (typeof deadline === 'number' && (deps.now?.() ?? Date.now()) >= deadline) {
      throw Object.assign(new Error('provider_response_deadline_exceeded'), {
        code: 'provider_response_deadline_exceeded',
      });
    }
    const unboundCancelled = stopped ? await deps.isUnboundCancelled?.(stopped) : false;
    const ref = live?.nativePredecessor;
    const old = stopped?.nativeResponse;
    const pendingRemoval =
      live?.status === 'running' &&
      live.createdAt === current.createdAt &&
      stopped?.status === 'superseded' &&
      stopped.nativeResponseCancelled === true &&
      !unboundCancelled &&
      !stopped.deliveryAcknowledgement &&
      ref &&
      old &&
      stopped.streamId === ref.streamId &&
      stopped.createdAt === ref.createdAt &&
      stopped.responseMessageId === ref.responseMessageId &&
      old.invocationId === ref.invocationId &&
      stopped.userId === live.userId &&
      stopped.conversationId === live.conversationId &&
      old.logicalTurnId === live.interactionContext?.logical_turn_id &&
      nativeRevisionContinuity(live, stopped);
    if (pendingRemoval) {
      if (typeof deadline !== 'number')
        throw Object.assign(new Error('native_source_recovery_deadline_unconfirmed'), {
          code: 'native_source_recovery_deadline_unconfirmed',
        });
      await deps.sleep(300);
      continue;
    }
    if (
      !live ||
      live.createdAt !== current.createdAt ||
      stopped?.createdAt !== previous.createdAt ||
      (!nativePredecessorSourceRecovery(live, stopped) && !unboundPredecessorSourceRecovery(live, stopped, unboundCancelled))
    ) {
      throw nativeSourceRecoveryUnconfirmed('capture', live, stopped, undefined, {
        currentCreatedAtMatches: live?.createdAt === current.createdAt,
        previousCreatedAtMatches: stopped?.createdAt === previous.createdAt,
      });
    }
    const snapshot = await deps.readFacts({
      ownerId: live.userId,
      conversationId: live.conversationId!,
      logicalTurnId: live.interactionContext!.logical_turn_id!,
      sourceEventIds: (live.interactionContext!.source_segments ?? []).map(
        (segment) => segment.source_event_id,
      ),
    });
    if (!snapshot.pending) return snapshot.facts;
    await deps.sleep(300);
  }
}

export function stripNativePredecessorSupersession(init?: RequestInit): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  let payload: { metadata?: { native_predecessor_supersession?: object; [key: string]: unknown } };
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (
    !payload?.metadata ||
    !Object.prototype.hasOwnProperty.call(payload.metadata, 'native_predecessor_supersession')
  )
    return init;
  delete payload.metadata.native_predecessor_supersession;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  return { ...init, headers, body: JSON.stringify(payload) };
}
/* === VIVENTIUM END === */
