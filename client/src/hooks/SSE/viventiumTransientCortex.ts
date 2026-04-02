import type { TMessage } from 'librechat-data-provider';

type TCortexCarrier = TMessage & {
  __viventiumCortexParts?: unknown[];
};

function cloneTransientParts(parts: unknown[]): unknown[] {
  return parts.map((part) => (part && typeof part === 'object' ? { ...(part as Record<string, unknown>) } : part));
}

function getTransientParts(message: TMessage | null | undefined): unknown[] | null {
  const parts = (message as TCortexCarrier | null | undefined)?.__viventiumCortexParts;
  return Array.isArray(parts) && parts.length > 0 ? parts : null;
}

/* === VIVENTIUM START ===
 * Feature: Preserve transient cortex state across FINAL message replacement.
 *
 * Why:
 * - Tool-cortex hold runs stream into a client-only placeholder message (`${userMessageId}_`).
 * - The FINAL event replaces that placeholder with the canonical server message.
 * - If we drop transient `__viventiumCortexParts` during that swap, fast Phase B completions can
 *   finish before the polling hook ever observes an active cortex, so the UI stays on the
 *   placeholder text until a manual reload.
 *
 * Behavior:
 * - Carry the transient cortex parts from the in-flight response placeholder onto the canonical
 *   final response message. The existing follow-up poller then sees the cortex cycle and refetches
 *   the saved message replacement from Mongo.
 * === VIVENTIUM END === */
export function preserveTransientCortexState({
  currentMessages,
  requestMessageId,
  responseMessage,
}: {
  currentMessages?: TMessage[] | null;
  requestMessageId?: string | null;
  responseMessage?: TMessage | null;
}): TMessage | null | undefined {
  if (!responseMessage) {
    return responseMessage;
  }

  if (getTransientParts(responseMessage)) {
    return responseMessage;
  }

  const requestId = typeof requestMessageId === 'string' ? requestMessageId : '';
  if (!Array.isArray(currentMessages) || currentMessages.length === 0 || requestId.length === 0) {
    return responseMessage;
  }

  const placeholderId = `${requestId}_`;
  const candidates = [...currentMessages].reverse().filter((message) => {
    if (!message || message.isCreatedByUser) {
      return false;
    }

    return (
      message.messageId === responseMessage.messageId ||
      message.messageId === placeholderId ||
      message.parentMessageId === requestId
    );
  });

  for (const candidate of candidates) {
    const transientParts = getTransientParts(candidate);
    if (!transientParts) {
      continue;
    }

    return {
      ...responseMessage,
      __viventiumCortexParts: cloneTransientParts(transientParts),
    } as TMessage;
  }

  return responseMessage;
}
