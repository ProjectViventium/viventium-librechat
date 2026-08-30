import { Constants } from 'librechat-data-provider';
import type { Agents, TMessage } from 'librechat-data-provider';

/* === VIVENTIUM START ===
 * Feature: Exact optimistic-to-authoritative resume identity.
 * Purpose: Rebase only an admission-bound client placeholder pair. Provenance, text, agent names,
 *          providers, and array position are never accepted as presentation identity.
 */
export interface ResumeMessageProjection {
  historyMessages: TMessage[];
  visibleMessages: TMessage[];
  userMessage: TMessage;
  responseMessage: TMessage;
  projectedActivePair: boolean;
}

function normalizedId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameConversation(message: TMessage, conversationId: string): boolean {
  return !message.conversationId || message.conversationId === conversationId;
}

function sameClientConversation(message: TMessage, conversationId: string): boolean {
  return (
    sameConversation(message, conversationId) || message.conversationId === Constants.NEW_CONVO
  );
}

export function projectResumeMessages(
  resumeState: Agents.ResumeState,
  messages: TMessage[],
  conversationId: string,
): ResumeMessageProjection {
  const userMessageData = resumeState.userMessage;
  const serverUserMessageId = normalizedId(userMessageData?.messageId);
  const serverResponseMessageId = normalizedId(resumeState.responseMessageId);
  const presentation = resumeState.clientPresentation;
  const mode = presentation?.mode === 'regenerate' ? 'regenerate' : 'append';
  const clientUserMessageId = normalizedId(presentation?.userMessageId);
  const clientResponseMessageId = normalizedId(presentation?.responseMessageId);
  const targetUserMessageId = normalizedId(presentation?.targetUserMessageId);
  const hasAuthoritativePair = Boolean(serverUserMessageId && serverResponseMessageId);

  const existingServerUser = messages.find(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === serverUserMessageId &&
      sameConversation(message, conversationId),
  );
  const existingServerResponse = messages.find(
    (message) =>
      message.isCreatedByUser !== true &&
      message.messageId === serverResponseMessageId &&
      sameConversation(message, conversationId),
  );
  const clientUser = messages.find(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === clientUserMessageId &&
      sameClientConversation(message, conversationId),
  );
  const clientResponse = messages.find(
    (message) =>
      message.isCreatedByUser !== true &&
      message.messageId === clientResponseMessageId &&
      sameClientConversation(message, conversationId),
  );
  const targetUser = messages.find(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === targetUserMessageId &&
      sameConversation(message, conversationId),
  );

  const userBase =
    mode === 'regenerate' ? (existingServerUser ?? targetUser) : (existingServerUser ?? clientUser);
  const responseBase = existingServerResponse ?? clientResponse;
  const userMessage = {
    ...(userBase ?? {}),
    messageId: serverUserMessageId || userBase?.messageId || 'resume_user_msg',
    parentMessageId:
      userMessageData?.parentMessageId ?? userBase?.parentMessageId ?? Constants.NO_PARENT,
    conversationId: userMessageData?.conversationId ?? conversationId,
    text: userMessageData?.text ?? userBase?.text ?? '',
    isCreatedByUser: true,
    role: 'user',
  } as TMessage;
  const responseMessage = {
    ...(responseBase ?? {}),
    messageId: serverResponseMessageId || responseBase?.messageId || 'resume_response_msg',
    parentMessageId:
      mode === 'regenerate'
        ? targetUserMessageId || serverUserMessageId
        : serverUserMessageId || userMessage.messageId,
    conversationId,
    text: '',
    content: (resumeState.aggregatedContent as TMessage['content']) ?? responseBase?.content ?? [],
    isCreatedByUser: false,
    role: 'assistant',
    sender: responseBase?.sender ?? resumeState.sender,
    model: responseBase?.model,
  } as TMessage;

  if (!hasAuthoritativePair || !presentation) {
    return {
      historyMessages: messages,
      visibleMessages: messages,
      userMessage,
      responseMessage,
      projectedActivePair: false,
    };
  }

  const expectedParent = normalizedId(userMessageData?.parentMessageId);
  const hasExactClientPair =
    mode === 'regenerate'
      ? Boolean(
          targetUser && clientResponse && clientResponse.parentMessageId === targetUserMessageId,
        )
      : Boolean(
          targetUserMessageId === clientUserMessageId &&
          clientUser &&
          clientResponse &&
          clientResponse.parentMessageId === clientUserMessageId &&
          (!expectedParent || clientUser.parentMessageId === expectedParent),
        );
  const hasExactAuthoritativePair =
    mode === 'regenerate'
      ? Boolean(
          targetUser &&
          existingServerResponse &&
          existingServerResponse.parentMessageId === targetUserMessageId,
        )
      : Boolean(
          existingServerUser &&
          existingServerResponse &&
          existingServerResponse.parentMessageId === serverUserMessageId &&
          (!expectedParent || existingServerUser.parentMessageId === expectedParent),
        );

  if (!hasExactClientPair && !hasExactAuthoritativePair) {
    return {
      historyMessages: messages,
      visibleMessages: messages,
      userMessage,
      responseMessage,
      projectedActivePair: false,
    };
  }

  if (hasExactAuthoritativePair && !hasExactClientPair) {
    const visibleMessages = messages.map((message) => {
      if (mode === 'append' && message.messageId === serverUserMessageId) {
        return userMessage;
      }
      if (message.messageId === serverResponseMessageId) {
        return responseMessage;
      }
      return message;
    });
    const historyMessages = visibleMessages.filter((message) =>
      mode === 'regenerate'
        ? message.messageId !== serverResponseMessageId
        : ![serverUserMessageId, serverResponseMessageId].includes(message.messageId),
    );
    return {
      historyMessages,
      visibleMessages,
      userMessage,
      responseMessage,
      projectedActivePair: true,
    };
  }

  const visibleMessages: TMessage[] = [];
  for (const message of messages) {
    if (mode === 'append' && message.messageId === clientUserMessageId) {
      visibleMessages.push(userMessage);
      continue;
    }
    if (message.messageId === clientResponseMessageId) {
      visibleMessages.push(responseMessage);
      continue;
    }
    if (
      message.messageId === serverResponseMessageId ||
      (mode === 'append' && message.messageId === serverUserMessageId)
    ) {
      continue;
    }
    if (message.parentMessageId === clientResponseMessageId) {
      visibleMessages.push({ ...message, parentMessageId: serverResponseMessageId });
      continue;
    }
    if (mode === 'append' && message.parentMessageId === clientUserMessageId) {
      visibleMessages.push({ ...message, parentMessageId: serverUserMessageId });
      continue;
    }
    visibleMessages.push(message);
  }

  const historyMessages = visibleMessages.filter((message) =>
    mode === 'regenerate'
      ? message.messageId !== serverResponseMessageId
      : ![serverUserMessageId, serverResponseMessageId].includes(message.messageId),
  );
  return {
    historyMessages,
    visibleMessages,
    userMessage,
    responseMessage,
    projectedActivePair: true,
  };
}
/* === VIVENTIUM END === */
