/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral messaging persistence.
 * Purpose: Keep public channel identity, connection, thread, and replay state typed in one place.
 * === VIVENTIUM END ===
 */

import type { Types } from 'mongoose';

export const VIVENTIUM_CHANNEL_IDS = ['telegram', 'slack', 'whatsapp'] as const;
export const VIVENTIUM_CHANNEL_CONNECTION_STATES = [
  'not_configured',
  'needs_vendor_step',
  'verifying',
  'connected',
  'degraded',
  'reauth_required',
  'disconnected',
] as const;

export type ViventiumChannelId = (typeof VIVENTIUM_CHANNEL_IDS)[number];
export type ViventiumChannelConnectionState = (typeof VIVENTIUM_CHANNEL_CONNECTION_STATES)[number];

export interface IChannelConnection {
  channel: ViventiumChannelId;
  state: ViventiumChannelConnectionState;
  accountId: string;
  accountLabel?: string | null;
  displayName?: string | null;
  encryptedCredentials: string;
  callbackId: string;
  publicBaseUrl?: string | null;
  issueCode?: string | null;
  lastVerifiedAt?: Date | null;
  webhookVerifiedAt?: Date | null;
  webhookSignedVerifiedAt?: Date | null;
  configGeneration?: string | null;
  activeGeneration?: string | null;
  pendingEncryptedCredentials?: string | null;
  pendingCallbackId?: string | null;
  pendingAccountId?: string | null;
  pendingAccountLabel?: string | null;
  pendingDisplayName?: string | null;
  pendingConfigGeneration?: string | null;
  pendingWebhookVerifiedAt?: Date | null;
  createdBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelThread {
  channel: string;
  accountId: string;
  externalConversationId: string;
  externalThreadId: string;
  libreChatUserId: Types.ObjectId | string;
  conversationId: string;
  parentMessageId?: string | null;
  lastSeenAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGatewayUserMapping {
  channel: string;
  accountId: string;
  externalUserId: string;
  externalUsername?: string;
  libreChatUserId: Types.ObjectId | string;
  metadata?: Record<string, unknown>;
  linkedAt?: Date;
  lastSeenAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGatewayLinkToken {
  tokenHash: string;
  channel: string;
  accountId: string;
  externalUserId: string;
  externalUsername?: string;
  metadata?: Record<string, unknown>;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IViventiumGatewayIngressEvent {
  dedupeKey: string;
  channel: string;
  accountId: string;
  externalUserId: string;
  externalChatId?: string;
  externalMessageId?: string;
  externalUpdateId?: string;
  externalThreadId?: string;
  traceId?: string;
  conversationId?: string;
  streamId?: string;
  state?: 'reserved' | 'in_flight' | 'completed' | 'failed';
  ownerToken?: string;
  leaseExpiresAt?: Date;
  failureCode?: string | null;
  finalText?: string | null;
  responseMessageId?: string | null;
  responseConversationId?: string | null;
  libreChatUserId?: string;
  bindingVersion?: string;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelPairingCode {
  tokenHash: string;
  channel: ViventiumChannelId;
  accountId: string;
  libreChatUserId: Types.ObjectId | string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelPairingAttempt {
  scopeKey: string;
  attempts: number;
  windowExpiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelWorkerLease {
  channel: ViventiumChannelId;
  accountId: string;
  ownerId: string;
  configGeneration: string;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelDelivery {
  dedupeKey: string;
  channel: ViventiumChannelId;
  accountId: string;
  partitionKey: string;
  envelope?: Record<string, unknown> | null;
  state:
    | 'inbound_pending'
    | 'agent_processing'
    | 'reply_ready'
    | 'egress_sending'
    | 'completed'
    | 'delivery_uncertain'
    | 'cancelled';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date | null;
  lockToken?: string | null;
  replyText?: string | null;
  providerMessageId?: string | null;
  egressCursor?: number;
  lastErrorCode?: string | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IChannelIngressQuota {
  quotaKey: string;
  channel: ViventiumChannelId;
  accountId: string;
  identityHash: string;
  tier: 'paired' | 'unpaired';
  scope: 'identity' | 'account';
  count: number;
  eventKeys: string[];
  rejectedDedupeKey?: string | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
