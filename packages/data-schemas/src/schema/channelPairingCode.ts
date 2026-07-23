/**
 * === VIVENTIUM START ===
 * Feature: Local-friendly channel pairing.
 * Purpose: Store only hashed, expiring, one-use admin pairing codes.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import { VIVENTIUM_CHANNEL_IDS } from '~/types/channel';
import type { IChannelPairingCode } from '~/types/channel';

const channelPairingCodeSchema = new Schema<IChannelPairingCode>(
  {
    tokenHash: { type: String, required: true },
    channel: { type: String, required: true, enum: VIVENTIUM_CHANNEL_IDS },
    accountId: { type: String, required: true, default: 'default' },
    libreChatUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

channelPairingCodeSchema.index({ tokenHash: 1 }, { unique: true });
channelPairingCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default channelPairingCodeSchema;
