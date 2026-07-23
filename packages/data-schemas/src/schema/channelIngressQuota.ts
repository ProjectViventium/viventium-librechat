/**
 * === VIVENTIUM START ===
 * Feature: Durable channel ingress quotas.
 * Purpose: Bound provider abuse by hashed external identity and fixed time window.
 * === VIVENTIUM END ===
 */
import { Schema } from 'mongoose';
import { VIVENTIUM_CHANNEL_IDS } from '~/types/channel';
import type { IChannelIngressQuota } from '~/types/channel';

const channelIngressQuotaSchema = new Schema<IChannelIngressQuota>(
  {
    quotaKey: { type: String, required: true, unique: true },
    channel: { type: String, required: true, enum: VIVENTIUM_CHANNEL_IDS },
    accountId: { type: String, required: true },
    identityHash: { type: String, required: true },
    tier: { type: String, required: true, enum: ['paired', 'unpaired'] },
    scope: { type: String, required: true, enum: ['identity', 'account'] },
    count: { type: Number, required: true, default: 0, min: 0 },
    eventKeys: { type: [String], required: true, default: [] },
    rejectedDedupeKey: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
channelIngressQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default channelIngressQuotaSchema;
