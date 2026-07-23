/* === VIVENTIUM START ===
 * Feature: Official WhatsApp Cloud API callback.
 * Purpose: Verify opaque connection scope and raw-body HMAC before parsing untrusted events.
 * === VIVENTIUM END === */

const express = require('express');
const { constantTimeSecretEqual, verifyWhatsAppSignature } = require('@librechat/api');
const {
  getChannelAdminService,
  handleWhatsAppWebhook,
  ensureChannelSubsystemReady,
} = require('~/server/services/viventium/channelAdminService');

function resolveService(options) {
  return options?.service || getChannelAdminService();
}

function resolveReadiness(options) {
  return options?.readiness || ensureChannelSubsystemReady;
}

function createChannelsWebhookRouter(options = {}) {
  const router = express.Router();

  router.use(async (_req, res, next) => {
    try {
      await resolveReadiness(options)();
      next();
    } catch {
      return res.status(503).json({ error: 'channel_transport_unavailable' });
    }
  });

  router.get('/:callbackId', async (req, res) => {
    const secrets = await resolveService(options).getWhatsAppWebhookSecrets(req.params.callbackId);
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : '';
    const verifyToken =
      typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
    const challenge =
      typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';
    if (
      !secrets ||
      mode !== 'subscribe' ||
      !challenge ||
      !constantTimeSecretEqual(secrets.verifyToken, verifyToken)
    ) {
      return res.status(403).json({ error: 'webhook_verification_failed' });
    }
    const marked = await resolveService(options).markWhatsAppWebhookVerified(req.params.callbackId);
    if (!marked) {
      return res.status(503).json({ error: 'channel_transport_unavailable' });
    }
    return res.status(200).type('text/plain').send(challenge);
  });

  router.post('/:callbackId', async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'raw_json_body_required' });
    }
    const secrets = await resolveService(options).getWhatsAppWebhookSecrets(req.params.callbackId);
    const signature =
      typeof req.get('x-hub-signature-256') === 'string'
        ? req.get('x-hub-signature-256')
        : undefined;
    if (!secrets || !verifyWhatsAppSignature(req.body, signature, secrets.appSecret)) {
      return res.status(401).json({ error: 'invalid_webhook_signature' });
    }
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid_webhook_payload' });
    }
    const onWebhook = options.onWebhook || handleWhatsAppWebhook;
    if (!onWebhook) {
      return res.status(503).json({ error: 'channel_transport_unavailable' });
    }
    try {
      await onWebhook(payload, req.params.callbackId);
      return res.status(202).json({ accepted: true });
    } catch {
      return res.status(503).json({ error: 'channel_transport_unavailable' });
    }
  });

  return router;
}

const router = createChannelsWebhookRouter();
router.createChannelsWebhookRouter = createChannelsWebhookRouter;

module.exports = router;
