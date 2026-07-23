/**
 * === VIVENTIUM START ===
 * Feature: Connected channel administration.
 * Purpose: Persist encrypted server-owned provider connections for restart recovery.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import { VIVENTIUM_CHANNEL_CONNECTION_STATES, VIVENTIUM_CHANNEL_IDS } from '~/types/channel';
import type { IChannelConnection } from '~/types/channel';

const channelConnectionSchema = new Schema<IChannelConnection>(
  {
    channel: { type: String, required: true, enum: VIVENTIUM_CHANNEL_IDS },
    state: {
      type: String,
      required: true,
      enum: VIVENTIUM_CHANNEL_CONNECTION_STATES,
      default: 'not_configured',
    },
    accountId: { type: String, required: true, default: 'default' },
    accountLabel: { type: String, default: null, maxlength: 200 },
    displayName: { type: String, default: null, maxlength: 200 },
    encryptedCredentials: { type: String, required: true, select: false },
    callbackId: { type: String, required: true },
    publicBaseUrl: { type: String, default: null, maxlength: 2048 },
    issueCode: { type: String, default: null, maxlength: 120 },
    lastVerifiedAt: { type: Date, default: null },
    webhookVerifiedAt: { type: Date, default: null },
    webhookSignedVerifiedAt: { type: Date, default: null },
    configGeneration: { type: String, default: null, maxlength: 128 },
    activeGeneration: { type: String, default: null, maxlength: 128 },
    pendingEncryptedCredentials: { type: String, default: null, select: false },
    pendingCallbackId: { type: String, default: null },
    pendingAccountId: { type: String, default: null, maxlength: 200 },
    pendingAccountLabel: { type: String, default: null, maxlength: 200 },
    pendingDisplayName: { type: String, default: null, maxlength: 200 },
    pendingConfigGeneration: { type: String, default: null, maxlength: 128 },
    pendingWebhookVerifiedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

channelConnectionSchema.index({ channel: 1 }, { unique: true });
channelConnectionSchema.index({ callbackId: 1 }, { unique: true });
channelConnectionSchema.index(
  { pendingCallbackId: 1 },
  { unique: true, partialFilterExpression: { pendingCallbackId: { $type: 'string' } } },
);

export default channelConnectionSchema;
