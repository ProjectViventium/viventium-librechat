/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral linked identities.
 * Purpose: Own the legacy GatewayUserMapping schema in the typed persistence package.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import type { IGatewayUserMapping } from '~/types/channel';

const gatewayUserMappingSchema = new Schema<IGatewayUserMapping>(
  {
    channel: { type: String, required: true, index: true },
    accountId: { type: String, required: true, default: 'default', index: true },
    externalUserId: { type: String, required: true, index: true },
    externalUsername: { type: String, default: '' },
    libreChatUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    linkedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

gatewayUserMappingSchema.index({ channel: 1, accountId: 1, externalUserId: 1 }, { unique: true });

export default gatewayUserMappingSchema;
