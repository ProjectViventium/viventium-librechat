/**
 * === VIVENTIUM START ===
 * Feature: Durable channel delivery.
 * Purpose: Persist accepted provider turns until Agent processing and provider egress complete.
 * === VIVENTIUM END ===
 */
import { Schema } from 'mongoose';
import { VIVENTIUM_CHANNEL_IDS } from '~/types/channel';
import type { IChannelDelivery } from '~/types/channel';

const channelDeliverySchema = new Schema<IChannelDelivery>(
  {
    dedupeKey: { type: String, required: true },
    channel: { type: String, required: true, enum: VIVENTIUM_CHANNEL_IDS },
    accountId: { type: String, required: true },
    partitionKey: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, default: null },
    state: {
      type: String,
      enum: [
        'inbound_pending',
        'agent_processing',
        'reply_ready',
        'egress_sending',
        'completed',
        'delivery_uncertain',
        'cancelled',
      ],
      default: 'inbound_pending',
    },
    attempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    lockedUntil: { type: Date, default: null },
    lockToken: { type: String, default: null },
    replyText: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    egressCursor: { type: Number, min: 0, default: 0 },
    lastErrorCode: { type: String, default: null, maxlength: 120 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
channelDeliverySchema.index({ dedupeKey: 1 }, { unique: true });
channelDeliverySchema.index({ channel: 1, accountId: 1, partitionKey: 1, createdAt: 1, _id: 1 });
channelDeliverySchema.index({ channel: 1, accountId: 1, state: 1, nextAttemptAt: 1 });
channelDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default channelDeliverySchema;
