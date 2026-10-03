/* === VIVENTIUM START === Completed Voice playout settles the existing Cortex ledger. === */
import { createHash } from 'node:crypto';
import {
  createCortexInsightDeliveryService,
  requireExactCortexInsightDeliverySettlement,
} from './insightDeliveryService';

type DeliveryService = ReturnType<typeof createCortexInsightDeliveryService>;
type Fence = Awaited<ReturnType<DeliveryService['fencePresentationByParent']>>;
type Receipt = Pick<
  Fence,
  | 'ownerId'
  | 'messageId'
  | 'parentMessageId'
  | 'revision'
  | 'generation'
  | 'claimToken'
  | 'deliveryIds'
  | 'deliveryReceipts'
  | 'presentationLeaseToken'
> & {
  version: 1;
  surface: 'voice';
  callSessionId: string;
  taskId: string;
  streamId: string;
  logicalTurnId: string;
  presentationRef: string;
  messageHash: string;
};

export interface VoiceCortexMessage {
  user: string;
  messageId: string;
  conversationId: string;
  text: string;
  error?: boolean;
  unfinished?: boolean;
  deletedAt?: string | Date | null;
  isCreatedByUser: boolean;
  metadata?: {
    viventium?: {
      parentMessageId?: string;
      cortexInsightDeliveryIds?: string[];
      cortexPresentationParentMessageId?: string;
      cortexPresentationGeneration?: number;
      cortexPresentationClaimToken?: string;
      messageRevision?: number;
      callSessionId?: string;
      voiceTaskId?: string;
      interactionContext?: { surface?: string; logical_turn_id?: string };
      deliveryAcknowledgement?: { cortexPresentation?: Receipt };
    };
  };
}

export interface VoiceCortexReceiptInput {
  ownerId: string;
  conversationId: string;
  parentMessageId: string;
  callSessionId: string;
  taskId: string;
  streamId: string;
  turnId: string;
  presentationRef: string;
  stage: string;
}

interface Dependencies extends Pick<
  DeliveryService,
  'fencePresentationByParent' | 'markPresentationByParent' | 'listByParent'
