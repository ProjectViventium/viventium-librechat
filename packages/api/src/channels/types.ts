/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral messaging.
 * Purpose: Stable backend contracts shared by admin APIs, adapters, and the Agents request seam.
 * === VIVENTIUM END ===
 */

export const CHANNEL_IDS = ['telegram', 'slack', 'whatsapp'] as const;
export const CHANNEL_INPUT_MODES = ['text', 'voice', 'voice_note', 'voice_call'] as const;
export const CHANNEL_CONNECTION_STATES = [
  'not_configured',
  'needs_vendor_step',
  'verifying',
  'connected',
  'degraded',
  'reauth_required',
  'disconnected',
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];
export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];
export type ChannelCredentials = Record<string, string>;
export type ChannelAttachment = Record<string, unknown>;

export type ChannelEnvelope = {
  /** Provider namespace. The legacy generic gateway also accepts third-party adapters. */
  channel: string;
  accountId: string;
  externalUserId: string;
  externalUsername: string;
  externalConversationId: string;
  externalThreadId: string;
  externalMessageId: string;
  externalUpdateId: string;
  inputMode: (typeof CHANNEL_INPUT_MODES)[number];
  audioRequested: boolean;
  text: string;
  attachments: ChannelAttachment[];
  pairingContext?: 'private' | 'public';
  authorizationSnapshot?: {
    kind: 'pairing' | 'unpaired' | 'paired';
    libreChatUserId?: string;
    bindingVersion?: string;
    pairingTokenHash?: string;
  };
};

export type ResolvedAgentRequest = {
  agentId: string;
  conversationId: string;
  parentMessageId: string;
  streamId: string;
  files?: ReadonlyArray<Record<string, unknown>>;
  spec?: string;
};

export type ChannelSummary = {
  channel: ChannelId;
  state: ChannelConnectionState;
  displayName?: string;
  issueCode?: string;
  callbackUrl?: string;
};

export type NormalizedConnectInput = {
  credentials: ChannelCredentials;
  accountLabel: string | null;
  publicBaseUrl: string | null;
  state: 'verifying';
};

export type ChannelConnectionRuntime = {
  channel: ChannelId;
  accountId: string;
  credentials: ChannelCredentials;
  /** Opaque persisted generation used to fence cross-process credential replacement. */
  configGeneration?: string;
};

export type ChannelTransportStartOptions = {
  mode?: 'reconcile' | 'replace';
};

export type ChannelOutboundMessage = {
  channel: ChannelId;
  accountId: string;
  externalConversationId: string;
  externalThreadId: string;
  text: string;
  attachments?: ReadonlyArray<ChannelAttachment>;
};

export type ChannelIngressResult = {
  text: string;
  linkUrl?: string;
};

export type ChannelIngressHandler = (envelope: ChannelEnvelope) => Promise<ChannelIngressResult>;

export type ChannelTransportTestResult = {
  ok: boolean;
  displayName?: string;
  issueCode?: string;
  accountId?: string;
};

export interface ChannelTransport {
  channel: ChannelId;
  /** False means another process owns activation; callers must not claim Connected. */
  start(
    connection: ChannelConnectionRuntime,
    options?: ChannelTransportStartOptions,
  ): Promise<boolean | void>;
  /** Stops only the named generation when supplied, so stale lifecycle work cannot stop a replacement. */
  stop(accountId: string, expectedGeneration?: string): Promise<void>;
  test(connection: ChannelConnectionRuntime): Promise<ChannelTransportTestResult>;
  send(message: ChannelOutboundMessage): Promise<void>;
}
