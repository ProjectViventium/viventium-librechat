/**
 * === VIVENTIUM START ===
 * Feature: Channel conversation continuity.
 * Purpose: Persist external-thread to LibreChat-thread state across worker/server restarts.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import type { IChannelThread } from '~/types/channel';

const channelThreadSchema = new Schema<IChannelThread>(
  {
    channel: { type: String, required: true },
    accountId: { type: String, required: true, default: 'default' },
    externalConversationId: { type: String, required: true },
    externalThreadId: { type: String, required: true, default: '' },
    libreChatUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: String, required: true },
    parentMessageId: { type: String, default: null },
    lastSeenAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

channelThreadSchema.index(
  {
    channel: 1,
    accountId: 1,
    externalConversationId: 1,
    externalThreadId: 1,
    libreChatUserId: 1,
  },
  { unique: true },
);

export default channelThreadSchema;
