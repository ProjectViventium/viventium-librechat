import { Constants } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';

export type CanonicalConversationSubmission<T extends TSubmission = TSubmission> = T & {
  viventiumOriginalConversationId?: string | null;
};

export const startedAsNewConversation = (submission: CanonicalConversationSubmission): boolean => {
  if (!Object.prototype.hasOwnProperty.call(submission, 'viventiumOriginalConversationId')) {
    return false;
  }

  const originalConversationId = submission.viventiumOriginalConversationId;
  return (
    originalConversationId == null ||
    originalConversationId === '' ||
    originalConversationId === Constants.NEW_CONVO
  );
};

export const shouldQueueCanonicalTitle = (
  canonicalConversationId: string | null | undefined,
  submission: CanonicalConversationSubmission,
  requestMessage?: TMessage,
  responseMessage?: TMessage,
): boolean => {
  if (!canonicalConversationId) {
    return false;
  }

  return (
    canonicalConversationId !== submission.conversation.conversationId ||
    startedAsNewConversation(submission) ||
    isRootConversationResponse(canonicalConversationId, requestMessage, responseMessage)
  );
};

const isRootConversationResponse = (
  conversationId: string,
  requestMessage?: TMessage,
  responseMessage?: TMessage,
): boolean =>
  Boolean(
    requestMessage?.messageId &&
    responseMessage?.messageId &&
    requestMessage.messageId !== responseMessage.messageId &&
    requestMessage.isCreatedByUser === true &&
    requestMessage.parentMessageId === Constants.NO_PARENT &&
    requestMessage.conversationId === conversationId &&
    responseMessage.isCreatedByUser === false &&
    responseMessage.parentMessageId === requestMessage.messageId &&
    responseMessage.conversationId === conversationId,
  );

export const shouldQueueLoadedCanonicalTitle = (
  conversationId: string,
  messages: TMessage[],
): boolean => {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  return messages.some(
    (message) =>
      message.unfinished === false &&
      message.error !== true &&
      isRootConversationResponse(conversationId, byId.get(message.parentMessageId ?? ''), message),
  );
};
