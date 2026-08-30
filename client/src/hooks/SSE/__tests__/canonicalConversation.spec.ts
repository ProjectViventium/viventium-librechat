import { Constants } from 'librechat-data-provider';
import {
  shouldQueueCanonicalTitle,
  type CanonicalConversationSubmission,
} from '../canonicalConversation';
import type { EventSubmission } from 'librechat-data-provider';

const submission = (
  conversationId: string,
  originalConversationId?: string | null,
): CanonicalConversationSubmission<EventSubmission> => ({
  conversation: { conversationId },
  userMessage: {
    messageId: 'user-message',
    parentMessageId: String(Constants.NO_PARENT),
    conversationId,
    text: 'Synthetic title request',
    isCreatedByUser: true,
  },
  initialResponse: {
    messageId: 'assistant-message',
    parentMessageId: 'user-message',
    conversationId,
    text: '',
    isCreatedByUser: false,
  },
  endpointOption: { endpoint: null },
  isTemporary: false,
  messages: [],
  ...(originalConversationId !== undefined
    ? { viventiumOriginalConversationId: originalConversationId }
    : {}),
});

describe('canonical new-chat title provenance', () => {
  it('queues a title after the start receipt has already rebound new to canonical', () => {
    const claimed = submission('conversation-canonical', Constants.NEW_CONVO);

    expect(shouldQueueCanonicalTitle('conversation-canonical', claimed)).toBe(true);
  });

  it('does not relabel an ordinary existing conversation without new-chat provenance', () => {
    const existing = submission('conversation-existing');

    expect(shouldQueueCanonicalTitle('conversation-existing', existing)).toBe(false);
  });
});
