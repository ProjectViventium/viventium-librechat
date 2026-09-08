import { interactionPresentationSequence } from '../../agents/interactionContext';
/* VIVENTIUM START: one typed identity projection for both job store owners. */
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import { normalizeNativeResponseIdentity } from '@librechat/data-schemas';
import type { SerializableJobData } from '../interfaces/IJobStore';

export const NATIVE_RESPONSE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function nativeIdentityJson(value: NativeResponseIdentity): string {
  value = normalizeNativeResponseIdentity(value);
  let deliveryContext;
  if (value.deliveryContext) {
    deliveryContext =
      value.deliveryContext.surface === 'telegram'
        ? {
            surface: 'telegram',
            audioRequested: value.deliveryContext.audioRequested,
            authenticated: value.deliveryContext.authenticated,
          }
        : { surface: value.deliveryContext.surface };
  }
  return JSON.stringify({
    userId: value.userId,
    conversationId: value.conversationId,
    responseMessageId: value.responseMessageId,
    streamId: value.streamId,
    jobCreatedAt: value.jobCreatedAt,
    logicalTurnId: value.logicalTurnId,
    revision: value.revision,
    sourceOrderScope: value.sourceOrderScope,
    sourceSequence: value.sourceSequence,
    deliveryDispositionRequired: value.deliveryDispositionRequired,
    deliveryContext,
    invocationId: value.invocationId,
    bodySha256: value.bodySha256,
    providerId: value.providerId,
    agentId: value.agentId,
    originSha256: value.originSha256,
    source: {
      id: value.source.id,
      messageId: value.source.messageId,
      digest: value.source.digest,
      ...(value.source.parent
        ? {
            parent: {
              id: value.source.parent.id,
              messageId: value.source.parent.messageId,
              digest: value.source.parent.digest,
            },
          }
        : {}),
    },
    admittedAt: value.admittedAt,
    recoverUntil: value.recoverUntil,
  });
}

export function nativeIdentityValid(identity: NativeResponseIdentity, now = Date.now()): boolean {
  identity = normalizeNativeResponseIdentity(identity);
  return Boolean(
    identity &&
    identity.source &&
    [
      identity.source,
      ...(identity.source.parent === undefined ? [] : [identity.source.parent]),
    ].every(
      (proof) =>
        proof &&
        [proof.id, proof.messageId].every(
          (value) => typeof value === 'string' && value.length > 0,
        ) &&
        /^[a-f0-9]{64}$/.test(proof.digest),
    ) &&
    (identity.deliveryContext === undefined ||
      identity.deliveryContext.surface === 'web' ||
      identity.deliveryContext.surface === 'voice' ||
      (identity.deliveryContext.surface === 'telegram' &&
        typeof identity.deliveryContext.audioRequested === 'boolean' &&
        typeof identity.deliveryContext.authenticated === 'boolean')) &&
    [
      identity.userId,
      identity.conversationId,
      identity.responseMessageId,
      identity.streamId,
      identity.logicalTurnId,
      identity.invocationId,
      identity.providerId,
      identity.agentId,
    ].every((value) => typeof value === 'string' && value.length > 0) &&
    [identity.bodySha256, identity.originSha256].every((value) => /^[a-f0-9]{64}$/.test(value)) &&
    Number.isSafeInteger(identity.jobCreatedAt) &&
    Number.isSafeInteger(identity.admittedAt) &&
    identity.jobCreatedAt > 0 &&
    identity.admittedAt > 0 &&
    identity.admittedAt <= now &&
    identity.recoverUntil === identity.admittedAt + NATIVE_RESPONSE_RECOVERY_WINDOW_MS &&
    identity.recoverUntil > now &&
    Number.isSafeInteger(identity.revision) &&
    identity.revision > 0 &&
    ((identity.sourceOrderScope === undefined && identity.sourceSequence === undefined) ||
      (typeof identity.sourceOrderScope === 'string' &&
        /^[a-f0-9]{64}$/.test(identity.sourceOrderScope) &&
        Number.isSafeInteger(identity.sourceSequence) &&
        identity.sourceSequence! > 0)),
  );
}

export function nativeJobMatches(
  job: SerializableJobData | null,
  identity: NativeResponseIdentity,
): job is SerializableJobData {
  identity = normalizeNativeResponseIdentity(identity);
  return Boolean(
    job &&
    job.userId === identity.userId &&
    job.streamId === identity.streamId &&
    job.createdAt === identity.jobCreatedAt &&
    job.conversationId === identity.conversationId &&
    job.responseMessageId === identity.responseMessageId &&
    job.userMessage?.messageId === identity.source.messageId &&
    job.interactionContext?.logical_turn_id === identity.logicalTurnId &&
    job.interactionContext?.revision === identity.revision &&
    job.interactionContext?.source_order_scope === identity.sourceOrderScope &&
    interactionPresentationSequence(job.interactionContext) === identity.sourceSequence,
  );
}

/** The existing job incarnation projection, shared by Redis CAS and internal event delivery. */
export function nativeJobProofJson(
  job: Pick<SerializableJobData, 'userId' | 'createdAt' | 'conversationId' | 'responseMessageId'>,
): string {
  return JSON.stringify({
    userId: job.userId,
    createdAt: job.createdAt,
    conversationId: job.conversationId,
    responseMessageId: job.responseMessageId,
  });
}

export function nativeIdentityJobProofJson(identity: NativeResponseIdentity): string {
  return nativeJobProofJson({
    userId: identity.userId,
    createdAt: identity.jobCreatedAt,
    conversationId: identity.conversationId,
    responseMessageId: identity.responseMessageId,
  });
}

export function retainNativeResponse(job: SerializableJobData, now = Date.now()): boolean {
  const identity = job.nativeResponse;
  if (!identity || identity.recoverUntil <= now) return false;
  if (!job.nativeResponseSettled) return true;
  const acknowledgement = job.deliveryAcknowledgement;
  return (
    job.deliveryPolicy?.commit_authority === 'external_adapter' &&
    !(
      acknowledgement?.state === 'committed' &&
      acknowledgement.logical_turn_id === identity.logicalTurnId &&
      acknowledgement.revision === identity.revision
    )
  );
}
/* VIVENTIUM END */
