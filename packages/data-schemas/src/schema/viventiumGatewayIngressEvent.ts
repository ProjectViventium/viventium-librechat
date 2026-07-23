/**
 * === VIVENTIUM START ===
 * Feature: Channel ingress idempotency.
 * Purpose: Own the legacy ViventiumGatewayIngressEvent schema in the typed package.
 * === VIVENTIUM END ===
 */

import { Schema } from 'mongoose';
import type { IViventiumGatewayIngressEvent } from '~/types/channel';

const viventiumGatewayIngressEventSchema = new Schema<IViventiumGatewayIngressEvent>(
  {
    dedupeKey: { type: String, required: true },
    channel: { type: String, required: true, index: true },
    accountId: { type: String, default: 'default', index: true },
    externalUserId: { type: String, required: true, index: true },
    externalChatId: { type: String, default: '' },
    externalMessageId: { type: String, default: '' },
    externalUpdateId: { type: String, default: '' },
    externalThreadId: { type: String, default: '' },
    traceId: { type: String, default: '' },
    conversationId: { type: String, default: '' },
    streamId: { type: String, default: '' },
    state: {
      type: String,
      enum: ['reserved', 'in_flight', 'completed', 'failed'],
      default: 'reserved',
    },
    ownerToken: { type: String, default: '' },
    leaseExpiresAt: { type: Date, required: true },
    failureCode: { type: String, default: null },
    finalText: { type: String, default: null },
    responseMessageId: { type: String, default: null },
    responseConversationId: { type: String, default: null },
    libreChatUserId: { type: String, required: true },
    bindingVersion: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

viventiumGatewayIngressEventSchema.index({ dedupeKey: 1 }, { unique: true });
viventiumGatewayIngressEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default viventiumGatewayIngressEventSchema;
