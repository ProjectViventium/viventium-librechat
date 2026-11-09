import type { NativeResponseAdmission, NativeResponseIdentity } from '@librechat/data-schemas';
import type { NativeResult } from './nativeResponse';

export interface NativeHistoryBudgetReceipt {
  version: 1;
  model_id: string;
  stable_authority_sha256: string;
  native_context_epoch: string;
  replay_budget_bytes: number;
}

export interface ScopedNativeHistoryBudget {
  providerId: string;
  modelId: string;
  budgetBytes: number;
}

/** Observe the existing authenticated result owner; this neither admits work nor omits source. */
export async function readNativeConversationHistoryBudget(input: {
  ownerId: string;
  conversationId: string;
  agentId: string;
  contextEpoch: string;
  modelId: string;
  messages: ReadonlyArray<{
    messageId?: string;
    isCreatedByUser?: boolean;
    error?: boolean;
    unfinished?: boolean;
  }>;
  readAdmission: (ownerId: string, messageId: string) => Promise<NativeResponseAdmission | null>;
  readResult: (identity: NativeResponseIdentity) => Promise<NativeResult | null>;
  signal?: AbortSignal;
}): Promise<ScopedNativeHistoryBudget | null> {
  if (
    !input.ownerId ||
    !input.conversationId ||
    !input.agentId ||
    !input.contextEpoch ||
    !input.modelId
  ) {
    return null;
  }
  const signal = input.signal;
  const read = async (): Promise<ScopedNativeHistoryBudget | null> => {
    for (let index = input.messages.length - 1; index >= 0; index--) {
      const message = input.messages[index];
      if (
        message.isCreatedByUser !== false ||
        !message.messageId ||
        message.error === true ||
        message.unfinished === true
      )
        continue;
      signal?.throwIfAborted();
      const identity = await input.readAdmission(input.ownerId, message.messageId);
      signal?.throwIfAborted();
      if (
        !identity ||
        identity.status !== 'completed' ||
        identity.userId !== input.ownerId ||
        identity.conversationId !== input.conversationId ||
        identity.agentId !== input.agentId ||
        identity.responseMessageId !== message.messageId
      )
        continue;
      const result = await input.readResult(identity);
      signal?.throwIfAborted();
      const receipt = result?.native_history_budget_v1;
      if (
        !result ||
        result.version !== 1 ||
        result.object !== 'glasshive.request.result' ||
        result.invocation_id !== identity.invocationId ||
        result.stream_id !== identity.streamId ||
        result.message_id !== identity.responseMessageId ||
        result.body_sha256 !== identity.bodySha256 ||
        result.agent_id !== identity.agentId ||
        result.conversation_id !== identity.conversationId ||
        receipt?.version !== 1 ||
        receipt.stable_authority_sha256 !== input.contextEpoch ||
        receipt.model_id !== input.modelId ||
        !Number.isSafeInteger(receipt.replay_budget_bytes) ||
        receipt.replay_budget_bytes <= 0
      ) {
        return null;
      }
      return {
        providerId: identity.providerId,
        modelId: receipt.model_id,
        budgetBytes: receipt.replay_budget_bytes,
      };
    }
    return null;
  };
  let onAbort = () => {};
  const stopped = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([read(), stopped]);
  } catch {
    return null;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
