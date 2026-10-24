/* === VIVENTIUM START === Durable Cortex presentation uses canonical sources, never a job cache alone. === */
import { createHash } from 'node:crypto';
import type { IMessage, InteractionDeliveryAck } from '@librechat/data-schemas';
import type { TrustedInteractionContext } from '../agents/interactionContext';
import type {
  CortexPresentationFenceReceipt,
  DeliveryAcknowledgementResult,
} from '../stream/interfaces/IJobStore';

type MessageFields = Pick<
  Partial<IMessage>,
  | 'messageId'
  | 'conversationId'
  | 'parentMessageId'
  | 'user'
  | 'isCreatedByUser'
  | 'unfinished'
  | 'error'
  | 'deletedAt'
  | 'text'
>;
export interface CortexTelegramMessage extends MessageFields {
  metadata?: {
    viventium?: {
      type?: string;
      interactionContext?: TrustedInteractionContext;
      cortexPresentationParentMessageId?: string;
      messageRevision?: number;
      cortexPresentationGeneration?: number;
      cortexPresentationClaimToken?: string;
      cortexTelegramPresentation?: CortexTelegramPresentationProof;
      deliveryAcknowledgement?: InteractionDeliveryAck & {
        logical_turn_revision?: number;
        cortex_presentation_generation?: number;
        cortex_presentation_claim_token?: string;
      };
    };
  };
}
export interface CortexTelegramPresentationProof extends Omit<
  CortexPresentationFenceReceipt,
  'presentationLeaseToken'
> {
  version: 1;
  boundAt: number;
  messageHash: string;
  presentationLeaseToken?: string;
}
export interface CortexTelegramCandidate {
  userId: string;
  conversationId: string;
  parentMessageId: string;
  persistedMessageId: string;
  streamId: string;
}
export interface CortexTelegramIngress {
  libreChatUserId?: string;
  telegramUserId?: string;
  telegramChatId?: string;
  telegramMessageId?: string;
  telegramMessageThreadId?: string;
  sourceSequence?: number;
  sourceOrderScope?: string;
  sourceEventId?: string;
  sourceMessageId?: string;
  streamId?: string;
  conversationId?: string;
  authorityBoundAt?: Date;
  responseBinding?: {
    streamId: string;
    responseMessageId: string;
    logicalTurnId: string;
    revision: number;
  };
}
interface Job {
  streamId?: string;
  status?: string;
  metadata?: {
    userId?: string;
    conversationId?: string;
    responseMessageId?: string;
    deliveryPolicy?: { commit_authority?: string };
    interactionContext?: TrustedInteractionContext;
  };
}
interface Retained {
  responseMessageId: string;
  conversationId: string;
  interactionContext: TrustedInteractionContext;
}
export interface CortexTelegramAuthority {
  candidate: CortexTelegramCandidate;
  parent: CortexTelegramMessage | null;
  followup: CortexTelegramMessage | null;
  ingress: CortexTelegramIngress | null;
  mapping: { libreChatUserId?: string; telegramUserId?: string; telegramChatId?: string } | null;
  job: Job | null;
  retained?: Retained | null;
}
function successful(message: CortexTelegramMessage | null) {
  return (
    !!message &&
    message.isCreatedByUser === false &&
    message.unfinished === false &&
    message.error !== true &&
    !message.deletedAt
  );
}

/** A live conflicting author cannot borrow retained authority; absent caches can. */
export function exactCortexTelegramAuthority(input: CortexTelegramAuthority): boolean {
  const { candidate: c, parent, followup, ingress: i, mapping, job, retained } = input;
  const context = parent?.metadata?.viventium?.interactionContext;
  const binding = i?.responseBinding;
  if (
    !successful(parent) ||
    !successful(followup) ||
    !context ||
    !i ||
    !binding ||
    !mapping ||
    parent?.user !== c.userId ||
    parent.conversationId !== c.conversationId ||
    parent.messageId !== c.parentMessageId ||
    context.surface !== 'telegram' ||
    !context.logical_turn_id ||
    !Number.isSafeInteger(context.revision) ||
    context.revision < 1 ||
    !context.source_event_id ||
    followup?.user !== c.userId ||
    followup.conversationId !== c.conversationId ||
    followup.messageId !== c.persistedMessageId ||
    followup.parentMessageId !== c.parentMessageId ||
    !followup.text?.trim() ||
    followup.metadata?.viventium?.type !== 'cortex_followup' ||
    followup.metadata.viventium.cortexPresentationParentMessageId !== c.parentMessageId ||
    i.libreChatUserId !== c.userId ||
    !(i.authorityBoundAt instanceof Date) ||
    !Number.isFinite(i.authorityBoundAt.getTime()) ||
    i.streamId !== c.streamId ||
    i.conversationId !== c.conversationId ||
    !i.telegramUserId ||
    !i.telegramChatId ||
    !Number.isSafeInteger(i.sourceSequence) ||
    Number(i.sourceSequence) < 1 ||
    Number(i.telegramMessageId) !== i.sourceSequence ||
    !/^[a-f0-9]{64}$/.test(i.sourceOrderScope || '') ||
    !/^[a-f0-9]{64}$/.test(i.sourceEventId || '') ||
    i.sourceEventId !== context.source_event_id ||
    !i.sourceMessageId ||
    parent.parentMessageId !== i.sourceMessageId ||
    binding.streamId !== c.streamId ||
    binding.responseMessageId !== c.parentMessageId ||
    binding.logicalTurnId !== context.logical_turn_id ||
    binding.revision !== context.revision ||
    mapping.libreChatUserId !== c.userId ||
    (mapping.telegramUserId && mapping.telegramUserId !== i.telegramUserId) ||
    (mapping.telegramChatId && mapping.telegramChatId !== i.telegramChatId)
  )
    return false;
  if (!job)
    return (
      retained?.responseMessageId === c.parentMessageId &&
      retained.conversationId === c.conversationId &&
      retained.interactionContext.surface === 'telegram' &&
      retained.interactionContext.logical_turn_id === context.logical_turn_id &&
      retained.interactionContext.revision === context.revision &&
      retained.interactionContext.source_event_id === i.sourceEventId
    );
  const meta = job.metadata;
  const live = meta?.interactionContext;
  return (
    !['aborted', 'superseded', 'error'].includes(job.status || '') &&
    job.streamId === c.streamId &&
    meta?.userId === c.userId &&
    meta.conversationId === c.conversationId &&
    meta.responseMessageId === c.parentMessageId &&
    meta.deliveryPolicy?.commit_authority === 'external_adapter' &&
    live?.surface === 'telegram' &&
    live.logical_turn_id === context.logical_turn_id &&
    live.revision === context.revision &&
    live.source_order_scope === i.sourceOrderScope &&
    live.source_sequence === i.sourceSequence &&
    live.source_event_id === i.sourceEventId
  );
}

