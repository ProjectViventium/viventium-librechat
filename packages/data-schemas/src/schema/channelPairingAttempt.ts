/**
 * === VIVENTIUM START ===
 * Feature: Channel pairing brute-force protection.
 * Purpose: Persist bounded attempt windows across restarts and worker processes.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import type { IChannelPairingAttempt } from '~/types/channel';

const channelPairingAttemptSchema = new Schema<IChannelPairingAttempt>(
  {
    scopeKey: { type: String, required: true },
    attempts: { type: Number, required: true, min: 1 },
    windowExpiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

channelPairingAttemptSchema.index({ scopeKey: 1 }, { unique: true });
channelPairingAttemptSchema.index({ windowExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default channelPairingAttemptSchema;
