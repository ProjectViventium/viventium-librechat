import type { TMessage } from 'librechat-data-provider';

type CortexPart = {
  type?: string;
  cortex_id?: string;
  cortex_name?: string;
  status?: string;
  confidence?: number;
  reason?: string;
  insight?: string | null;
  error?: string;
  silent?: boolean;
  no_response?: boolean;
  cortex_description?: string;
  activation_scope?: string | null;
  direct_action_surfaces?: unknown[];
  direct_action_surface_scopes?: unknown[];
  configured_tools?: number;
  completed_tool_calls?: number;
  status_changed_at?: string;
};

type CreateCortexPendingBufferParams = {
  getMessages: () => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
  maxFlushAttempts?: number;
  retryDelayMs?: number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
};

function findMessageIndex(messages: TMessage[], runId: string): number {
  return messages.findIndex(
    (m) => m.messageId === runId || m.messageId === `${runId}` || m.messageId?.startsWith(runId),
  );
}

function upsertCortexPart(parts: CortexPart[], cortexPart: CortexPart) {
  const idx = parts.findIndex((p) => p?.cortex_id === cortexPart?.cortex_id);
  if (idx >= 0) {
    const merged = { ...parts[idx] };
    for (const [key, value] of Object.entries(cortexPart)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    parts[idx] = merged;
  } else {
    parts.push(cortexPart);
  }
}

export function createCortexPendingBuffer({
  getMessages,
  setMessages,
  maxFlushAttempts = 24,
  retryDelayMs = 25,
  schedule = (fn, delayMs) => setTimeout(fn, delayMs),
}: CreateCortexPendingBufferParams) {
  const pendingByRunId = new Map<string, CortexPart[]>();

  const applyToMessage = (runId: string, cortexPart: CortexPart): boolean => {
    const messages = getMessages() ?? [];
    const responseIdx = findMessageIndex(messages, runId);
    if (responseIdx < 0) {
      return false;
    }

    const updatedMessages = [...messages];
    const response = { ...updatedMessages[responseIdx] } as TMessage & {
      __viventiumCortexParts?: CortexPart[];
    };
    const existing = response.__viventiumCortexParts ?? [];
    const cortexParts = Array.isArray(existing) ? [...existing] : [];
    upsertCortexPart(cortexParts, cortexPart);
    response.__viventiumCortexParts = cortexParts;
    updatedMessages[responseIdx] = response;
    setMessages(updatedMessages);
    return true;
  };

  const flushPending = (runId: string, attempt = 0): boolean => {
    const pending = pendingByRunId.get(runId);
    if (!pending || pending.length === 0) {
      return true;
    }

    const messages = getMessages() ?? [];
    const responseIdx = findMessageIndex(messages, runId);
    if (responseIdx < 0) {
      if (attempt >= maxFlushAttempts) {
        return false;
      }
      schedule(() => flushPending(runId, attempt + 1), retryDelayMs);
      return false;
    }

    const updatedMessages = [...messages];
    const response = { ...updatedMessages[responseIdx] } as TMessage & {
      __viventiumCortexParts?: CortexPart[];
    };
    const existing = response.__viventiumCortexParts ?? [];
    const cortexParts = Array.isArray(existing) ? [...existing] : [];
    for (const cortexPart of pending) {
      upsertCortexPart(cortexParts, cortexPart);
    }
    response.__viventiumCortexParts = cortexParts;
    updatedMessages[responseIdx] = response;
    setMessages(updatedMessages);
    pendingByRunId.delete(runId);
    return true;
  };

  const handleCortexUpdate = (runId: string, cortexPart: CortexPart): void => {
    if (applyToMessage(runId, cortexPart)) {
      return;
    }
    const pending = pendingByRunId.get(runId) ?? [];
    upsertCortexPart(pending, cortexPart);
    pendingByRunId.set(runId, pending);
    flushPending(runId, 0);
  };

  const handleCreated = (createdMessageId: string): void => {
    if (!createdMessageId) {
      return;
    }
    const runId = `${createdMessageId}_`;
    flushPending(runId, 0);
  };

  return {
    handleCortexUpdate,
    handleCreated,
    flushPending,
  };
}
