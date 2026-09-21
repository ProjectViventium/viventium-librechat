import type { Document } from 'mongoose';
import type { IAcceptedMainContext } from './mainContinuityState';
import type { SavedMemoryWrite } from './memoryWrite';
import type { NativeResponseAdmission } from './nativeResponse';
import type { TFeedbackRating, TFeedbackTag } from 'librechat-data-provider';
import type { IPersonalAccountCleanupTombstone } from './personalAccountCleanupTombstone';

export type MemoryWriteStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ISavedMemoryWrite {
  owner: string;
  status: MemoryWriteStatus;
  admittedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  heartbeatAt?: Date;
}

// @ts-ignore
export interface IMessage extends Document {
  messageId: string;
  conversationId: string;
  user: string;
  model?: string;
  endpoint?: string;
  conversationSignature?: string;
  clientId?: string;
  invocationId?: number;
  parentMessageId?: string;
  tokenCount?: number;
  summaryTokenCount?: number;
  sender?: string;
  text?: string;
  summary?: string;
  isCreatedByUser: boolean;
  unfinished?: boolean;
  error?: boolean;
  finish_reason?: string;
  feedback?: {
    rating: TFeedbackRating;
    tag: TFeedbackTag | undefined;
    text?: string;
  };
  _meiliIndex?: boolean;
  files?: unknown[];
  plugin?: {
    latest?: string;
    inputs?: unknown[];
    outputs?: string;
  };
  plugins?: unknown[];
  content?: unknown[];
  thread_id?: string;
  iconURL?: string;
  addedConvo?: boolean;
  metadata?: Record<string, unknown>;
  savedMemoryWrite?: SavedMemoryWrite;
  nativeResponse?: NativeResponseAdmission;
  acceptedMainContext?: IAcceptedMainContext;
  attachments?: unknown[];
  expiredAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  /* === VIVENTIUM START === Retained synthetic-QA cleanup CAS state. === */
  deletedAt?: Date;
  cleanupTombstone?: IPersonalAccountCleanupTombstone;
  /* === VIVENTIUM END === */
}
