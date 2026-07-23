/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral messaging contract.
 * Purpose: Normalize untrusted adapter input and build only trusted Agents-controller requests.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import { isPrivateIP } from '../auth/domain';
import { CHANNEL_INPUT_MODES } from './types';
import type {
  ChannelAttachment,
  ChannelEnvelope,
  ChannelId,
  NormalizedConnectInput,
  ResolvedAgentRequest,
} from './types';

const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 200_000;

function readString(value: unknown, field: string, required = false): string {
  const normalized =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (required && normalized.length === 0) {
    throw new Error(`${field} is required`);
  }
  if (normalized.length > MAX_ID_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  return normalized;
}

function readSecret(value: unknown, field: string): string {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (secret.length === 0) {
    throw new Error(`${field} is required`);
  }
  if (secret.length > 8192) {
    throw new Error(`${field} is too long`);
  }
  return secret;
}

function readPublicHttpsOrigin(value: unknown): string | null {
  const candidate = readString(value, 'publicBaseUrl');
  if (!candidate) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('publicBaseUrl must be a valid HTTPS origin');
  }
  const parsedHostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostname = parsedHostname.replace(/\.+$/, '');
  if (hostname !== parsedHostname) {
    url.hostname = hostname;
  }
  const firstHextet = hostname.includes(':') ? Number.parseInt(hostname.split(':')[0], 16) : NaN;
  const localHostname =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isPrivateIP(hostname) ||
    /^(?:fe8|fe9|fea|feb)/i.test(hostname) ||
    (firstHextet >= 0xfec0 && firstHextet <= 0xfeff);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    localHostname
  ) {
    throw new Error('publicBaseUrl must be a public HTTPS origin without a path');
  }
  return url.origin;
}

function readChannel(value: unknown): string {
  const channel = readString(value, 'channel', true).toLowerCase();
  return channel;
}

function readAttachments(value: unknown): ChannelAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (attachment): attachment is ChannelAttachment =>
      attachment != null && typeof attachment === 'object' && !Array.isArray(attachment),
  );
}

export function normalizeChannelEnvelope(input: Record<string, unknown>): ChannelEnvelope {
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error('text is too long');
  }
  const requestedInputMode = typeof input.inputMode === 'string' ? input.inputMode : 'text';
  const inputMode = CHANNEL_INPUT_MODES.includes(
    requestedInputMode as (typeof CHANNEL_INPUT_MODES)[number],
  )
    ? (requestedInputMode as (typeof CHANNEL_INPUT_MODES)[number])
    : 'text';

  return {
    channel: readChannel(input.channel),
    accountId: readString(input.accountId, 'accountId') || 'default',
    externalUserId: readString(input.externalUserId, 'externalUserId', true),
    externalUsername: readString(input.externalUsername, 'externalUsername'),
    externalConversationId: readString(
      input.externalConversationId ?? input.externalChatId,
      'externalConversationId',
      true,
    ),
    externalThreadId: readString(input.externalThreadId, 'externalThreadId'),
    externalMessageId: readString(input.externalMessageId, 'externalMessageId'),
    externalUpdateId: readString(input.externalUpdateId, 'externalUpdateId'),
    inputMode,
    audioRequested: input.audioRequested === true,
    text,
    attachments: readAttachments(input.attachments ?? input.files),
  };
}

export function buildChannelDedupeKey(envelope: ChannelEnvelope): string {
  const scopedIdentity = [
    envelope.channel,
    envelope.accountId,
    envelope.externalUserId,
    envelope.externalConversationId,
    envelope.externalThreadId,
    envelope.externalMessageId,
    envelope.externalUpdateId,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(scopedIdentity)).digest('hex');
}

export function buildChannelAgentRequest({
  envelope,
  resolved,
}: {
  envelope: ChannelEnvelope;
  resolved: ResolvedAgentRequest;
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    text: envelope.text,
    endpoint: 'agents',
    endpointType: 'agents',
    conversationId: resolved.conversationId,
    parentMessageId: resolved.parentMessageId,
    agent_id: resolved.agentId,
    streamId: resolved.streamId,
    files: resolved.files ?? [],
    channel: envelope.channel,
    accountId: envelope.accountId,
    externalUserId: envelope.externalUserId,
    externalUsername: envelope.externalUsername,
    externalConversationId: envelope.externalConversationId,
    externalThreadId: envelope.externalThreadId,
    externalMessageId: envelope.externalMessageId,
    externalUpdateId: envelope.externalUpdateId,
    viventiumSurface: envelope.channel,
    viventiumInputMode: envelope.inputMode,
    audioRequested: envelope.audioRequested,
  };
  if (resolved.spec) {
    request.spec = resolved.spec;
  }
  return request;
}

export function normalizeChannelConnectInput(
  channel: ChannelId,
  input: Record<string, unknown>,
): NormalizedConnectInput {
  const accountLabel = readString(input.accountLabel, 'accountLabel') || null;
  if (channel === 'telegram') {
    return {
      credentials: {
        botToken: readSecret(input.botToken, 'botToken'),
        dmPolicy: 'PAIRING',
      },
      accountLabel,
      publicBaseUrl: null,
      state: 'verifying',
    };
  }
  if (channel === 'slack') {
    const appToken = readSecret(input.appToken, 'appToken');
    const botToken = readSecret(input.botToken, 'botToken');
    if (!appToken.startsWith('xapp-')) {
      throw new Error('appToken must start with xapp-');
    }
    if (!botToken.startsWith('xoxb-')) {
      throw new Error('botToken must start with xoxb-');
    }
    return {
      credentials: { appToken, botToken },
      accountLabel,
      publicBaseUrl: null,
      state: 'verifying',
    };
  }

  if (input.webhookUrl != null && input.webhookUrl !== '') {
    throw new Error('webhookUrl is server-managed and must not be provided');
  }
  return {
    credentials: {
      phoneNumberId: readSecret(input.phoneNumberId, 'phoneNumberId'),
      businessAccountId: readSecret(input.businessAccountId, 'businessAccountId'),
      accessToken: readSecret(input.accessToken, 'accessToken'),
      appSecret: readSecret(input.appSecret, 'appSecret'),
      verifyToken: readSecret(input.verifyToken, 'verifyToken'),
    },
    accountLabel,
    publicBaseUrl: readPublicHttpsOrigin(input.publicBaseUrl),
    state: 'verifying',
  };
}

export function resolveTrustedCallbackUrl(
  trustedPublicApiUrl: string | undefined,
  callbackId: string,
): string | undefined {
  if (!trustedPublicApiUrl) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trustedPublicApiUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return undefined;
  }
  return `${url.origin}/api/viventium/channels/whatsapp/webhook/${encodeURIComponent(callbackId)}`;
}

export function resolveLoopbackGatewayUrl(value: string | undefined, port = 3080): string {
  const fallback = `http://127.0.0.1:${port}`;
  if (!value) {
    return fallback;
  }
  try {
    const url = new URL(value);
    const loopbackHost = ['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname);
    if (
      !loopbackHost ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return fallback;
    }
    return url.origin;
  } catch {
    return fallback;
  }
}