export function cortexTelegramPresentationProof(
  message: CortexTelegramMessage,
  fence: Omit<CortexPresentationFenceReceipt, 'presentationLeaseToken'> & {
    presentationLeaseToken?: string;
  },
): CortexTelegramPresentationProof {
  return {
    ...fence,
    version: 1,
    boundAt: Date.now(),
    messageHash: createHash('sha256')
      .update(message.text || '')
      .digest('hex'),
  };
}

export function exactCortexTelegramPresentation(
  message: CortexTelegramMessage,
  fence: Omit<CortexPresentationFenceReceipt, 'presentationLeaseToken'> & {
    presentationLeaseToken?: string;
  },
  requireLease = false,
): boolean {
  const meta = message.metadata?.viventium;
  const proof = meta?.cortexTelegramPresentation;
  return (
    successful(message) &&
    !!proof &&
    proof.version === 1 &&
    proof.ownerId === fence.ownerId &&
    proof.messageId === fence.messageId &&
    proof.parentMessageId === fence.parentMessageId &&
    proof.revision === fence.revision &&
    proof.generation === fence.generation &&
    proof.claimToken === fence.claimToken &&
    meta?.messageRevision === fence.revision &&
    meta.cortexPresentationGeneration === fence.generation &&
    meta.cortexPresentationClaimToken === fence.claimToken &&
    proof.messageHash ===
      createHash('sha256')
        .update(message.text || '')
        .digest('hex') &&
    JSON.stringify(proof.deliveryIds) === JSON.stringify(fence.deliveryIds) &&
    JSON.stringify(proof.deliveryReceipts) === JSON.stringify(fence.deliveryReceipts) &&
    (!requireLease ||
      (!!fence.presentationLeaseToken &&
        proof.presentationLeaseToken === fence.presentationLeaseToken))
  );
}
/* === VIVENTIUM END === */

/** ACK replay recovers only an exact durable presentation; it never authorizes a send. */
export function retainedCortexTelegramAcknowledgement(input: {
  acknowledgement: InteractionDeliveryAck;
  presentation: CortexPresentationFenceReceipt;
  authority: CortexTelegramAuthority;
  presented: boolean;
}): DeliveryAcknowledgementResult {
  const { acknowledgement: ack, presentation, authority, presented } = input;
  const context = authority.parent?.metadata?.viventium?.interactionContext;
  const refs = [
    ...new Set(
      [...(ack.presentation_refs || []), ack.presentation_ref].filter(
        (ref): ref is string => typeof ref === 'string' && ref.length > 0,
      ),
    ),
  ].sort();
  if (
    ack.state !== 'committed' ||
    ack.effect_ref ||
    ack.source_kind === 'schedule_result' ||
    authority.job ||
    !exactCortexTelegramAuthority(authority) ||
    !authority.followup ||
    !exactCortexTelegramPresentation(authority.followup, presentation, true) ||
    !context ||
    ack.logical_turn_id !== context.logical_turn_id ||
    ack.revision !== context.revision ||
    !refs.length ||
    refs.some(
      (ref) =>
        !ref.startsWith(`telegram:${authority.ingress?.telegramChatId}:`) ||
        !/^[1-9][0-9]*$/.test(ref.split(':').at(-1) || ''),
    )
  )
    return { status: 'conflict' };
  const saved = authority.followup.metadata?.viventium?.deliveryAcknowledgement;
  if (
    (presented || saved?.state === 'committed') &&
    (!saved ||
      saved.state !== 'committed' ||
      saved.logical_turn_id !== ack.logical_turn_id ||
      saved.logical_turn_revision !== ack.revision ||
      saved.cortex_presentation_generation !== presentation.generation ||
      saved.cortex_presentation_claim_token !== presentation.claimToken ||
      JSON.stringify([...(saved.presentation_refs || [saved.presentation_ref])].sort()) !==
        JSON.stringify(refs))
  )
    return { status: 'conflict' };
  return {
    status: 'recorded',
    acknowledgement:
      saved?.state === 'committed'
        ? { ...ack, presentation_committed_at: saved.presentation_committed_at }
        : ack,
    idempotent: presented,
    ownerStreamId: authority.candidate.streamId,
    presentation: {
      userId: authority.candidate.userId,
      conversationId: authority.candidate.conversationId,
      responseMessageId: authority.candidate.parentMessageId,
      interactionContext: context,
      cortexPresentation: {
        ...presentation,
        boundAt: authority.followup.metadata!.viventium!.cortexTelegramPresentation!.boundAt,
      },
    },
  };
}
