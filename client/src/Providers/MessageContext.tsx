import { createContext, useContext } from 'react';
import type { TAttachment } from 'librechat-data-provider';

type MessageContext = {
  messageId: string;
  nextType?: string;
  partIndex?: number;
  isExpanded: boolean;
  conversationId?: string | null;
  /** Submission state for cursor display - only true for latest message when submitting */
  isSubmitting?: boolean;
  /** Whether this is the latest message in the conversation */
  isLatestMessage?: boolean;
  /* === VIVENTIUM START ===
   * Feature: Exact rendered message-part identity for QA telemetry.
   * Purpose: Let the actual text DOM node expose its UI-only persisted identity and author.
   * === VIVENTIUM END === */
  viventiumPartId?: string;
  viventiumAgentId?: string;
  /** Verified message files are presentation bindings, never rewritten source text. */
  viventiumFileAttachments?: TAttachment[];
};

export const MessageContext = createContext<MessageContext>({} as MessageContext);
export const useMessageContext = () => useContext(MessageContext);

/* === VIVENTIUM START === Additive history must not take ownership of the next chat input. === */
export const MessageInputBranchContext = createContext(true);
/* === VIVENTIUM END === */
