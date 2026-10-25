/* === VIVENTIUM START === Retained delivery reads never restart accepted execution. === */
import { nativeIdentityJson } from '../stream/implementations/nativeResponse';
import type { IMessage, NativeResponseAdmission } from '@librechat/data-schemas';
import type { InteractionSurface, TrustedInteractionContext } from '../agents/interactionContext';

type Message = Pick<
  IMessage,
  | 'messageId'
  | 'conversationId'
  | 'user'
  | 'parentMessageId'
  | 'isCreatedByUser'
  | 'unfinished'
  | 'error'
  | 'deletedAt'
  | 'text'
  | 'content'
  | 'metadata'
  | 'attachments'
>;
type NativeMessage = Message & { nativeResponse?: NativeResponseAdmission };
export interface RetainedMainFinalScope {
  userId: string;
  streamId: string;
  conversationId?: string;
  responseMessageId?: string;
  surface?: InteractionSurface;
}
export interface RetainedMainFinal {
  responseMessageId: string;
  conversationId: string;
  interactionContext: TrustedInteractionContext;
  finalEvent: {
    final: true;
    conversation: { conversationId: string };
    requestMessage: Message;
    responseMessage: Message;
  };
}
interface Dependencies {
  readCandidates(scope: RetainedMainFinalScope): Promise<NativeMessage[]>;
  sourceMatches(identity: NativeResponseAdmission): Promise<boolean>;
  isCurrent(identity: NativeResponseAdmission): Promise<boolean>;
  readCompleted(identity: NativeResponseAdmission): Promise<Message | null>;
  readSource(identity: NativeResponseAdmission): Promise<Message | null>;
}

/** A completed snapshot may outlive its stream cache; pending/unknown work is never replayed. */
export async function readRetainedNativeMainFinal(
  scope: RetainedMainFinalScope,
  deps: Dependencies,
): Promise<RetainedMainFinal | null> {
  if (!scope.userId || !scope.streamId) return null;
  const rows = await deps.readCandidates(scope);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const identity = row.nativeResponse;
  const metadata = row.metadata?.viventium as
    { interactionContext?: TrustedInteractionContext } | undefined;
  const context = metadata?.interactionContext;
  if (
    !identity ||
    identity.status !== 'completed' ||
    row.unfinished !== false ||
    row.error ||
    row.deletedAt ||
    row.isCreatedByUser !== false ||
    row.user !== scope.userId ||
    identity.userId !== scope.userId ||
    identity.streamId !== scope.streamId ||
    identity.conversationId !== row.conversationId ||
    identity.responseMessageId !== row.messageId ||
    identity.source.messageId !== row.parentMessageId ||
    (scope.conversationId && row.conversationId !== scope.conversationId) ||
    (scope.responseMessageId && row.messageId !== scope.responseMessageId) ||
    !context ||
    context.logical_turn_id !== identity.logicalTurnId ||
    context.revision !== identity.revision ||
    context.conversation_id !== identity.conversationId ||
    (scope.surface && context.surface !== scope.surface) ||
    !(await deps.sourceMatches(identity)) ||
    !(await deps.isCurrent(identity))
  )
    return null;
  const response = await deps.readCompleted(identity);
  const source = await deps.readSource(identity);
  const current = await deps.readCandidates(scope);
  if (
    !response ||
    !source ||
    current.length !== 1 ||
    !current[0].nativeResponse ||
    current[0].nativeResponse.status !== 'completed' ||
    current[0].unfinished !== false ||
    current[0].error ||
    current[0].deletedAt ||
    nativeIdentityJson(current[0].nativeResponse) !== nativeIdentityJson(identity) ||
    current[0].nativeResponse.candidateSha256 !== identity.candidateSha256 ||
    source.messageId !== identity.source.messageId ||
    source.user !== identity.userId ||
    source.conversationId !== identity.conversationId ||
    source.deletedAt ||
    source.isCreatedByUser !== true ||
    !(await deps.sourceMatches(identity)) ||
    !(await deps.isCurrent(identity))
  )
    return null;
  return {
    responseMessageId: row.messageId,
    conversationId: row.conversationId,
    interactionContext: context,
    finalEvent: {
      final: true,
      conversation: { conversationId: row.conversationId },
      requestMessage: source,
      responseMessage: response,
    },
  };
}
/* === VIVENTIUM END === */

export type RetainedMainFinalState =
  | { state: 'complete'; final: RetainedMainFinal }
  | {
      state: 'superseded';
      parent: Pick<
        RetainedMainFinal,
        'responseMessageId' | 'conversationId' | 'interactionContext'
      >;
    }
  | { state: 'unavailable' };

/** Only a canonical original-source proof and a newer durable author permit suppression. */
export async function inspectRetainedMainFinalState(
  scope: RetainedMainFinalScope,
  deps: {
    readFinal(scope: RetainedMainFinalScope): Promise<RetainedMainFinal | null>;
    readCandidates(scope: RetainedMainFinalScope): Promise<
      Array<
        NativeMessage & {
          hostFinal?: import('@librechat/data-schemas').HostResponseFinal;
        }
      >
    >;
    sourceMatches(
      identity: NativeResponseAdmission | import('@librechat/data-schemas').HostResponseFinal,
    ): Promise<boolean>;
    hasNewerSource(
      identity: NativeResponseAdmission | import('@librechat/data-schemas').HostResponseFinal,
      context: TrustedInteractionContext,
    ): Promise<boolean>;
  },
): Promise<RetainedMainFinalState> {
  const final = await deps.readFinal(scope);
  if (final) return { state: 'complete', final };
  const rows = await deps.readCandidates(scope);
  if (rows.length !== 1) return { state: 'unavailable' };
  const row = rows[0];
  const identity = row.nativeResponse?.status === 'completed' ? row.nativeResponse : row.hostFinal;
  const context = (
    row.metadata?.viventium as { interactionContext?: TrustedInteractionContext } | undefined
  )?.interactionContext;
  if (
    !identity ||
    row.unfinished !== false ||
    row.error ||
    row.deletedAt ||
    row.isCreatedByUser !== false ||
    row.user !== scope.userId ||
    !context ||
    identity.userId !== scope.userId ||
    identity.streamId !== scope.streamId ||
    identity.responseMessageId !== row.messageId ||
    identity.conversationId !== row.conversationId ||
    identity.source?.messageId !== row.parentMessageId ||
    context.logical_turn_id !== identity.logicalTurnId ||
    context.revision !== identity.revision ||
    (scope.surface && context.surface !== scope.surface) ||
    !(await deps.sourceMatches(identity))
  )
    return { state: 'unavailable' };
  if (!(await deps.hasNewerSource(identity, context))) return { state: 'unavailable' };
  const current = await deps.readCandidates(scope);
  if (
    current.length !== 1 ||
    current[0].messageId !== row.messageId ||
    current[0].user !== scope.userId ||
    current[0].conversationId !== row.conversationId ||
    current[0].isCreatedByUser !== false ||
    current[0].deletedAt ||
    current[0].unfinished !== false ||
    current[0].error ||
    JSON.stringify(current[0].nativeResponse || current[0].hostFinal) !==
      JSON.stringify(row.nativeResponse || row.hostFinal) ||
    !(await deps.sourceMatches(identity))
  )
    return { state: 'unavailable' };
  return {
    state: 'superseded',
    parent: {
      responseMessageId: row.messageId,
      conversationId: row.conversationId,
      interactionContext: context,
    },
  };
}
