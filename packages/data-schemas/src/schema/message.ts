import mongoose, { Schema } from 'mongoose';
import type { IMessage } from '~/types/message';
import type { IAcceptedMainContext } from '~/types/mainContinuityState';
import type { SavedMemoryWrite } from '~/types/memoryWrite';
import {
  applyPersonalAccountCleanupVisibility,
  personalAccountCleanupTombstoneSchema,
} from './personalAccountCleanupTombstone';

const messageSchema: Schema<IMessage> = new Schema(
  {
    messageId: {
      type: String,
      unique: true,
      required: true,
      index: true,
      meiliIndex: true,
    },
    conversationId: {
      type: String,
      index: true,
      required: true,
      meiliIndex: true,
    },
    user: {
      type: String,
      index: true,
      required: true,
      default: null,
      meiliIndex: true,
    },
    model: {
      type: String,
      default: null,
    },
    endpoint: {
      type: String,
    },
    conversationSignature: {
      type: String,
    },
    clientId: {
      type: String,
    },
    invocationId: {
      type: Number,
    },
    parentMessageId: {
      type: String,
    },
    tokenCount: {
      type: Number,
    },
    summaryTokenCount: {
      type: Number,
    },
    sender: {
      type: String,
      meiliIndex: true,
    },
    text: {
      type: String,
      meiliIndex: true,
    },
    summary: {
      type: String,
    },
    isCreatedByUser: {
      type: Boolean,
      required: true,
      default: false,
    },
    unfinished: {
      type: Boolean,
      default: false,
    },
    error: {
      type: Boolean,
      default: false,
    },
    finish_reason: {
      type: String,
    },
    feedback: {
      type: {
        rating: {
          type: String,
          enum: ['thumbsUp', 'thumbsDown'],
          required: true,
        },
        tag: {
          type: mongoose.Schema.Types.Mixed,
          required: false,
        },
        text: {
          type: String,
          required: false,
        },
      },
      default: undefined,
      required: false,
    },
    _meiliIndex: {
      type: Boolean,
      required: false,
      select: false,
      default: false,
    },
    files: { type: [{ type: mongoose.Schema.Types.Mixed }], default: undefined },
    content: {
      type: [{ type: mongoose.Schema.Types.Mixed }],
      default: undefined,
      meiliIndex: true,
    },
    thread_id: {
      type: String,
    },
    /* frontend components */
    iconURL: {
      type: String,
    },
    metadata: { type: mongoose.Schema.Types.Mixed },
    /* === VIVENTIUM START === Internal admission is excluded from normal message/API reads. === */
    savedMemoryWrite: {
      type: new Schema<SavedMemoryWrite>({
        owner: { type: String, required: true },
        status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], required: true },
        source: { digest: String, configDigest: String, messageIds: [String], interactionContextJson: String,
          input: String, timeContext: String, agentDigest: String,
          messageDigests: { type: Schema.Types.Mixed },
          memoryRevisionMap: { type: Schema.Types.Mixed } },
        admittedAt: Date, heartbeatAt: Date, startedAt: Date, finishedAt: Date,
      }, { _id: false, minimize: false }),
      select: false,
      default: undefined,
    },
    nativeResponse: { type: Schema.Types.Mixed, select: false, default: undefined },
    acceptedMainContext: {
      type: new Schema<IAcceptedMainContext>({
        continuityDomainId: { type: String, required: true },
        logicalTurnId: { type: String, required: true },
        revision: { type: Number, required: true, min: 1 },
        committedAt: { type: Date, required: true },
        position: { type: Number, min: 1 },
        supersededAt: Date,
        sourceDeletedAt: Date,
      }, { _id: false }),
      select: false, default: undefined,
    },
    /* === VIVENTIUM END === */
    attachments: { type: [{ type: mongoose.Schema.Types.Mixed }], default: undefined },
    /*
    attachments: {
      type: [
        {
          file_id: String,
          filename: String,
          filepath: String,
          expiresAt: Date,
          width: Number,
          height: Number,
          type: String,
          conversationId: String,
          messageId: {
            type: String,
            required: true,
          },
          toolCallId: String,
        },
      ],
      default: undefined,
    },
    */
    expiredAt: {
      type: Date,
    },
    addedConvo: {
      type: Boolean,
      default: undefined,
    },
    /* === VIVENTIUM START === Retained, owner-bound synthetic-QA cleanup tombstone. === */
    deletedAt: {
      type: Date,
      default: undefined,
      index: true,
    },
    cleanupTombstone: {
      type: personalAccountCleanupTombstoneSchema,
      default: undefined,
    },
    /* === VIVENTIUM END === */
  },
  { timestamps: true },
);

/* === VIVENTIUM START === Tombstones are internal CAS state, never ordinary message history. === */
applyPersonalAccountCleanupVisibility(messageSchema);
/* === VIVENTIUM END === */

messageSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
messageSchema.index({ createdAt: 1 });
messageSchema.index({ messageId: 1, user: 1 }, { unique: true });
/* === VIVENTIUM START === Sparse, non-unique recovery lookup; ordinary messages have no admission. === */
messageSchema.index({ 'savedMemoryWrite.status': 1, 'savedMemoryWrite.heartbeatAt': 1 },
  { sparse: true, name: 'viventium_saved_memory_recovery' });
messageSchema.index({ 'nativeResponse.status': 1, 'nativeResponse.admittedAt': 1 },
  { sparse: true, name: 'viventium_native_response_recovery' });
messageSchema.index({ user: 1, 'nativeResponse.source.id': 1 },
  { sparse: true, name: 'viventium_native_response_source' });
/* === VIVENTIUM START ===
 * Feature: Listen-Only Mode
 * Purpose: Support deterministic latest-message lookup and tail repair by conversation.
 * === VIVENTIUM END === */
messageSchema.index({ user: 1, conversationId: 1, createdAt: -1, _id: -1 });

// index for MeiliSearch sync operations
messageSchema.index({ _meiliIndex: 1, expiredAt: 1 });

/* === VIVENTIUM START === Existing Message owns provider-neutral Main projection identity. === */
messageSchema.index({ user: 1, 'acceptedMainContext.continuityDomainId': 1, 'acceptedMainContext.logicalTurnId': 1, 'acceptedMainContext.revision': -1 }, { sparse: true });
messageSchema.index({ user: 1, 'acceptedMainContext.continuityDomainId': 1, 'acceptedMainContext.position': 1 }, { sparse: true });
/* === VIVENTIUM END === */

export default messageSchema;
