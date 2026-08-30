import { Schema } from 'mongoose';
import { conversationPreset } from './defaults';
import { IConversation } from '~/types';
import {
  applyPersonalAccountCleanupVisibility,
  personalAccountCleanupTombstoneSchema,
} from './personalAccountCleanupTombstone';

const convoSchema: Schema<IConversation> = new Schema(
  {
    conversationId: {
      type: String,
      unique: true,
      required: true,
      index: true,
      meiliIndex: true,
    },
    title: {
      type: String,
      default: 'New Chat',
      meiliIndex: true,
    },
    user: {
      type: String,
      index: true,
      meiliIndex: true,
    },
    messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    ...conversationPreset,
    agent_id: {
      type: String,
    },
    tags: {
      type: [String],
      default: [],
      meiliIndex: true,
    },
    files: {
      type: [String],
    },
    expiredAt: {
      type: Date,
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

/* === VIVENTIUM START === Tombstones are internal CAS state, never ordinary conversation history. === */
applyPersonalAccountCleanupVisibility(convoSchema);
/* === VIVENTIUM END === */

convoSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
convoSchema.index({ createdAt: 1, updatedAt: 1 });
convoSchema.index({ conversationId: 1, user: 1 }, { unique: true });

// index for MeiliSearch sync operations
convoSchema.index({ _meiliIndex: 1, expiredAt: 1 });

export default convoSchema;
