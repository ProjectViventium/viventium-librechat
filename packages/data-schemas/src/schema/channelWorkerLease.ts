/**
 * === VIVENTIUM START ===
 * Feature: Distributed channel worker ownership.
 * Purpose: Ensure only one server process consumes a provider account at a time.
 * === VIVENTIUM END ===
 */
import { Schema } from 'mongoose';
import { VIVENTIUM_CHANNEL_IDS } from '~/types/channel';
import type { IChannelWorkerLease } from '~/types/channel';

const channelWorkerLeaseSchema = new Schema<IChannelWorkerLease>(
  {
    channel: { type: String, required: true, enum: VIVENTIUM_CHANNEL_IDS },
    accountId: { type: String, required: true },
    ownerId: { type: String, required: true },
    configGeneration: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
channelWorkerLeaseSchema.index({ channel: 1, accountId: 1 }, { unique: true });
channelWorkerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default channelWorkerLeaseSchema;
