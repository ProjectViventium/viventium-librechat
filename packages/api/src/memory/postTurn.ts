/* === VIVENTIUM START === Current saved response joins its existing memory source fence. === */
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TrustedInteractionContext } from '../agents/interactionContext';

type MemoryResponse = Partial<Pick<TMessage,
  'messageId' | 'conversationId' | 'parentMessageId' | 'isCreatedByUser' | 'error' | 'content'
>> & {
  user?: string;
  deletedAt?: Date | null;
  metadata?: { viventium?: { interactionContext?: TrustedInteractionContext } };
};

export function isCurrentMemoryWriterResponse({
  response, userId, conversationId, messageId, parentMessageId, context,
}: {
  response?: MemoryResponse | null;
  userId: string;
  conversationId: string;
  messageId: string;
  parentMessageId: string;
  context?: TrustedInteractionContext | null;
}): boolean {
  if (!response || String(response.user) !== String(userId) ||
    response.messageId !== messageId || response.conversationId !== conversationId ||
    response.parentMessageId !== parentMessageId || response.isCreatedByUser !== false ||
    response.deletedAt != null || response.error === true ||
    (Array.isArray(response.content) &&
      response.content.some((part) => part?.type === ContentTypes.ERROR))) return false;
  if (!context) return true;
  const accepted = response.metadata?.viventium?.interactionContext;
  return Boolean(accepted && accepted.conversation_id === context.conversation_id &&
    accepted.logical_turn_id === context.logical_turn_id && accepted.revision === context.revision &&
    accepted.source_event_id === context.source_event_id);
}
/* === VIVENTIUM END === */
