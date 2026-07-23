/**
 * === VIVENTIUM START ===
 * Feature: Official WhatsApp Cloud API callback.
 * Purpose: Prove opaque record selection and raw-body signature verification happen before parsing.
 * === VIVENTIUM END ===
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock(
  '@librechat/api',
  () => {
    const actualCrypto = require('crypto');
    return {
      constantTimeSecretEqual: (expected, provided) => {
        const left = actualCrypto.createHash('sha256').update(expected).digest();
        const right = actualCrypto.createHash('sha256').update(provided).digest();
        return actualCrypto.timingSafeEqual(left, right);
      },
      verifyWhatsAppSignature: (body, signature, secret) => {
        const expected = `sha256=${actualCrypto.createHmac('sha256', secret).update(body).digest('hex')}`;
        return signature === expected;
      },
    };
  },
  { virtual: true },
);

jest.mock('~/server/services/viventium/channelAdminService', () => ({
  getChannelAdminService: () => {
    throw new Error('test must inject its service');
  },
  ensureChannelSubsystemReady: jest.fn(async () => undefined),
}));

function createApp({ service, onWebhook, readiness = async () => undefined }) {
  const { createChannelsWebhookRouter } = require('../channelsWebhook');
  const app = express();
  app.use(
    '/api/viventium/channels/whatsapp/webhook',
    express.raw({ type: 'application/json' }),
    createChannelsWebhookRouter({ service, onWebhook, readiness }),
  );
  return app;
}

describe('WhatsApp channel webhook', () => {
  const callbackId = '0123456789abcdef0123456789abcdef';
  const appSecret = 'synthetic-app-secret';
  const verifyToken = 'synthetic-verify-token';

  function createService() {
    return {
      getWhatsAppWebhookSecrets: jest.fn(async (receivedCallbackId) =>
        receivedCallbackId === callbackId ? { appSecret, verifyToken } : null,
      ),
      markWhatsAppWebhookVerified: jest.fn(
        async (receivedCallbackId) => receivedCallbackId === callbackId,
      ),
    };
  }

  it('answers Meta verification only for the opaque connection and constant-time token match', async () => {
    const service = createService();
    await request(createApp({ service, onWebhook: jest.fn() }))
      .get(
        `/api/viventium/channels/whatsapp/webhook/${callbackId}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`,
      )
      .expect(200)
      .expect('12345');

    await request(createApp({ service, onWebhook: jest.fn() }))
      .get(
        `/api/viventium/channels/whatsapp/webhook/${callbackId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`,
      )
      .expect(403);

    expect(service.getWhatsAppWebhookSecrets).toHaveBeenCalledTimes(2);
    expect(service.markWhatsAppWebhookVerified).toHaveBeenCalledTimes(1);
  });

  it('verifies exact raw bytes before parsing and invoking the injected adapter', async () => {
    const service = createService();
    const onWebhook = jest.fn(async () => undefined);
    const rawBody = Buffer.from('{"entry":[]}');
    const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;

    await request(createApp({ service, onWebhook }))
      .post(`/api/viventium/channels/whatsapp/webhook/${callbackId}`)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(rawBody.toString('utf8'))
      .expect(202)
      .expect({ accepted: true });

    expect(onWebhook).toHaveBeenCalledWith({ entry: [] }, callbackId);
  });

  it('rejects invalid signatures and unavailable adapters without acknowledging delivery', async () => {
    const service = createService();
    const onWebhook = jest.fn(async () => undefined);
    await request(createApp({ service, onWebhook }))
      .post(`/api/viventium/channels/whatsapp/webhook/${callbackId}`)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=bad')
      .send('{"entry":[]}')
      .expect(401);
    expect(onWebhook).not.toHaveBeenCalled();

    const rawBody = Buffer.from('{"entry":[]}');
    const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    await request(createApp({ service }))
      .post(`/api/viventium/channels/whatsapp/webhook/${callbackId}`)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(rawBody.toString('utf8'))
      .expect(503)
      .expect({ error: 'channel_transport_unavailable' });
  });

  it('fails closed before reading secrets or invoking adapters when persistence is unavailable', async () => {
    const service = createService();
    const onWebhook = jest.fn();
    const readiness = jest.fn(async () => {
      throw new Error('indexes unavailable');
    });

    await request(createApp({ service, onWebhook, readiness }))
      .get(
        `/api/viventium/channels/whatsapp/webhook/${callbackId}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`,
      )
      .expect(503);
    await request(createApp({ service, onWebhook, readiness }))
      .post(`/api/viventium/channels/whatsapp/webhook/${callbackId}`)
      .set('content-type', 'application/json')
      .send('{"entry":[]}')
      .expect(503);

    expect(service.getWhatsAppWebhookSecrets).not.toHaveBeenCalled();
    expect(service.markWhatsAppWebhookVerified).not.toHaveBeenCalled();
    expect(onWebhook).not.toHaveBeenCalled();
  });
});
