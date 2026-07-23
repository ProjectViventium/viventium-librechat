/**
 * === VIVENTIUM START ===
 * Feature: Channel-neutral messaging contract.
 * Purpose: Prove every supported adapter reaches the existing Agents controller safely.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import {
  ChannelCredentialVault,
  ChannelRuntime,
  buildChannelAgentRequest,
  buildChannelDedupeKey,
  normalizeChannelConnectInput,
  normalizeChannelEnvelope,
  resolveLoopbackGatewayUrl,
  verifyWhatsAppSignature,
} from './index';

describe('channel-neutral messaging contract', () => {
  it.each(['telegram', 'slack', 'whatsapp'] as const)(
    'normalizes scoped %s ingress without trusting model or agent overrides',
    (channel) => {
      const envelope = normalizeChannelEnvelope({
        channel,
        accountId: ' account-1 ',
        externalUserId: ' user-1 ',
        externalConversationId: ' conversation-1 ',
        externalThreadId: ' thread-1 ',
        externalMessageId: ' message-1 ',
        text: 'hello',
        agent_id: 'attacker-agent',
        endpoint: 'openAI',
        model: 'attacker-model',
        tools: ['attacker-tool'],
      });

      expect(envelope).toEqual({
        channel,
        accountId: 'account-1',
        externalUserId: 'user-1',
        externalConversationId: 'conversation-1',
        externalThreadId: 'thread-1',
        externalMessageId: 'message-1',
        externalUpdateId: '',
        externalUsername: '',
        inputMode: 'text',
        audioRequested: false,
        text: 'hello',
        attachments: [],
      });
    },
  );

  it('preserves legacy generic gateway provider namespaces', () => {
    expect(
      normalizeChannelEnvelope({
        channel: 'Discord',
        externalUserId: 'user-1',
        externalConversationId: 'channel-1',
        text: 'hello',
      }).channel,
    ).toBe('discord');
  });

  it('preserves sanctioned voice-note metadata used by the optimized Telegram adapter', () => {
    expect(
      normalizeChannelEnvelope({
        channel: 'telegram',
        externalUserId: 'user-1',
        externalConversationId: 'chat-1',
        inputMode: 'voice_note',
        text: 'synthetic transcript',
      }).inputMode,
    ).toBe('voice_note');
  });

  it('builds an Agents request only from server-resolved control fields', () => {
    const request = buildChannelAgentRequest({
      envelope: normalizeChannelEnvelope({
        channel: 'telegram',
        accountId: 'bot-1',
        externalUserId: 'user-1',
        externalConversationId: 'chat-1',
        text: 'hello',
      }),
      resolved: {
        agentId: 'trusted-agent',
        conversationId: 'new',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        streamId: 'channel-stream',
        files: [{ file_id: 'safe-file' }],
      },
    });

    expect(request).toMatchObject({
      endpoint: 'agents',
      endpointType: 'agents',
      agent_id: 'trusted-agent',
      channel: 'telegram',
      accountId: 'bot-1',
      viventiumSurface: 'telegram',
      text: 'hello',
    });
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('tools');
  });

  it('deduplicates only within the exact channel/account/conversation/thread scope', () => {
    const base = normalizeChannelEnvelope({
      channel: 'slack',
      accountId: 'workspace-1',
      externalUserId: 'user-1',
      externalConversationId: 'channel-1',
      externalThreadId: 'thread-1',
      externalMessageId: 'message-1',
      text: 'hello',
    });
    const key = buildChannelDedupeKey(base);
    const otherAccountKey = buildChannelDedupeKey({ ...base, accountId: 'workspace-2' });
    const otherThreadKey = buildChannelDedupeKey({ ...base, externalThreadId: 'thread-2' });

    expect(key).not.toBe(otherAccountKey);
    expect(key).not.toBe(otherThreadKey);
    expect(key).toHaveLength(64);
  });

  it('uses the injected shared credential crypto contract without exposing raw secrets', async () => {
    const encrypt = jest.fn(
      async (value: string) => `shared-cipher:${Buffer.from(value).toString('base64')}`,
    );
    const decrypt = jest.fn(async (value: string) =>
      Buffer.from(value.replace('shared-cipher:', ''), 'base64').toString('utf8'),
    );
    const vault = new ChannelCredentialVault(encrypt, decrypt);
    const encrypted = await vault.encrypt({ botToken: 'synthetic-secret' });

    expect(encrypted).not.toContain('synthetic-secret');
    expect(await vault.decrypt(encrypted)).toEqual({ botToken: 'synthetic-secret' });
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('validates provider-specific connect input without returning raw secrets', () => {
    expect(
      normalizeChannelConnectInput('slack', {
        appToken: 'xapp-synthetic',
        botToken: 'xoxb-synthetic',
      }),
    ).toEqual({
      credentials: { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
      accountLabel: null,
      publicBaseUrl: null,
      state: 'verifying',
    });
    expect(() => normalizeChannelConnectInput('telegram', { botToken: '' })).toThrow(
      'botToken is required',
    );
  });

  it('accepts only a public HTTPS origin for the user-supplied WhatsApp callback edge', () => {
    expect(
      normalizeChannelConnectInput('whatsapp', {
        publicBaseUrl: 'https://api.example.test',
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'access-1',
        appSecret: 'secret-1',
        verifyToken: 'verify-1',
      }).publicBaseUrl,
    ).toBe('https://api.example.test');
    expect(
      normalizeChannelConnectInput('whatsapp', {
        publicBaseUrl: 'https://api.example.test.',
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'access-1',
        appSecret: 'secret-1',
        verifyToken: 'verify-1',
      }).publicBaseUrl,
    ).toBe('https://api.example.test');
    expect(
      normalizeChannelConnectInput('whatsapp', {
        publicBaseUrl: 'https://[::ffff:8.8.8.8]',
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'access-1',
        appSecret: 'secret-1',
        verifyToken: 'verify-1',
      }).publicBaseUrl,
    ).toBe('https://[::ffff:808:808]');
    for (const publicBaseUrl of [
      'http://api.example.test',
      'https://localhost:3180',
      'https://localhost.:3180',
      'https://service.localhost.',
      'https://printer.local.',
      'https://127.0.0.1:3180',
      'https://0.0.0.0',
      'https://192.168.1.4',
      'https://[::]',
      'https://[::ffff:10.0.0.1]',
      'https://[::ffff:172.16.0.1]',
      'https://[::ffff:192.168.1.4]',
      'https://[fec0::1]',
      'https://[feff::1]',
      'https://api.example.test/private-path',
      'https://user:password@api.example.test',
    ]) {
      expect(() =>
        normalizeChannelConnectInput('whatsapp', {
          publicBaseUrl,
          phoneNumberId: 'phone-1',
          businessAccountId: 'business-1',
          accessToken: 'access-1',
          appSecret: 'secret-1',
          verifyToken: 'verify-1',
        }),
      ).toThrow('publicBaseUrl must be a public HTTPS origin without a path');
    }
  });

  it('verifies the official WhatsApp signature against the exact raw request bytes', () => {
    const body = Buffer.from('{"entry":[]}');
    const secret = 'synthetic-app-secret';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

    expect(verifyWhatsAppSignature(body, signature, secret)).toBe(true);
    expect(verifyWhatsAppSignature(Buffer.from('{"entry":[1]}'), signature, secret)).toBe(false);
  });

  it('never sends the gateway shared secret to a public configured origin', () => {
    expect(resolveLoopbackGatewayUrl('https://public.example.com', 3190)).toBe(
      'http://127.0.0.1:3190',
    );
    expect(resolveLoopbackGatewayUrl('http://127.0.0.1:4190', 3190)).toBe('http://127.0.0.1:4190');
  });

  it('restores and dispatches only through an explicitly registered transport', async () => {
    const delivered: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'telegram',
      start: async (connection) => delivered.push(`start:${connection.accountId}`),
      stop: async () => delivered.push('stop'),
      test: async () => ({ ok: true, displayName: '@synthetic_bot' }),
      send: async (message) => delivered.push(`send:${message.text}`),
    });

    await runtime.restore([
      {
        channel: 'telegram',
        accountId: 'bot-1',
        credentials: { botToken: 'synthetic-token' },
      },
    ]);
    await runtime.send({
      channel: 'telegram',
      accountId: 'bot-1',
      externalConversationId: 'chat-1',
      externalThreadId: '',
      text: 'reply',
    });

    expect(delivered).toEqual(['start:bot-1', 'send:reply']);
  });
});
