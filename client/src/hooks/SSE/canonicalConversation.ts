import { Constants } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';

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
): boolean => {
  if (!canonicalConversationId) {
    return false;
  }

  return (
    canonicalConversationId !== submission.conversation.conversationId ||
    startedAsNewConversation(submission)
  );
};
