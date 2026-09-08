/* === VIVENTIUM START === Internal saved-memory work anchored to its existing assistant message. === */
export interface MemoryWriteSource {
  digest: string;
  configDigest: string;
  messageIds: string[];
  messageDigests?: Record<string, string>;
  /** Exact trusted provenance for inspection; never reconstructed as request authority. */
  interactionContextJson?: string;
  /** Temporary recovery input. It is erased with every terminal outcome, never exposed publicly. */
  input?: string;
  timeContext?: string;
  agentDigest?: string;
  /** CAS floor captured before admission; includes tombstones and no memory values. */
  memoryRevisionMap?: Record<string, number>;
}

export interface SavedMemoryWrite {
  owner: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source: MemoryWriteSource;
  admittedAt: Date;
  heartbeatAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface MemoryWriterEffect {
  messageId: string;
  owner: string;
  operationId: string;
}

export interface MemoryWriteIdentity {
  userId: string;
  messageId: string;
  owner: string;
}

export interface MemoryWriteReceipt {
  type: string;
  messageId?: string;
  conversationId?: string;
  memory?: { type: string; key?: string; value?: string; tokenCount?: number; revision?: number;
    errorType?: string; partialApplied?: boolean; message?: string };
}
