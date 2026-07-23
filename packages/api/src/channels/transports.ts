/**
 * === VIVENTIUM START ===
 * Feature: Official channel transports.
 * Purpose: Provide Telegram Bot API, Slack Socket Mode, and WhatsApp Cloud API text paths.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import { renderTelegramMarkdown, splitTelegramText, stripTelegramHtml } from './telegramFormatting';
import type {
  ChannelConnectionRuntime,
  ChannelEnvelope,
  ChannelIngressHandler,
  ChannelIngressResult,
  ChannelOutboundMessage,
  ChannelTransport,
  ChannelTransportTestResult,
} from './types';

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ProviderRequestError extends Error {
  readonly issueCode: string;
  readonly providerResponded: boolean;

  constructor(issueCode: string, providerResponded = false) {
    super('Provider request failed');
    this.name = 'ProviderRequestError';
    this.issueCode = issueCode;
    this.providerResponded = providerResponded;
  }
}

function classifyProviderFailure(status: number, payload: RecordValue | null): string {
  const errorRecord = asRecord(payload?.error);
  const providerCode = stringValue(
    typeof payload?.error === 'string' ? payload.error : errorRecord?.code,
  ).toLowerCase();
  const providerDescription = stringValue(
    payload?.description || errorRecord?.message || errorRecord?.error_user_msg,
  ).toLowerCase();
  if (status === 400 && providerDescription.includes('parse entities')) {
    return 'formatting_invalid';
  }
  if (status === 409 || providerCode.includes('conflict')) {
    return 'connection_conflict';
  }
  if (
    status === 429 ||
    ['4', '17', '32', '613'].includes(providerCode) ||
    providerCode === 'ratelimited' ||
    providerCode.includes('rate_limit')
  ) {
    return 'rate_limited';
  }
  if (
    status === 403 ||
    providerCode.includes('missing_scope') ||
    providerCode.includes('permission') ||
    providerCode.includes('not_allowed') ||
    ['10', '200'].includes(providerCode)
  ) {
    return 'missing_permission';
  }
  if (
    status === 401 ||
    providerCode.includes('invalid_auth') ||
    providerCode.includes('token_revoked') ||
    providerCode.includes('account_inactive') ||
    providerCode === '190'
  ) {
    return 'invalid_credentials';
  }
  return 'connection_unavailable';
}

export function getProviderIssueCode(error: unknown): string {
  if (error instanceof ProviderRequestError) {
    return error.issueCode;
  }
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const status = Number(record?.statusCode || data?.statusCode || 0);
  if (record || data) {
    return classifyProviderFailure(Number.isFinite(status) ? status : 0, data || record);
  }
  return 'connection_unavailable';
}

async function parseJson(response: Response): Promise<RecordValue> {
  const value = await response.json().catch(() => null);
  const record = asRecord(value);
  if (!response.ok || !record || record.ok === false) {
    throw new ProviderRequestError(classifyProviderFailure(response.status, record), true);
  }
  return record;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<RecordValue> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    return await parseJson(response);
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new ProviderRequestError('connection_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

function splitText(text: string, maximum: number): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length <= maximum) {
    return [text];
  }
  const chunks: string[] = [];
  for (let start = 0; start < codePoints.length; start += maximum) {
    chunks.push(codePoints.slice(start, start + maximum).join(''));
  }
  return chunks;
}

function telegramUnsupportedMediaLabel(message: RecordValue): string {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return 'photo';
  }
  if (asRecord(message.document)) {
    return 'document';
  }
  if (asRecord(message.voice)) {
    return 'voice note';
  }
  if (asRecord(message.video)) {
    return 'video';
  }
  if (asRecord(message.audio)) {
    return 'audio';
  }
  if (asRecord(message.animation)) {
    return 'animation';
  }
  if (asRecord(message.sticker)) {
    return 'sticker';
  }
  if (asRecord(message.video_note)) {
    return 'video message';
  }
  return '';
}

type TelegramTransportOptions = {
  onIngress: ChannelIngressHandler;
  fetchImpl?: typeof fetch;
  autoPoll?: boolean;
  onError?: (error: Error) => void;
  onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;
  requestTimeoutMs?: number;
  durableQueue?: ChannelDurableQueue;
};

type TelegramPollState = {
  connection: ChannelConnectionRuntime;
  offset: number;
  stopped: boolean;
  controller?: AbortController;
};

export class TelegramBotApiTransport implements ChannelTransport {
  readonly channel = 'telegram' as const;
  private readonly onIngress: ChannelIngressHandler;
  private readonly fetchImpl: typeof fetch;
  private readonly autoPoll: boolean;
  private readonly onError: (error: Error) => void;
  private readonly onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;

  private readonly requestTimeoutMs: number;
  private readonly durableQueue?: ChannelDurableQueue;
  private readonly states = new Map<string, TelegramPollState>();

  constructor(options: TelegramTransportOptions) {
    this.onIngress = options.onIngress;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.autoPoll = options.autoPoll ?? true;
    this.onError = options.onError ?? (() => undefined);
    this.onHealth = options.onHealth;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.durableQueue = options.durableQueue;
  }

  private token(connection: ChannelConnectionRuntime): string {
    const token = connection.credentials.botToken;
    if (!token) {
      throw new Error('Telegram bot token is missing');
    }
    return token;
  }

  private async call(
    connection: ChannelConnectionRuntime,
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RecordValue> {
    return await fetchJsonWithTimeout(
      this.fetchImpl,
      `https://api.telegram.org/bot${this.token(connection)}/${method}`,
      {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      },
      this.requestTimeoutMs,
    );
  }

  async start(connection: ChannelConnectionRuntime): Promise<void> {
    await this.stop(connection.accountId).catch(() => undefined);
    const webhook = await this.call(connection, 'getWebhookInfo');
    const webhookInfo = asRecord(webhook.result);
    if (stringValue(webhookInfo?.url)) {
      throw new ProviderRequestError('webhook_in_use');
    }
    // A competing long poll returns 409. Probe ownership before claiming Connected.
    await this.call(connection, 'getUpdates', { timeout: 0, limit: 1 });
    const state: TelegramPollState = { connection, offset: 0, stopped: false };
    this.states.set(connection.accountId, state);
    this.durableQueue?.start('telegram', connection.accountId, {
      prepare: (envelope) => this.onIngress(envelope),
      send: async (envelope, text, egressCursor) => ({
        providerMessageId: await this.sendText(
          connection,
          envelope.externalConversationId,
          text,
          egressCursor,
        ),
      }),
      onUncertain: () =>
        this.onHealth?.(
          connection.accountId,
          'delivery_uncertain',
          connection.configGeneration || 'legacy',
        ),
      onRejected: (_envelope, error) =>
        this.onHealth?.(
          connection.accountId,
          getProviderIssueCode(error),
          connection.configGeneration || 'legacy',
        ),
    });
    if (this.autoPoll) {
      void this.poll(state);
    }
  }

  async stop(accountId: string, expectedGeneration?: string): Promise<void> {
    const state = this.states.get(accountId);
    if (expectedGeneration && state?.connection.configGeneration !== expectedGeneration) {
      return;
    }
    if (state) {
      state.stopped = true;
      state.controller?.abort();
      this.states.delete(accountId);
    }
    this.durableQueue?.stop('telegram', accountId);
  }

  async test(connection: ChannelConnectionRuntime): Promise<ChannelTransportTestResult> {
    try {
      const payload = await this.call(connection, 'getMe');
      const result = asRecord(payload.result);
      const username = stringValue(result?.username);
      return {
        ok: true,
        displayName: username ? `@${username}` : 'Telegram bot',
        accountId: stringValue(result?.id) || connection.accountId,
      };
    } catch (error) {
      return { ok: false, issueCode: getProviderIssueCode(error) };
    }
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    const state = this.states.get(message.accountId);
    if (!state) {
      throw new Error('Telegram worker is not running');
    }
    await this.sendText(state.connection, message.externalConversationId, message.text);
  }

  private async sendText(
    connection: ChannelConnectionRuntime,
    chatId: string,
    text: string,
    egressCursor = 0,
  ): Promise<string> {
    let providerMessageId = '';
    const chunks = splitTelegramText(text);
    for (let index = egressCursor; index < chunks.length; index += 1) {
      try {
        const rendered = renderTelegramMarkdown(chunks[index]);
        let payload;
        if (rendered === chunks[index] || Array.from(rendered).length > 4096) {
          payload = await this.call(connection, 'sendMessage', {
            chat_id: chatId,
            text: chunks[index],
          });
        } else {
          try {
            payload = await this.call(connection, 'sendMessage', {
              chat_id: chatId,
              text: rendered,
              parse_mode: 'HTML',
            });
          } catch (error) {
            if (getProviderIssueCode(error) !== 'formatting_invalid') {
              throw error;
            }
            payload = await this.call(connection, 'sendMessage', {
              chat_id: chatId,
              text: stripTelegramHtml(rendered),
            });
          }
        }
        providerMessageId = stringValue(asRecord(payload.result)?.message_id) || providerMessageId;
      } catch (error) {
        throw chunkDeliveryError(error, index);
      }
    }
    return providerMessageId;
  }

  async processUpdate(connection: ChannelConnectionRuntime, value: unknown): Promise<void> {
    const update = asRecord(value);
    const message = asRecord(update?.message);
    const from = asRecord(message?.from);
    const chat = asRecord(message?.chat);
    const text = stringValue(message?.text);
    if (!update || !message || !from || !chat || from.is_bot === true) {
      return;
    }
    const chatId = stringValue(chat.id);
    const userId = stringValue(from.id);
    if (!chatId || !userId || chat.type !== 'private') {
      return;
    }
    const unsupportedMediaLabel = telegramUnsupportedMediaLabel(message);
    if (!text && !unsupportedMediaLabel) {
      return;
    }
    const envelope: ChannelEnvelope = {
      channel: 'telegram',
      accountId: connection.accountId,
      externalUserId: userId,
      externalUsername: stringValue(from.username),
      externalConversationId: chatId,
      externalThreadId: stringValue(message.message_thread_id),
      externalMessageId: stringValue(message.message_id),
      externalUpdateId: stringValue(update.update_id),
      inputMode: 'text',
      audioRequested: false,
      text: unsupportedMediaLabel ? '' : text,
      attachments: unsupportedMediaLabel
        ? [{ kind: 'telegram_unsupported_media', mediaType: unsupportedMediaLabel }]
        : [],
      pairingContext: 'private',
    };
    if (this.durableQueue) {
      const admission = await this.durableQueue.enqueue(envelope);
      if (admission?.accepted === false && admission.replyText) {
        await this.sendText(connection, chatId, admission.replyText);
      }
    } else {
      const result = await this.onIngress(envelope);
      if (result.text) {
        await this.sendText(connection, chatId, result.text);
      }
    }
  }

  async processUpdateBatch(
    connection: ChannelConnectionRuntime,
    updates: ReadonlyArray<unknown>,
    onCommitted: (nextOffset: number) => void = () => undefined,
  ): Promise<void> {
    for (const update of updates) {
      const updateId = Number(asRecord(update)?.update_id);
      await this.processUpdate(connection, update);
      if (Number.isFinite(updateId)) {
        onCommitted(updateId + 1);
      }
    }
  }

  private async poll(state: TelegramPollState): Promise<void> {
    let consecutiveFailures = 0;
    while (!state.stopped) {
      state.controller = new AbortController();
      try {
        const payload = await fetchJsonWithTimeout(
          this.fetchImpl,
          `https://api.telegram.org/bot${this.token(state.connection)}/getUpdates?timeout=30&offset=${state.offset}`,
          { signal: state.controller.signal },
          35_000,
        );
        const updates = Array.isArray(payload.result) ? payload.result : [];
        consecutiveFailures = 0;
        await this.processUpdateBatch(state.connection, updates, (nextOffset) => {
          state.offset = Math.max(state.offset, nextOffset);
        });
      } catch (error) {
        if (!state.stopped) {
          consecutiveFailures += 1;
          const issueCode = getProviderIssueCode(error);
          this.onError(new ProviderRequestError(issueCode));
          await this.onHealth?.(
            state.connection.accountId,
            issueCode,
            state.connection.configGeneration || 'legacy',
          );
          const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 5));
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
  }
}

type SlackWebClient = {
  auth: { test(): Promise<RecordValue> };
  chat: { postMessage(body: Record<string, unknown>): Promise<RecordValue> };
};

type ChannelDurableQueue = {
  enqueue(
    envelope: ChannelEnvelope,
  ): Promise<void | { accepted: boolean; notify?: boolean; replyText?: string }>;
  start(
    channel: 'telegram' | 'slack' | 'whatsapp',
    accountId: string,
    processor: {
      prepare(envelope: ChannelEnvelope): Promise<ChannelIngressResult>;
      send(
        envelope: ChannelEnvelope,
        text: string,
        egressCursor: number,
      ): Promise<{ providerMessageId?: string }>;
      onUncertain?(envelope: ChannelEnvelope): Promise<void> | void;
      onRejected?(envelope: ChannelEnvelope, error: unknown): Promise<void> | void;
    },
  ): void;
  stop(channel: 'telegram' | 'slack' | 'whatsapp', accountId: string): void;
};

function chunkDeliveryError(error: unknown, confirmedChunks: number): Error {
  const source = error as { providerResponded?: unknown };
  const wrapped =
    error instanceof ProviderRequestError
      ? error
      : new ProviderRequestError(
          getProviderIssueCode(error),
          source?.providerResponded === true || Boolean(asRecord(error)?.data),
        );
  Object.assign(wrapped, { confirmedChunks });
  return wrapped;
}

type SlackSocketModeClient = {
  on(event: string, listener: (event: RecordValue) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
};

type SlackTransportOptions = {
  onIngress: ChannelIngressHandler;
  socketModeClientFactory?: (appToken: string) => SlackSocketModeClient;
  webClientFactory?: (botToken: string) => SlackWebClient;
  onError?: (error: Error) => void;
  onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;
  durableQueue?: ChannelDurableQueue;
  startTimeoutMs?: number;
};

export class SlackSocketModeTransport implements ChannelTransport {
  readonly channel = 'slack' as const;
  private readonly onIngress: ChannelIngressHandler;
  private readonly socketModeClientFactory?: (appToken: string) => SlackSocketModeClient;
  private readonly webClientFactory?: (botToken: string) => SlackWebClient;
  private readonly onError: (error: Error) => void;
  private readonly onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;

  private readonly durableQueue?: ChannelDurableQueue;
  private readonly startTimeoutMs: number;
  private readonly connections = new Map<string, ChannelConnectionRuntime>();
  private readonly socketClients = new Map<string, SlackSocketModeClient>();
  private readonly webClients = new Map<string, SlackWebClient>();
  private readonly botUserIds = new Map<string, string>();

  constructor(options: SlackTransportOptions) {
    this.onIngress = options.onIngress;
    this.socketModeClientFactory = options.socketModeClientFactory;
    this.webClientFactory = options.webClientFactory;
    this.onError = options.onError ?? (() => undefined);
    this.onHealth = options.onHealth;
    this.durableQueue = options.durableQueue;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
  }

  private createWebClient(connection: ChannelConnectionRuntime): SlackWebClient {
    const botToken = connection.credentials.botToken;
    if (!botToken || !this.webClientFactory) {
      throw new ProviderRequestError('transport_unavailable');
    }
    return this.webClientFactory(botToken);
  }

  async start(connection: ChannelConnectionRuntime): Promise<void> {
    await this.stop(connection.accountId).catch(() => undefined);
    if (!this.socketModeClientFactory || !this.webClientFactory) {
      throw new ProviderRequestError('transport_unavailable');
    }
    if (
      !connection.credentials.appToken?.startsWith('xapp-') ||
      !connection.credentials.botToken?.startsWith('xoxb-')
    ) {
      throw new Error('Slack Socket Mode credentials are invalid');
    }
    const webClient = this.createWebClient(connection);
    const identity = await webClient.auth.test();
    const verifiedTeamId = stringValue(identity.team_id);
    const botUserId = stringValue(identity.user_id || identity.user);
    if (verifiedTeamId && verifiedTeamId !== connection.accountId) {
      throw new ProviderRequestError('account_mismatch');
    }
    if (botUserId) {
      this.botUserIds.set(connection.accountId, botUserId);
    }
    const socket = this.socketModeClientFactory(connection.credentials.appToken);
    this.connections.set(connection.accountId, connection);
    this.webClients.set(connection.accountId, webClient);
    this.socketClients.set(connection.accountId, socket);
    socket.on('slack_event', (event) => {
      const acknowledge =
        typeof event.ack === 'function'
          ? (event.ack as () => Promise<void>)
          : async () => undefined;
      if (this.socketClients.get(connection.accountId) !== socket) {
        void acknowledge().catch(() => undefined);
        return;
      }
      void this.processEnvelope(connection, event.body, acknowledge).catch((error) =>
        this.onError(error instanceof Error ? error : new Error('Slack event failed')),
      );
    });
    socket.on('error', (event) => {
      if (this.socketClients.get(connection.accountId) !== socket) {
        return;
      }
      const error =
        event.error instanceof Error
          ? event.error
          : new ProviderRequestError('connection_unavailable');
      this.onError(error);
      void this.onHealth?.(
        connection.accountId,
        getProviderIssueCode(error),
        connection.configGeneration || 'legacy',
      );
    });
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          socket.start(),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new ProviderRequestError('connection_timeout')),
              this.startTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      this.durableQueue?.start('slack', connection.accountId, {
        prepare: (envelope) => this.onIngress(envelope),
        send: async (envelope, text, egressCursor) => ({
          providerMessageId: await this.sendText(
            connection.accountId,
            envelope.externalConversationId,
            envelope.externalThreadId,
            text,
            egressCursor,
          ),
        }),
        onUncertain: () =>
          this.onHealth?.(
            connection.accountId,
            'delivery_uncertain',
            connection.configGeneration || 'legacy',
          ),
        onRejected: (_envelope, error) =>
          this.onHealth?.(
            connection.accountId,
            getProviderIssueCode(error),
            connection.configGeneration || 'legacy',
          ),
      });
    } catch (error) {
      await socket.disconnect().catch(() => undefined);
      this.connections.delete(connection.accountId);
      this.webClients.delete(connection.accountId);
      this.socketClients.delete(connection.accountId);
      throw error;
    }
  }

  async stop(accountId: string, expectedGeneration?: string): Promise<void> {
    const connection = this.connections.get(accountId);
    if (expectedGeneration && connection?.configGeneration !== expectedGeneration) {
      return;
    }
    const socket = this.socketClients.get(accountId);
    try {
      await socket?.disconnect();
    } finally {
      if (this.socketClients.get(accountId) === socket) {
        this.durableQueue?.stop('slack', accountId);
        this.socketClients.delete(accountId);
        this.webClients.delete(accountId);
        this.connections.delete(accountId);
      }
    }
  }

  async test(connection: ChannelConnectionRuntime): Promise<ChannelTransportTestResult> {
    try {
      const result = await this.createWebClient(connection).auth.test();
      const botUserId = stringValue(result.user_id || result.user);
      if (botUserId) {
        this.botUserIds.set(connection.accountId, botUserId);
        const teamId = stringValue(result.team_id);
        if (teamId) {
          this.botUserIds.set(teamId, botUserId);
        }
      }
      return {
        ok: true,
        displayName: stringValue(result.user) || 'Slack bot',
        accountId: stringValue(result.team_id) || connection.accountId,
      };
    } catch (error) {
      return { ok: false, issueCode: getProviderIssueCode(error) };
    }
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    if (!this.connections.has(message.accountId)) {
      throw new Error('Slack worker is not running');
    }
    await this.sendText(
      message.accountId,
      message.externalConversationId,
      message.externalThreadId,
      message.text,
    );
  }

  private async sendText(
    accountId: string,
    channel: string,
    threadId: string,
    text: string,
    egressCursor = 0,
  ): Promise<string> {
    let providerMessageId = '';
    const chunks = splitText(text, 39000);
    for (let index = egressCursor; index < chunks.length; index += 1) {
      const body: Record<string, unknown> = { channel, text: chunks[index] };
      if (threadId) {
        body.thread_ts = threadId;
      }
      const client = this.webClients.get(accountId);
      if (!client) {
        throw new Error('Slack worker is not running');
      }
      try {
        const result = await client.chat.postMessage(body);
        providerMessageId = stringValue(result.ts) || providerMessageId;
      } catch (error) {
        throw chunkDeliveryError(error, index);
      }
    }
    return providerMessageId;
  }

  async processEnvelope(
    connection: ChannelConnectionRuntime,
    value: unknown,
    acknowledge: () => Promise<void>,
  ): Promise<void> {
    const envelope = asRecord(value);
    if (!envelope) {
      return;
    }
    const payload =
      envelope.type === 'events_api'
        ? asRecord(envelope.payload)
        : envelope.type === 'event_callback'
          ? envelope
          : null;
    if (!payload) {
      await acknowledge();
      return;
    }
    if (stringValue(payload?.team_id) && stringValue(payload?.team_id) !== connection.accountId) {
      await acknowledge();
      return;
    }
    const event = asRecord(payload?.event);
    if (!event) {
      await acknowledge();
      return;
    }
    const text = stringValue(event?.text);
    const isDirectMessage = event.channel_type === 'im';
    const isMention = event.type === 'app_mention';
    if (!text || event.bot_id || event.subtype || !event.user || (!isDirectMessage && !isMention)) {
      await acknowledge();
      return;
    }
    const channelId = stringValue(event.channel);
    const userId = stringValue(event.user);
    if (!channelId || !userId) {
      await acknowledge();
      return;
    }
    const existingThreadId = stringValue(event.thread_ts);
    const rootMessageId = stringValue(event.ts);
    const eventId = stringValue(payload.event_id);
    if (!rootMessageId && !eventId) {
      await acknowledge();
      return;
    }
    const threadId = isDirectMessage ? existingThreadId : existingThreadId || rootMessageId;
    const botUserId = this.botUserIds.get(connection.accountId);
    const normalizedText = botUserId
      ? text.replace(new RegExp(`^\\s*<@${escapeRegExp(botUserId)}>\\s*`), '')
      : text;
    const normalizedEnvelope: ChannelEnvelope = {
      channel: 'slack',
      accountId: connection.accountId,
      externalUserId: userId,
      externalUsername: '',
      externalConversationId: channelId,
      externalThreadId: threadId,
      externalMessageId: stringValue(event.ts),
      externalUpdateId: eventId,
      inputMode: 'text',
      audioRequested: false,
      text: normalizedText,
      attachments: [],
      pairingContext: isDirectMessage ? 'private' : 'public',
    };
    if (this.durableQueue) {
      const admission = await this.durableQueue.enqueue(normalizedEnvelope);
      await acknowledge();
      if (admission?.accepted === false && admission.replyText) {
        await this.sendText(connection.accountId, channelId, threadId, admission.replyText);
      }
      return;
    }
    await acknowledge();
    const result = await this.onIngress(normalizedEnvelope);
    if (result.text) {
      await this.sendText(connection.accountId, channelId, threadId, result.text);
    }
  }
}

type WhatsAppTransportOptions = {
  onIngress: ChannelIngressHandler;
  fetchImpl?: typeof fetch;
  graphVersion?: string;
  requestTimeoutMs?: number;
  durableQueue?: ChannelDurableQueue;
  onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;
};

export class WhatsAppCloudTransport implements ChannelTransport {
  readonly channel = 'whatsapp' as const;
  private readonly onIngress: ChannelIngressHandler;
  private readonly fetchImpl: typeof fetch;
  private readonly graphVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly durableQueue?: ChannelDurableQueue;
  private readonly onHealth?: (
    accountId: string,
    issueCode: string,
    sourceGeneration: string,
  ) => void | Promise<void>;

  private readonly connections = new Map<string, ChannelConnectionRuntime>();

  constructor(options: WhatsAppTransportOptions) {
    this.onIngress = options.onIngress;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.graphVersion = /^v\d+\.\d+$/.test(options.graphVersion ?? '')
      ? (options.graphVersion as string)
      : 'v25.0';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.durableQueue = options.durableQueue;
    this.onHealth = options.onHealth;
  }

  async start(connection: ChannelConnectionRuntime): Promise<void> {
    this.connections.set(connection.accountId, connection);
    this.durableQueue?.start('whatsapp', connection.accountId, {
      prepare: (envelope) => this.onIngress(envelope),
      send: async (envelope, text, egressCursor) => ({
        providerMessageId: await this.sendText(
          connection,
          envelope.externalConversationId,
          text,
          egressCursor,
        ),
      }),
      onUncertain: () =>
        this.onHealth?.(
          connection.accountId,
          'delivery_uncertain',
          connection.configGeneration || 'legacy',
        ),
      onRejected: (_envelope, error) =>
        this.onHealth?.(
          connection.accountId,
          getProviderIssueCode(error),
          connection.configGeneration || 'legacy',
        ),
    });
  }

  async stop(accountId: string, expectedGeneration?: string): Promise<void> {
    const connection = this.connections.get(accountId);
    if (expectedGeneration && connection?.configGeneration !== expectedGeneration) {
      return;
    }
    this.durableQueue?.stop('whatsapp', accountId);
    this.connections.delete(accountId);
  }

  async test(connection: ChannelConnectionRuntime): Promise<ChannelTransportTestResult> {
    const phoneNumberId = connection.credentials.phoneNumberId;
    const accessToken = connection.credentials.accessToken;
    const appSecret = connection.credentials.appSecret;
    if (!phoneNumberId || !accessToken || !appSecret) {
      return { ok: false, issueCode: 'invalid_credentials' };
    }
    try {
      const appsecretProof = crypto
        .createHmac('sha256', appSecret)
        .update(accessToken)
        .digest('hex');
      const payload = await fetchJsonWithTimeout(
        this.fetchImpl,
        `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name&appsecret_proof=${appsecretProof}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
        this.requestTimeoutMs,
      );
      return {
        ok: true,
        displayName:
          stringValue(payload.verified_name || payload.display_phone_number) || 'WhatsApp',
        accountId: phoneNumberId,
      };
    } catch (error) {
      return { ok: false, issueCode: getProviderIssueCode(error) };
    }
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    const connection = this.connections.get(message.accountId);
    if (!connection) {
      throw new Error('WhatsApp worker is not running');
    }
    await this.sendText(connection, message.externalConversationId, message.text);
  }

  private async sendText(
    connection: ChannelConnectionRuntime,
    recipient: string,
    text: string,
    egressCursor = 0,
  ): Promise<string> {
    const phoneNumberId = connection.credentials.phoneNumberId;
    const accessToken = connection.credentials.accessToken;
    const appSecret = connection.credentials.appSecret;
    if (!phoneNumberId || !accessToken || !appSecret) {
      throw new Error('WhatsApp credentials are missing');
    }
    const appsecretProof = crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
    let providerMessageId = '';
    const chunks = splitText(text, 4096);
    for (let index = egressCursor; index < chunks.length; index += 1) {
      let result;
      try {
        result = await fetchJsonWithTimeout(
          this.fetchImpl,
          `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(phoneNumberId)}/messages?appsecret_proof=${appsecretProof}`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: recipient,
              type: 'text',
              text: { body: chunks[index] },
            }),
          },
          this.requestTimeoutMs,
        );
      } catch (error) {
        throw chunkDeliveryError(error, index);
      }
      const messages = Array.isArray(result.messages) ? result.messages : [];
      providerMessageId = stringValue(asRecord(messages[0])?.id) || providerMessageId;
    }
    return providerMessageId;
  }

  async processWebhook(connection: ChannelConnectionRuntime, payload: unknown): Promise<number> {
    const root = asRecord(payload);
    if (root?.object !== 'whatsapp_business_account') {
      return 0;
    }
    const entries = Array.isArray(root?.entry) ? root.entry : [];
    let handled = 0;
    for (const entryValue of entries) {
      const entry = asRecord(entryValue);
      if (stringValue(entry?.id) !== connection.credentials.businessAccountId) {
        continue;
      }
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const changeValue of changes) {
        const change = asRecord(changeValue);
        if (change?.field !== 'messages') {
          continue;
        }
        const value = asRecord(change?.value);
        const metadata = asRecord(value?.metadata);
        if (stringValue(metadata?.phone_number_id) !== connection.credentials.phoneNumberId) {
          continue;
        }
        const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
        const contact = asRecord(contacts[0]);
        const profile = asRecord(contact?.profile);
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        for (const messageValue of messages) {
          const message = asRecord(messageValue);
          const textPayload = asRecord(message?.text);
          const text = stringValue(textPayload?.body);
          const sender = stringValue(message?.from);
          if (!message || message.type !== 'text' || !text || !sender) {
            continue;
          }
          const envelope: ChannelEnvelope = {
            channel: 'whatsapp',
            accountId: connection.accountId,
            externalUserId: sender,
            externalUsername: stringValue(profile?.name),
            externalConversationId: sender,
            externalThreadId: '',
            externalMessageId: stringValue(message.id),
            externalUpdateId: '',
            inputMode: 'text',
            audioRequested: false,
            text,
            attachments: [],
            pairingContext: 'private',
          };
          if (this.durableQueue) {
            const admission = await this.durableQueue.enqueue(envelope);
            if (admission?.accepted === false && admission.replyText) {
              await this.sendText(connection, sender, admission.replyText);
            }
          } else {
            const result = await this.onIngress(envelope);
            if (result.text) {
              await this.sendText(connection, sender, result.text);
            }
          }
          handled += 1;
        }
      }
    }
    return handled;
  }
}