> {
  readMessage: (scope: {
    ownerId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<VoiceCortexMessage | null>;
  recordReceipt: (message: VoiceCortexMessage, receipt: Receipt) => Promise<boolean>;
}

function conflict(): never {
  throw Object.assign(new Error('Exact Cortex Voice presentation receipt is unavailable'), {
    code: 'cortex_voice_presentation_receipt_conflict',
  });
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function successfulOwnedMessage(message: VoiceCortexMessage, input: VoiceCortexReceiptInput) {
  return (
    String(message.user) === input.ownerId &&
    message.conversationId === input.conversationId &&
    message.isCreatedByUser === false &&
    message.error !== true &&
    message.unfinished !== true &&
    !message.deletedAt
  );
}

/** The authenticated adapter reports playout; canonical messages and ledger fences own its identity. */
async function applyVoiceCortexPresentation(
  input: VoiceCortexReceiptInput,
  deps: Dependencies,
  completed: boolean,
  expectedText?: string,
  leaseMs?: number,
) {
  const child = await deps.readMessage({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    messageId: input.presentationRef,
  });
  const meta = child?.metadata?.viventium;
  if (!meta?.cortexInsightDeliveryIds?.length) return null;
  if (!Array.isArray(meta.cortexInsightDeliveryIds)) conflict();
  const ids = [...new Set(meta.cortexInsightDeliveryIds)].sort();
  const revision = meta.messageRevision;
  const generation = meta.cortexPresentationGeneration;
  const claimToken = meta.cortexPresentationClaimToken;
  if (
    !child ||
    !input.parentMessageId ||
    !successfulOwnedMessage(child, input) ||
    child.messageId !== input.presentationRef ||
    typeof child.text !== 'string' ||
    !child.text.trim() ||
    (expectedText !== undefined && child.text.trim() !== expectedText.trim()) ||
    ids.length !== meta.cortexInsightDeliveryIds.length ||
    ids.some((id) => typeof id !== 'string' || !id) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !Number.isSafeInteger(generation) ||
    Number(generation) < 1 ||
    !claimToken ||
    meta.cortexPresentationParentMessageId !== input.parentMessageId ||
    (child.messageId !== input.parentMessageId && meta.parentMessageId !== input.parentMessageId)
  )
    conflict();
  const parent =
    child.messageId === input.parentMessageId
      ? child
      : await deps.readMessage({
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          messageId: input.parentMessageId,
        });
  const parentMeta = parent?.metadata?.viventium;
  if (
    !parent ||
    parent.messageId !== input.parentMessageId ||
    !successfulOwnedMessage(parent, input) ||
    parentMeta?.callSessionId !== input.callSessionId ||
    parentMeta?.voiceTaskId !== input.taskId ||
    parentMeta?.interactionContext?.surface !== 'voice' ||
    parentMeta.interactionContext.logical_turn_id !== input.turnId
  )
    conflict();

  if (!completed) {
    if (!Number.isFinite(leaseMs) || Number(leaseMs) <= 0) conflict();
    const rows = (
      await deps.listByParent({ ownerId: input.ownerId, parentMessageId: input.parentMessageId })
    ).filter((row) => ids.includes(String(row.deliveryId)));
    if (
      rows.length !== ids.length ||
      rows.some(
        (row) =>
          row.persistedMessageId !== child.messageId ||
          Number(row.claimGeneration) !== generation ||
          Number(row.presentationRevision || row.messageRevision || row.sourceRevision) !==
            revision,
      )
    )
      conflict();
    if (rows.every((row) => row.presentedSurfaces?.includes('voice') || row.status === 'dropped'))
      return false;
  }
  const messageHash = createHash('sha256').update(child.text).digest('hex');
  let receipt = meta.deliveryAcknowledgement?.cortexPresentation;
  if (!receipt) {
    if (completed) conflict();
    const fence = await deps.fencePresentationByParent({
      ownerId: input.ownerId,
      parentMessageId: input.parentMessageId,
      surface: 'voice',
      persistedMessageId: child.messageId,
      messageRevision: revision,
      expectedDeliveryIds: ids,
      expectedGeneration: generation,
      leaseMs,
    });
    if (
      fence.ownerId !== input.ownerId ||
      fence.messageId !== child.messageId ||
      fence.parentMessageId !== input.parentMessageId ||
      fence.surface !== 'voice' ||
      fence.revision !== revision ||
      fence.generation !== generation ||
      fence.claimToken !== claimToken ||
      !sameIds(fence.deliveryIds, ids)
    )
      conflict();
    receipt = {
      version: 1,
      surface: 'voice',
      ownerId: input.ownerId,
      messageId: child.messageId,
      parentMessageId: input.parentMessageId,
      revision: Number(revision),
      generation: Number(generation),
      claimToken,
      deliveryIds: ids,
      deliveryReceipts: fence.deliveryReceipts,
      presentationLeaseToken: fence.presentationLeaseToken,
      callSessionId: input.callSessionId,
      taskId: input.taskId,
      streamId: input.streamId,
      logicalTurnId: input.turnId,
      presentationRef: input.presentationRef,
      messageHash,
    };
    if (!(await deps.recordReceipt(child, receipt))) conflict();
  }
  if (
    receipt.version !== 1 ||
    receipt.surface !== 'voice' ||
    receipt.ownerId !== input.ownerId ||
    receipt.messageId !== child.messageId ||
    receipt.parentMessageId !== input.parentMessageId ||
    receipt.revision !== revision ||
    receipt.generation !== generation ||
    receipt.claimToken !== claimToken ||
    receipt.callSessionId !== input.callSessionId ||
    receipt.taskId !== input.taskId ||
    receipt.streamId !== input.streamId ||
    receipt.logicalTurnId !== input.turnId ||
    receipt.presentationRef !== input.presentationRef ||
    receipt.messageHash !== messageHash ||
    !Array.isArray(receipt.deliveryIds) ||
    !sameIds(receipt.deliveryIds, ids) ||
    !receipt.presentationLeaseToken ||
    !Array.isArray(receipt.deliveryReceipts) ||
    receipt.deliveryReceipts.length !== ids.length ||
    receipt.deliveryReceipts.some(
      (row, index) => row.deliveryId !== ids[index] || !/^[a-f0-9]{64}$/.test(row.graphResultHash),
    )
  )
    conflict();
  if (!completed) return true;
  const settled = await deps.markPresentationByParent({
    ownerId: input.ownerId,
    parentMessageId: input.parentMessageId,
    surface: 'voice',
    persistedMessageId: child.messageId,
    messageRevision: revision,
    presentationGeneration: generation,
    presentationClaimToken: claimToken,
    presentationRef: input.presentationRef,
    expectedDeliveryIds: ids,
    expectedDeliveryReceipts: receipt.deliveryReceipts,
    expectedPresentationLeaseToken: receipt.presentationLeaseToken,
  });
  requireExactCortexInsightDeliverySettlement(
    ids.map((deliveryId) => ({ deliveryId, claimGeneration: Number(generation) })),
    settled,
  );
  return settled;
}

export async function prepareVoiceCortexPresentation(
  input: Omit<VoiceCortexReceiptInput, 'stage'> & { text: string; leaseMs: number },
  deps: Dependencies,
) {
  return (
    (await applyVoiceCortexPresentation(
      { ...input, stage: 'presentation.prepared' },
      deps,
      false,
      input.text,
      input.leaseMs,
    )) === true
  );
}

export async function confirmVoiceCortexPresentation(
  input: VoiceCortexReceiptInput,
  deps: Dependencies,
): Promise<Awaited<ReturnType<DeliveryService['markPresentationByParent']>> | null> {
  if (input.stage !== 'audio.completed') return null;
  const result = await applyVoiceCortexPresentation(input, deps, true);
  return Array.isArray(result) ? result : null;
}
/* === VIVENTIUM END === */
