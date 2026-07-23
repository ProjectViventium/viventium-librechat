/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral account linking.
 * Purpose: Own hashed, one-use, automatically expiring link tokens in the typed package.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import type { IGatewayLinkToken } from '~/types/channel';

const gatewayLinkTokenSchema = new Schema<IGatewayLinkToken>(
  {
    tokenHash: { type: String, required: true },
    channel: { type: String, required: true, index: true },
    accountId: { type: String, required: true, default: 'default', index: true },
    externalUserId: { type: String, required: true, index: true },
    externalUsername: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

gatewayLinkTokenSchema.index({ tokenHash: 1 }, { unique: true });
gatewayLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default gatewayLinkTokenSchema;
