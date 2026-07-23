/**
 * === VIVENTIUM START ===
 * Feature: Channel-to-AgentController courier.
 * Purpose: Route every provider turn through the existing authenticated gateway and Agents stack.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import type { ChannelEnvelope, ChannelIngressHandler, ChannelIngressResult } from './types';

type GatewayClientOptions = {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
  randomNonce?: () => string;
  conversationStore?: ChannelConversationStore;
  chatTimeoutMs?: number;
  streamTimeoutMs?: number;
};

export interface ChannelConversationStore {
  load(envelope: ChannelEnvelope): Promise<string | undefined>;
  save(envelope: ChannelEnvelope, conversationId: string): Promise<void>;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readResponseText(payload: Record<string, unknown>): string {
  if (payload.final !== true && payload.type !== 'final') {
    return '';
  }
  const responseMessage = asRecord(payload.responseMessage);
  if (typeof responseMessage?.text === 'string' && responseMessage.text.trim()) {
    return responseMessage.text.trim();
  }
  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

function readDeltaText(payload: Record<string, unknown>): string {
  if (payload.type === 'final' || payload.final === true) {
    return '';
  }
  if (typeof payload.text === 'string') {
    return payload.text;
  }
  const data = asRecord(payload.data);
  const delta = asRecord(data?.delta);
  const content = delta?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const record = asRecord(part);
      if (typeof record?.text === 'string') {
        return record.text;
      }
      const textRecord = asRecord(record?.text);
      return typeof textRecord?.value === 'string' ? textRecord.value : '';
    })
    .join('');
}

export function extractGatewaySseText(streamText: string): string {
  const deltas: string[] = [];
  let finalText = '';
  for (const block of streamText.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const record = asRecord(payload);
    if (!record) {
      continue;
    }
    finalText = readResponseText(record) || finalText;
    const delta = readDeltaText(record);
    if (delta) {
      deltas.push(delta);
    }
  }
  return finalText || deltas.join('').trim();
}

function extractGatewayConversationId(streamText: string): string {
  let conversationId = '';
  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    try {
      const payload = asRecord(JSON.parse(line.slice('data:'.length).trimStart()));
      const responseMessage = asRecord(payload?.responseMessage);
      const candidate = responseMessage?.conversationId ?? payload?.conversationId;
      if (typeof candidate === 'string' && candidate && candidate !== 'new') {
        conversationId = candidate;
      }
    } catch {
      // Ignore malformed/non-JSON SSE events while preserving valid terminal events.
    }
  }
  return conversationId;
}

function readGatewayStreamOutcome(streamText: string): { final: boolean; error: boolean } {
  let final = false;
  let error = false;
  for (const block of streamText.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.some((line) => line.trim() === 'event: error')) {
      error = true;
    }
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    try {
      const payload = asRecord(JSON.parse(data));
      if (payload?.type === 'final' || payload?.final === true) {
        final = true;
      }
      if (payload?.type === 'error' || typeof payload?.error === 'string') {
        error = true;
      }
    } catch {
      // Malformed events do not count as successful terminal proof.
    }
  }
  return { final, error };
}

function gatewayStreamContainsAttachment(streamText: string): boolean {
  for (const block of streamText.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.some((line) => line.trim() === 'event: attachment')) {
      return true;
    }
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    try {
      const payload = asRecord(JSON.parse(data));
      const responseMessage = asRecord(payload?.responseMessage);
      if (
        (Array.isArray(payload?.attachments) && payload.attachments.length > 0) ||
        (Array.isArray(responseMessage?.attachments) && responseMessage.attachments.length > 0) ||
        (Array.isArray(payload?.files) && payload.files.length > 0) ||
        (Array.isArray(responseMessage?.files) && responseMessage.files.length > 0)
      ) {
        return true;
      }
    } catch {
      // Malformed events are ignored; a valid attachment event remains authoritative.
    }
  }
  return false;
}

export class ChannelGatewayClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;
  private readonly randomNonce: () => string;
  private readonly conversationStore?: ChannelConversationStore;
  private readonly chatTimeoutMs: number;
  private readonly streamTimeoutMs: number;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.secret = options.secret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.randomNonce = options.randomNonce ?? (() => crypto.randomUUID());
    this.conversationStore = options.conversationStore;
    this.chatTimeoutMs = options.chatTimeoutMs ?? 30_000;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 300_000;
    if (!this.baseUrl || !this.secret) {
      throw new Error('Channel gateway URL and secret are required');
    }
  }

  private async fetchWithTimeout<T>(
    input: string,
    init: RequestInit,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
  ): Promise<{ response: Response; value: T }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
      return { response, value: await read(response) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Viventium channel request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private signedHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = String(this.nowSeconds());
    const nonce = this.randomNonce();
    const bodyHash = sha256Hex(body);
    const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('.');
    const signature = crypto.createHmac('sha256', this.secret).update(canonical).digest('hex');
    return {
      'content-type': 'application/json',
      'x-viventium-gateway-secret': this.secret,
      'x-viventium-gateway-timestamp': timestamp,
      'x-viventium-gateway-nonce': nonce,
      'x-viventium-gateway-signature': signature,
    };
  }

  private buildChatBody(
    envelope: ChannelEnvelope,
    conversationId?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
      externalUsername: envelope.externalUsername,
      externalChatId: envelope.externalConversationId,
      externalConversationId: envelope.externalConversationId,
      externalThreadId: envelope.externalThreadId,
      externalMessageId: envelope.externalMessageId,
      externalUpdateId: envelope.externalUpdateId,
      text: envelope.text,
      attachments: envelope.attachments,
      viventiumInputMode: envelope.inputMode,
      audioRequested: envelope.audioRequested,
    };
    if (envelope.authorizationSnapshot?.kind === 'paired') {
      body.acceptedLibreChatUserId = envelope.authorizationSnapshot.libreChatUserId;
      body.acceptedBindingVersion = envelope.authorizationSnapshot.bindingVersion;
    }
    if (conversationId) {
      body.conversationId = conversationId;
    }
    return body;
  }

  readonly handle: ChannelIngressHandler = async (envelope): Promise<ChannelIngressResult> => {
    const chatPath = '/api/viventium/gateway/chat';
    const priorConversationId = await this.conversationStore?.load(envelope);
    const body = JSON.stringify(this.buildChatBody(envelope, priorConversationId));
    const chatResult = await this.fetchWithTimeout(
      `${this.baseUrl}${chatPath}`,
      {
        method: 'POST',
        headers: this.signedHeaders('POST', chatPath, body),
        body,
      },
      this.chatTimeoutMs,
      async (response) => await response.json().catch(() => null),
    );
    const chatResponse = chatResult.response;
    const chatPayload = asRecord(chatResult.value);
    if (chatResponse.status === 401 && chatPayload?.linkRequired === true) {
      return {
        text: 'This channel is not paired yet. In Viventium, open Settings > Channels, create your own pairing code, then send it here in a private message as /pair CODE. Never share the code.',
      };
    }
    if (!chatResponse.ok || !chatPayload) {
      throw new Error('Viventium could not start this channel turn');
    }
    const streamId = typeof chatPayload.streamId === 'string' ? chatPayload.streamId : '';
    if (!streamId) {
      throw new Error('Viventium channel response did not include a stream');
    }

    const streamPath = `/api/viventium/gateway/stream/${encodeURIComponent(streamId)}`;
    const query = new URLSearchParams({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
      externalChatId: envelope.externalConversationId,
    });
    const streamResult = await this.fetchWithTimeout(
      `${this.baseUrl}${streamPath}?${query}`,
      {
        method: 'GET',
        headers: this.signedHeaders('GET', streamPath, JSON.stringify({})),
      },
      this.streamTimeoutMs,
      async (response) => await response.text(),
    );
    const streamResponse = streamResult.response;
    if (!streamResponse.ok) {
      throw new Error('Viventium channel response stream failed');
    }
    const streamText = streamResult.value;
    const text = extractGatewaySseText(streamText);
    const containsAttachment = gatewayStreamContainsAttachment(streamText);
    const outcome = readGatewayStreamOutcome(streamText);
    if (outcome.error) {
      throw new Error('Viventium channel response stream failed');
    }
    if (!outcome.final) {
      throw new Error('Viventium channel response stream was incomplete');
    }
    const conversationId =
      extractGatewayConversationId(streamText) ||
      (typeof chatPayload.conversationId === 'string' && chatPayload.conversationId !== 'new'
        ? chatPayload.conversationId
        : '');
    if (conversationId) {
      await this.conversationStore?.save(envelope, conversationId);
    }
    return {
      text:
        (text && containsAttachment
          ? `${text}\n\nI also created a file. Open Viventium to view or download it.`
          : text) ||
        'I completed that request, but this channel cannot display the response. Open Viventium to view it.',
    };
  };
}
