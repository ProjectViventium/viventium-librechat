/**
 * === VIVENTIUM START ===
 * Feature: Official production channel transports.
 * Purpose: Exercise text ingress/egress, auth, linking, and the shared AgentController gateway path without real messages.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import {
  ChannelGatewayClient,
  buildChannelDedupeKey,
  extractGatewaySseText,
  SlackSocketModeTransport,
  TelegramBotApiTransport,
  WhatsAppCloudTransport,
} from './index';
import type { ChannelEnvelope, ChannelIngressHandler } from './index';

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('official channel transports', () => {
  it.each([
    [401, 'invalid_credentials'],
    [403, 'missing_permission'],
    [429, 'rate_limited'],
    [503, 'connection_unavailable'],
  ])(
    'classifies Telegram provider status %s without exposing provider content',
    async (status, issueCode) => {
      const transport = new TelegramBotApiTransport({
        autoPoll: false,
        onIngress: async () => ({ text: '' }),
        fetchImpl: jest.fn(async () =>
          jsonResponse({ ok: false, description: 'sensitive provider detail' }, status),
        ),
      });
      await expect(
        transport.test({
          channel: 'telegram',
          accountId: 'bot-1',
          credentials: { botToken: 'synthetic' },
        }),
      ).resolves.toEqual({ ok: false, issueCode });
    },
  );

  it('bounds a stalled provider probe and reports a timeout', async () => {
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      requestTimeoutMs: 5,
      onIngress: async () => ({ text: '' }),
      fetchImpl: jest.fn(
        async (_url, init) =>
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });
    await expect(
      transport.test({
        channel: 'telegram',
        accountId: 'bot-1',
        credentials: { botToken: 'synthetic' },
      }),
    ).resolves.toEqual({ ok: false, issueCode: 'connection_timeout' });
  });

  it('never exposes a token-bearing Telegram request URL through client output or error callbacks', async () => {
    const token = '123:synthetic-secret';
    const tokenUrl = `https://api.telegram.org/bot${token}/getUpdates`;
    let call = 0;
    const seenErrors: Error[] = [];
    const transport = new TelegramBotApiTransport({
      autoPoll: true,
      onIngress: async () => ({ text: '' }),
      fetchImpl: jest.fn(async () => {
        call += 1;
        if (call <= 2) {
          return jsonResponse({ ok: true, result: call === 1 ? { url: '' } : [] });
        }
        throw new Error(`fetch failed for ${tokenUrl}`);
      }),
      onError: (error) => {
        seenErrors.push(error);
        void transport.stop('bot-1');
      },
    });

    await transport.start({
      channel: 'telegram',
      accountId: 'bot-1',
      credentials: { botToken: token },
    });
    while (seenErrors.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(seenErrors[0]).toMatchObject({
      name: 'ProviderRequestError',
      message: 'Provider request failed',
      issueCode: 'connection_unavailable',
    });
    expect(JSON.stringify(seenErrors[0])).not.toContain(token);
    expect(JSON.stringify(seenErrors[0])).not.toContain(tokenUrl);
  });

  it('fails closed when another Telegram long poll owns the bot token', async () => {
    const fetchImpl = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/getWebhookInfo')
        ? jsonResponse({ ok: true, result: { url: '' } })
        : jsonResponse({ ok: false, description: 'Conflict' }, 409),
    );
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl,
      onIngress: async () => ({ text: '' }),
    });
    await expect(
      transport.start({
        channel: 'telegram',
        accountId: 'bot-1',
        credentials: { botToken: 'synthetic' },
      }),
    ).rejects.toMatchObject({ issueCode: 'connection_conflict' });
  });
  it('routes Telegram text through injected ingress and replies through the official Bot API', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ ok: true, result: { id: 1, username: 'synthetic_bot' } });
    });
    const received: ChannelEnvelope[] = [];
    const onIngress: ChannelIngressHandler = async (envelope) => {
      received.push(envelope);
      return { text: 'synthetic reply' };
    };
    const transport = new TelegramBotApiTransport({ fetchImpl, onIngress, autoPoll: false });
    const connection = {
      channel: 'telegram' as const,
      accountId: 'bot-1',
      credentials: { botToken: '100:synthetic-token' },
    };

    await transport.start(connection);
    await transport.processUpdate(connection, {
      update_id: 22,
      message: {
        message_id: 11,
        text: 'hello',
        chat: { id: 33, type: 'private' },
        from: { id: 44, username: 'synthetic_user', is_bot: false },
      },
    });

    expect(received[0]).toMatchObject({
      channel: 'telegram',
      accountId: 'bot-1',
      externalUserId: '44',
      externalConversationId: '33',
      externalMessageId: '11',
      externalUpdateId: '22',
      text: 'hello',
    });
    expect(requests.at(-1)).toMatchObject({
      url: 'https://api.telegram.org/bot100:synthetic-token/sendMessage',
      body: { chat_id: '33', text: 'synthetic reply' },
    });
  });

  it('stops a Telegram batch at the first durable gap and recovers both updates in order', async () => {
    const committed: number[] = [];
    const accepted: string[] = [];
    let failFirst = true;
    const durableQueue = {
      start: jest.fn(),
      stop: jest.fn(),
      enqueue: jest.fn(async (message: ChannelEnvelope) => {
        if (message.externalUpdateId === '10' && failFirst) {
          failFirst = false;
          throw new Error('synthetic persistence outage');
        }
        accepted.push(message.externalUpdateId);
      }),
    };
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      durableQueue,
      onIngress: async () => ({ text: '' }),
    });
    const connection = {
      channel: 'telegram' as const,
      accountId: 'bot-1',
      credentials: { botToken: 'synthetic' },
    };
    const update = (id: number) => ({
      update_id: id,
      message: {
        message_id: id,
        text: `message-${id}`,
        chat: { id: 1, type: 'private' },
        from: { id: 2 },
      },
    });
    await expect(
      transport.processUpdateBatch(connection, [update(10), update(11)], (value) =>
        committed.push(value),
      ),
    ).rejects.toThrow('synthetic persistence outage');
    expect(accepted).toEqual([]);
    expect(committed).toEqual([]);
    await transport.processUpdateBatch(connection, [update(10), update(11)], (value) =>
      committed.push(value),
    );
    expect(accepted).toEqual(['10', '11']);
    expect(committed).toEqual([11, 12]);
  });

  it('advances Telegram after quota rejection and sends one bounded retry notice', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl: jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }),
      onIngress: async () => ({ text: '' }),
      durableQueue: {
        start: jest.fn(),
        stop: jest.fn(),
        enqueue: async () => ({ accepted: false, notify: true, replyText: 'Wait, then retry.' }),
      },
    });
    const committed: number[] = [];
    await transport.processUpdateBatch(
      {
        channel: 'telegram',
        accountId: 'bot-1',
        credentials: { botToken: 'synthetic' },
      },
      [
        {
          update_id: 10,
          message: {
            message_id: 1,
            text: 'burst',
            chat: { id: 3, type: 'private' },
            from: { id: 4 },
          },
        },
      ],
      (value) => committed.push(value),
    );
    expect(committed).toEqual([11]);
    expect(requests.at(-1)?.body).toEqual({ chat_id: '3', text: 'Wait, then retry.' });
  });

  it('sends Telegram-safe HTML and retries once as plain text when entity parsing rejects it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl: jest.fn(async (_url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        bodies.push(body);
        return body.parse_mode === 'HTML'
          ? jsonResponse({ ok: false, description: "Bad Request: can't parse entities" }, 400)
          : jsonResponse({ ok: true, result: { message_id: 2 } });
      }),
      onIngress: async () => ({ text: '# Result\n\n**Complete** & safe.' }),
    });

    await transport.processUpdate(
      { channel: 'telegram', accountId: 'bot-1', credentials: { botToken: 'synthetic' } },
      {
        update_id: 1,
        message: {
          message_id: 2,
          text: 'hello',
          chat: { id: 3, type: 'private' },
          from: { id: 4 },
        },
      },
    );

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      chat_id: '3',
      parse_mode: 'HTML',
      text: expect.stringContaining('<b>Result</b>'),
    });
    expect(String(bodies[0].text)).toContain('<b>Complete</b> &amp; safe.');
    expect(bodies[1]).toEqual({ chat_id: '3', text: 'Result\n\nComplete & safe.' });
  });

  it('splits Telegram replies without breaking Unicode surrogate pairs', async () => {
    const bodies: Record<string, unknown>[] = [];
    const reply = `${'a'.repeat(4095)}😀b`;
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl: jest.fn(async (_url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResponse({ ok: true, result: { message_id: bodies.length } });
      }),
      onIngress: async () => ({ text: reply }),
    });

    await transport.processUpdate(
      { channel: 'telegram', accountId: 'bot-1', credentials: { botToken: 'synthetic' } },
      {
        update_id: 1,
        message: {
          message_id: 2,
          text: 'hello',
          chat: { id: 3, type: 'private' },
          from: { id: 4 },
        },
      },
    );

    const sentText = bodies.map((body) => String(body.text));
    expect(sentText.join('')).toBe(reply);
    expect(sentText.every((chunk) => Array.from(chunk).length <= 4096)).toBe(true);
    expect(
      sentText.every(
        (chunk) => !/[\uD800-\uDFFF]/u.test(chunk.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')),
      ),
    ).toBe(true);
  });

  it.each([
    ['photo', { photo: [{ file_id: 'photo-1' }] }],
    ['document', { document: { file_id: 'document-1' } }],
    ['voice note', { voice: { file_id: 'voice-1' } }],
    ['video', { video: { file_id: 'video-1' } }],
    ['audio', { audio: { file_id: 'audio-1' } }],
    ['animation', { animation: { file_id: 'animation-1' } }],
    ['sticker', { sticker: { file_id: 'sticker-1' } }],
    ['video message', { video_note: { file_id: 'video-note-1' } }],
  ])('never silently drops an unsupported inbound Telegram %s', async (label, media) => {
    const bodies: Record<string, unknown>[] = [];
    const onIngress = jest.fn(async (envelope: ChannelEnvelope) => ({
      text: `I can’t process this ${String(envelope.attachments[0]?.mediaType)} in this Channels connection yet. Open Viventium to upload it safely.`,
    }));
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl: jest.fn(async (_url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }),
      onIngress,
    });

    await transport.processUpdate(
      { channel: 'telegram', accountId: 'bot-1', credentials: { botToken: 'synthetic' } },
      {
        update_id: 1,
        message: {
          message_id: 2,
          caption: 'please inspect this',
          chat: { id: 3, type: 'private' },
          from: { id: 4 },
          ...media,
        },
      },
    );

    expect(onIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '',
        attachments: [
          expect.objectContaining({
            kind: 'telegram_unsupported_media',
            mediaType: label,
          }),
        ],
      }),
    );
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0].text)).toContain(`can’t process this ${label}`);
    expect(String(bodies[0].text)).toContain('Open Viventium');
  });

  it('admits unsupported Telegram media through the durable identity path before any reply', async () => {
    const enqueue = jest.fn(async () => ({ accepted: true, notify: false }));
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } }));
    const onIngress = jest.fn(async () => ({ text: 'must not run inline' }));
    const transport = new TelegramBotApiTransport({
      autoPoll: false,
      fetchImpl,
      onIngress,
      durableQueue: { start: jest.fn(), stop: jest.fn(), enqueue },
    });

    await transport.processUpdate(
      { channel: 'telegram', accountId: 'bot-1', credentials: { botToken: 'synthetic' } },
      {
        update_id: 7,
        message: {
          message_id: 8,
          photo: [{ file_id: 'photo-1' }],
          chat: { id: 9, type: 'private' },
          from: { id: 10 },
        },
      },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        externalUserId: '10',
        externalConversationId: '9',
        externalMessageId: '8',
        externalUpdateId: '7',
        text: '',
        attachments: [
          expect.objectContaining({ kind: 'telegram_unsupported_media', mediaType: 'photo' }),
        ],
      }),
    );
    expect(onIngress).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('acks Slack Socket Mode before routing and replies with the official Web API', async () => {
    const posts: Record<string, unknown>[] = [];
    const socket = {
      on: jest.fn(),
      start: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
    };
    const order: string[] = [];
    const received: ChannelEnvelope[] = [];
    const transport = new SlackSocketModeTransport({
      socketModeClientFactory: () => socket,
      webClientFactory: () => ({
        auth: {
          test: async () => ({
            ok: true,
            user: 'Viventium',
            user_id: 'U-BOT',
            team_id: 'workspace-1',
          }),
        },
        chat: {
          postMessage: async (body) => {
            posts.push(body);
            return { ok: true };
          },
        },
      }),
      onIngress: async (envelope) => {
        order.push('ingress');
        received.push(envelope);
        return { text: 'synthetic reply' };
      },
    });
    const connection = {
      channel: 'slack' as const,
      accountId: 'workspace-1',
      credentials: { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
    };

    await transport.start(connection);

    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'envelope-1',
        type: 'events_api',
        payload: {
          event_id: 'event-stable-1',
          team_id: 'workspace-1',
          event: {
            type: 'app_mention',
            user: 'U1',
            channel: 'C1',
            ts: '100.2',
            thread_ts: '100.1',
            text: '<@U-BOT> hello',
          },
        },
      },
      async () => order.push('ack'),
    );

    expect(order).toEqual(['ack', 'ingress']);
    expect(received[0]).toMatchObject({
      text: 'hello',
      externalThreadId: '100.1',
      externalUpdateId: 'event-stable-1',
    });
    expect(posts.at(-1)).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'synthetic reply' });
  });

  it('keeps ordinary Slack DMs top-level while rooting channel mentions in threads', async () => {
    const bodies: Record<string, unknown>[] = [];
    const socket = {
      on: jest.fn(),
      start: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
    };
    const transport = new SlackSocketModeTransport({
      socketModeClientFactory: () => socket,
      webClientFactory: () => ({
        auth: {
          test: async () => ({
            ok: true,
            user: 'Viventium',
            user_id: 'U-BOT',
            team_id: 'workspace-1',
          }),
        },
        chat: {
          postMessage: async (body) => {
            bodies.push(body);
            return { ok: true };
          },
        },
      }),
      onIngress: async () => ({ text: 'reply' }),
    });
    const connection = {
      channel: 'slack' as const,
      accountId: 'workspace-1',
      credentials: { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
    };
    await transport.start(connection);
    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'dm-1',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            channel_type: 'im',
            user: 'U1',
            channel: 'D1',
            ts: '200.1',
            text: 'hello',
          },
        },
      },
      async () => undefined,
    );
    expect(bodies.at(-1)).toEqual({ channel: 'D1', text: 'reply' });
  });

  it('durably enqueues a Slack turn before acknowledging it', async () => {
    const order: string[] = [];
    const onIngress = jest.fn(async () => ({ text: 'should not run inline' }));
    const durableQueue = {
      enqueue: jest.fn(async () => {
        order.push('enqueue');
      }),
      start: jest.fn(),
      stop: jest.fn(),
    };
    const transport = new SlackSocketModeTransport({ onIngress, durableQueue });
    await transport.processEnvelope(
      { channel: 'slack', accountId: 'workspace-1', credentials: {} },
      {
        envelope_id: 'E1',
        type: 'events_api',
        payload: {
          team_id: 'workspace-1',
          event: {
            type: 'message',
            channel_type: 'im',
            user: 'U1',
            channel: 'D1',
            ts: '1',
            text: 'hello',
          },
        },
      },
      async () => {
        order.push('ack');
      },
    );
    expect(order).toEqual(['enqueue', 'ack']);
    expect(onIngress).not.toHaveBeenCalled();
  });

  it('dedupes Slack retries by the stable event identity, never the delivery envelope id', async () => {
    const keys: string[] = [];
    const transport = new SlackSocketModeTransport({
      onIngress: async () => ({ text: '' }),
      durableQueue: {
        start: jest.fn(),
        stop: jest.fn(),
        enqueue: async (message: ChannelEnvelope) => {
          keys.push(buildChannelDedupeKey(message));
        },
      },
    });
    const connection = { channel: 'slack' as const, accountId: 'workspace-1', credentials: {} };
    const payload = {
      event_id: 'event-stable-1',
      team_id: 'workspace-1',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U1',
        channel: 'D1',
        ts: '1.25',
        text: 'hello',
      },
    };

    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'delivery-attempt-1',
        type: 'events_api',
        payload,
      },
      async () => undefined,
    );
    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'delivery-attempt-2',
        type: 'events_api',
        payload,
      },
      async () => undefined,
    );
    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'delivery-attempt-3',
        type: 'events_api',
        payload: { ...payload, event_id: undefined },
      },
      async () => undefined,
    );
    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'delivery-attempt-4',
        type: 'events_api',
        payload: { ...payload, event_id: undefined },
      },
      async () => undefined,
    );

    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
  });

  it('acknowledges but does not enqueue a Slack event with no stable provider identity', async () => {
    const enqueue = jest.fn();
    const acknowledge = jest.fn(async () => undefined);
    const transport = new SlackSocketModeTransport({
      onIngress: async () => ({ text: '' }),
      durableQueue: { start: jest.fn(), stop: jest.fn(), enqueue },
    });

    await transport.processEnvelope(
      { channel: 'slack', accountId: 'workspace-1', credentials: {} },
      {
        envelope_id: 'unstable-delivery-only',
        type: 'events_api',
        payload: {
          team_id: 'workspace-1',
          event: {
            type: 'message',
            channel_type: 'im',
            user: 'U1',
            channel: 'D1',
            text: 'hello',
          },
        },
      },
      acknowledge,
    );

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fences stale Slack callbacks even when socket disconnect rejects', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const socket = {
      on: jest.fn((event: string, listener: (value: Record<string, unknown>) => void) =>
        listeners.set(event, listener),
      ),
      start: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => {
        throw new Error('synthetic disconnect failure');
      }),
    };
    const onIngress = jest.fn(async () => ({ text: 'must not run' }));
    const transport = new SlackSocketModeTransport({
      socketModeClientFactory: () => socket,
      webClientFactory: () => ({
        auth: { test: async () => ({ team_id: 'workspace-1', user_id: 'bot-1' }) },
        chat: { postMessage: async () => ({ ok: true }) },
      }),
      onIngress,
    });
    const connection = {
      channel: 'slack' as const,
      accountId: 'workspace-1',
      credentials: { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
    };
    await transport.start(connection);
    await expect(transport.stop('workspace-1')).rejects.toThrow('synthetic disconnect failure');
    const ack = jest.fn(async () => undefined);
    listeners.get('slack_event')?.({
      ack,
      body: {
        envelope_id: 'stale-1',
        type: 'events_api',
        payload: {
          team_id: 'workspace-1',
          event: {
            type: 'message',
            channel_type: 'im',
            user: 'U1',
            channel: 'D1',
            ts: '1',
            text: 'stale',
          },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onIngress).not.toHaveBeenCalled();
  });

  it('acks a quota-rejected Slack event and emits the one allowed retry notice', async () => {
    const posts: Record<string, unknown>[] = [];
    const socket = {
      on: jest.fn(),
      start: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
    };
    const transport = new SlackSocketModeTransport({
      socketModeClientFactory: () => socket,
      webClientFactory: () => ({
        auth: { test: async () => ({ team_id: 'workspace-1', user_id: 'bot-1' }) },
        chat: {
          postMessage: async (body) => {
            posts.push(body);
            return { ok: true };
          },
        },
      }),
      onIngress: async () => ({ text: '' }),
      durableQueue: {
        start: jest.fn(),
        stop: jest.fn(),
        enqueue: async () => ({ accepted: false, notify: true, replyText: 'Wait, then retry.' }),
      },
    });
    const connection = {
      channel: 'slack' as const,
      accountId: 'workspace-1',
      credentials: { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
    };
    await transport.start(connection);
    const ack = jest.fn(async () => undefined);
    await transport.processEnvelope(
      connection,
      {
        envelope_id: 'quota-1',
        type: 'events_api',
        payload: {
          team_id: 'workspace-1',
          event: {
            type: 'message',
            channel_type: 'im',
            user: 'U1',
            channel: 'D1',
            ts: '1',
            text: 'burst',
          },
        },
      },
      ack,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([{ channel: 'D1', text: 'Wait, then retry.' }]);
  });

  it('routes official WhatsApp Cloud text events and replies through Graph API', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return jsonResponse({ id: 'sent-1' });
    });
    const transport = new WhatsAppCloudTransport({
      fetchImpl,
      onIngress: async () => ({ text: 'synthetic reply' }),
    });
    const connection = {
      channel: 'whatsapp' as const,
      accountId: 'phone-1',
      credentials: {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'synthetic-access',
        appSecret: 'synthetic-secret',
        verifyToken: 'synthetic-verify',
      },
    };

    const handled = await transport.processWebhook(connection, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'business-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-1' },
                contacts: [{ wa_id: '15550001', profile: { name: 'Synthetic User' } }],
                messages: [
                  {
                    id: 'wamid-1',
                    from: '15550001',
                    timestamp: '100',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(handled).toBe(1);
    expect(calls.at(-1)).toMatchObject({
      url: expect.stringMatching(
        /^https:\/\/graph\.facebook\.com\/v25\.0\/phone-1\/messages\?appsecret_proof=[a-f0-9]{64}$/,
      ),
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '15550001',
        type: 'text',
        text: { body: 'synthetic reply' },
      },
    });

    const wrongTenant = await transport.processWebhook(connection, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'business-2',
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: 'phone-1' }, messages: [] },
            },
          ],
        },
      ],
    });
    expect(wrongTenant).toBe(0);
  });

  it('splits WhatsApp replies without breaking Unicode surrogate pairs', async () => {
    const reply = `${'a'.repeat(4095)}😀b`;
    const bodies: Record<string, unknown>[] = [];
    const transport = new WhatsAppCloudTransport({
      fetchImpl: jest.fn(async (_url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResponse({ messages: [{ id: `sent-${bodies.length}` }] });
      }),
      onIngress: async () => ({ text: reply }),
    });
    const connection = {
      channel: 'whatsapp' as const,
      accountId: 'phone-1',
      credentials: {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'synthetic-access',
        appSecret: 'synthetic-secret',
        verifyToken: 'synthetic-verify',
      },
    };

    await transport.processWebhook(connection, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'business-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-1' },
                messages: [
                  {
                    id: 'wamid-unicode',
                    from: '15550001',
                    timestamp: '100',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const chunks = bodies.map((body) => String((body.text as Record<string, unknown>).body));
    expect(chunks.join('')).toBe(reply);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 4096)).toBe(true);
    expect(
      chunks.every(
        (chunk) => !/[\uD800-\uDFFF]/u.test(chunk.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')),
      ),
    ).toBe(true);
  });

  it('uses Meta appsecret_proof without putting provider secrets in the Graph URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ verified_name: 'Synthetic Business' });
    });
    const transport = new WhatsAppCloudTransport({
      fetchImpl,
      onIngress: async () => ({ text: '' }),
    });
    await expect(
      transport.test({
        channel: 'whatsapp',
        accountId: 'phone-1',
        credentials: {
          phoneNumberId: 'phone-1',
          accessToken: 'synthetic-access-token',
          appSecret: 'synthetic-app-secret',
          businessAccountId: 'business-1',
          verifyToken: 'verify',
        },
      }),
    ).resolves.toMatchObject({ ok: true, accountId: 'phone-1' });
    expect(calls[0].url).toMatch(/appsecret_proof=[a-f0-9]{64}$/);
    expect(calls[0].url).not.toContain('synthetic-access-token');
    expect(calls[0].url).not.toContain('synthetic-app-secret');
    expect(calls[0].init?.headers).toEqual({ authorization: 'Bearer synthetic-access-token' });
  });

  it('includes the verified Meta appsecret_proof on outbound WhatsApp messages', async () => {
    const accessToken = 'synthetic-access-token';
    const appSecret = 'synthetic-app-secret';
    const expectedProof = crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (
        url.pathname.endsWith('/messages') &&
        url.searchParams.get('appsecret_proof') !== expectedProof
      ) {
        return jsonResponse({ error: { code: 190 } }, 401);
      }
      return jsonResponse({ messages: [{ id: 'sent-1' }] });
    });
    const transport = new WhatsAppCloudTransport({
      fetchImpl,
      onIngress: async () => ({ text: 'synthetic reply' }),
    });
    const connection = {
      channel: 'whatsapp' as const,
      accountId: 'phone-1',
      credentials: {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken,
        appSecret,
        verifyToken: 'synthetic-verify',
      },
    };

    await expect(
      transport.processWebhook(connection, {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'business-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-1' },
                  messages: [
                    { id: 'wamid-1', from: '15550001', type: 'text', text: { body: 'hello' } },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).resolves.toBe(1);
    const outboundUrl = new URL(String(fetchImpl.mock.calls.at(-1)?.[0]));
    expect(outboundUrl.searchParams.get('appsecret_proof')).toBe(expectedProof);
  });

  it('accepts a quota-rejected WhatsApp webhook without Agent work and sends one notice', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new WhatsAppCloudTransport({
      fetchImpl: jest.fn(async (_url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResponse({ messages: [{ id: 'notice-1' }] });
      }),
      onIngress: async () => ({ text: '' }),
      durableQueue: {
        start: jest.fn(),
        stop: jest.fn(),
        enqueue: async () => ({ accepted: false, notify: true, replyText: 'Wait, then retry.' }),
      },
    });
    const connection = {
      channel: 'whatsapp' as const,
      accountId: 'phone-1',
      credentials: {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'token',
        appSecret: 'secret',
        verifyToken: 'verify',
      },
    };
    await expect(
      transport.processWebhook(connection, {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'business-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-1' },
                  messages: [{ id: 'm1', from: '1555', type: 'text', text: { body: 'burst' } }],
                },
              },
            ],
          },
        ],
      }),
    ).resolves.toBe(1);
    expect(bodies.at(-1)).toMatchObject({ to: '1555', text: { body: 'Wait, then retry.' } });
  });
});

describe('ChannelGatewayClient', () => {
  it('uses the authoritative final event instead of duplicating streamed deltas', () => {
    const stream = [
      'data: {"type":"delta","text":"brain "}',
      'data: {"type":"delta","text":"reply"}',
      'data: {"type":"final","text":"brain reply"}',
      'data: {"final":true}',
    ].join('\n\n');
    expect(extractGatewaySseText(stream)).toBe('brain reply');
  });
  it('sends signed ingress to the existing gateway/AgentController route and reads the final SSE answer', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).endsWith('/api/viventium/gateway/chat')) {
        return jsonResponse({ streamId: 'stream-1', conversationId: 'new' });
      }
      return new Response(
        'event: message\ndata: {"final":true,"responseMessage":{"text":"brain reply"}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-gateway-secret',
      fetchImpl,
      nowSeconds: () => 100,
      randomNonce: () => 'nonce-1',
    });

    const response = await client.handle({
      channel: 'slack',
      accountId: 'workspace-1',
      externalUserId: 'U1',
      externalUsername: '',
      externalConversationId: 'C1',
      externalThreadId: '100.1',
      externalMessageId: '100.2',
      externalUpdateId: '',
      inputMode: 'text',
      audioRequested: false,
      text: 'hello',
      attachments: [],
    });

    expect(response).toEqual({ text: 'brain reply' });
    expect(calls[0].url).toContain('/api/viventium/gateway/chat');
    expect(calls[0].headers.get('x-viventium-gateway-signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[1].url).toContain('/api/viventium/gateway/stream/stream-1');
  });

  it('persists and reuses the resolved LibreChat conversation across sequential channel turns', async () => {
    const bodies: Record<string, unknown>[] = [];
    const saved = new Map<string, string>();
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      conversationStore: {
        load: async () => saved.get('thread'),
        save: async (_envelope, conversationId) => {
          saved.set('thread', conversationId);
        },
      },
      fetchImpl: jest.fn(async (url, init) => {
        if (String(url).endsWith('/api/viventium/gateway/chat')) {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ streamId: `stream-${bodies.length}`, conversationId: 'new' });
        }
        return new Response(
          'data: {"type":"final","text":"reply","conversationId":"conversation-1"}\n\n',
          { status: 200 },
        );
      }),
    });
    const envelope: ChannelEnvelope = {
      channel: 'slack',
      accountId: 'workspace-1',
      externalUserId: 'U1',
      externalUsername: '',
      externalConversationId: 'C1',
      externalThreadId: '100.1',
      externalMessageId: '100.2',
      externalUpdateId: '',
      inputMode: 'text',
      audioRequested: false,
      text: 'hello',
      attachments: [],
    };
    await client.handle(envelope);
    await client.handle({ ...envelope, externalMessageId: '100.3', text: 'again' });

    expect(bodies[0]).not.toHaveProperty('conversationId');
    expect(bodies[1]).toMatchObject({ conversationId: 'conversation-1' });
  });

  it('never exposes a browser link token in an unlinked channel reply', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        {
          linkRequired: true,
          linkUrl: 'https://viventium.example.com/api/viventium/gateway/link/synthetic',
        },
        401,
      ),
    );
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl,
    });
    const response = await client.handle({
      channel: 'telegram',
      accountId: 'bot-1',
      externalUserId: 'U1',
      externalUsername: '',
      externalConversationId: 'C1',
      externalThreadId: '',
      externalMessageId: 'M1',
      externalUpdateId: '',
      inputMode: 'text',
      audioRequested: false,
      text: 'hello',
      attachments: [],
    });

    expect(response).not.toHaveProperty('linkUrl');
    expect(response.text).toContain('pairing code');
    expect(response.text).toContain('Settings > Channels');
    expect(response.text).not.toContain('Settings > Account');
    expect(response.text).not.toContain('https://');
  });

  it('does not repeat a completed agent turn when its final response has no channel text', async () => {
    const savedConversations: string[] = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/viventium/gateway/chat')) {
        return jsonResponse({ streamId: 'stream-empty-final', conversationId: 'new' });
      }
      return new Response(
        'data: {"type":"final","responseMessage":{"conversationId":"conversation-1","files":[{"name":"result.txt"}]}}\n\n',
        { status: 200 },
      );
    });
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl,
      conversationStore: {
        load: async () => undefined,
        save: async (_envelope, conversationId) => {
          savedConversations.push(conversationId);
        },
      },
    });

    await expect(
      client.handle({
        channel: 'slack',
        accountId: 'workspace-1',
        externalUserId: 'U1',
        externalUsername: '',
        externalConversationId: 'C1',
        externalThreadId: '',
        externalMessageId: 'M1',
        externalUpdateId: 'E1',
        inputMode: 'text',
        audioRequested: false,
        text: 'make a file',
        attachments: [],
      }),
    ).resolves.toEqual({
      text: 'I completed that request, but this channel cannot display the response. Open Viventium to view it.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(savedConversations).toEqual(['conversation-1']);
  });

  it('tells the user to open Viventium when an Agent reply also contains an attachment', async () => {
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl: jest.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/api/viventium/gateway/chat')
          ? jsonResponse({ streamId: 'stream-with-file', conversationId: 'new' })
          : new Response(
              'event: attachment\ndata: {"file_id":"file-1","filename":"result.txt"}\n\n' +
                'event: message\ndata: {"type":"final","text":"The report is ready."}\n\n',
              { status: 200 },
            ),
      ),
    });

    await expect(
      client.handle({
        channel: 'telegram',
        accountId: 'bot-1',
        externalUserId: 'U1',
        externalUsername: '',
        externalConversationId: 'C1',
        externalThreadId: '',
        externalMessageId: 'M1',
        externalUpdateId: 'E1',
        inputMode: 'text',
        audioRequested: false,
        text: 'make a report',
        attachments: [],
      }),
    ).resolves.toEqual({
      text: 'The report is ready.\n\nI also created a file. Open Viventium to view or download it.',
    });
  });

  it('discloses generated files embedded in the terminal Agent response', async () => {
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl: jest.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/api/viventium/gateway/chat')
          ? jsonResponse({ streamId: 'stream-with-terminal-file', conversationId: 'new' })
          : new Response(
              'event: message\ndata: {"type":"final","responseMessage":{"text":"The report is ready.","files":[{"name":"result.txt"}]}}\n\n',
              { status: 200 },
            ),
      ),
    });

    await expect(
      client.handle({
        channel: 'telegram',
        accountId: 'bot-1',
        externalUserId: 'U1',
        externalUsername: '',
        externalConversationId: 'C1',
        externalThreadId: '',
        externalMessageId: 'M1',
        externalUpdateId: 'E1',
        inputMode: 'text',
        audioRequested: false,
        text: 'make a report',
        attachments: [],
      }),
    ).resolves.toEqual({
      text: 'The report is ready.\n\nI also created a file. Open Viventium to view or download it.',
    });
  });

  it('rejects a terminal gateway error instead of presenting it as an empty completion', async () => {
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl: jest.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/api/viventium/gateway/chat')
          ? jsonResponse({ streamId: 'stream-error', conversationId: 'new' })
          : new Response(
              'event: error\ndata: {"error":"synthetic failure"}\n\nevent: done\ndata: {"final":true}\n\n',
              { status: 200 },
            ),
      ),
    });

    await expect(
      client.handle({
        channel: 'telegram',
        accountId: 'bot-1',
        externalUserId: 'U1',
        externalUsername: '',
        externalConversationId: 'C1',
        externalThreadId: '',
        externalMessageId: 'M1',
        externalUpdateId: 'E1',
        inputMode: 'text',
        audioRequested: false,
        text: 'hello',
        attachments: [],
      }),
    ).rejects.toThrow('Viventium channel response stream failed');
  });

  it('rejects a truncated nonterminal stream even when it contains partial text', async () => {
    const client = new ChannelGatewayClient({
      baseUrl: 'http://127.0.0.1:3190',
      secret: 'synthetic-secret',
      fetchImpl: jest.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/api/viventium/gateway/chat')
          ? jsonResponse({ streamId: 'stream-truncated', conversationId: 'new' })
          : new Response('data: {"type":"delta","text":"partial"}\n\n', { status: 200 }),
      ),
    });

    await expect(
      client.handle({
        channel: 'telegram',
        accountId: 'bot-1',
        externalUserId: 'U1',
        externalUsername: '',
        externalConversationId: 'C1',
        externalThreadId: '',
        externalMessageId: 'M1',
        externalUpdateId: 'E1',
        inputMode: 'text',
        audioRequested: false,
        text: 'hello',
        attachments: [],
      }),
    ).rejects.toThrow('Viventium channel response stream was incomplete');
  });
});
