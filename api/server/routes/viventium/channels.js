/* === VIVENTIUM START ===
 * Feature: Connected Channels admin API.
 * Purpose: Thin admin-only HTTP wiring for typed channel connection lifecycle services.
 * === VIVENTIUM END === */

const express = require('express');
const { CHANNEL_IDS, SLACK_SOCKET_MODE_MANIFEST } = require('@librechat/api');
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const {
  getChannelAdminService,
  createChannelPairingCode,
  ensureChannelSubsystemReady,
} = require('~/server/services/viventium/channelAdminService');

function isChannelId(value) {
  return CHANNEL_IDS.includes(value);
}

function resolveService(options) {
  return options?.service || getChannelAdminService();
}

function resolveReadiness(options) {
  return options?.readiness || ensureChannelSubsystemReady;
}

function getAdminUserId(req) {
  return String(req.user?._id || req.user?.id || '');
}

function sendRouteError(res, error) {
  if (error?.status === 409 && typeof error?.issueCode === 'string') {
    return res.status(409).json({
      error: 'channel_repair_rejected',
      issueCode: error.issueCode,
      message: 'New settings could not be verified. Your previous connection is still active.',
    });
  }
  const message = error instanceof Error ? error.message : '';
  const invalidInput =
    /required|too long|invalid|must start|must be a public HTTPS origin|does not match|origin is not configured/.test(
      message,
    );
  if (invalidInput) {
    return res.status(400).json({ error: 'invalid_channel_configuration', message });
  }
  return res.status(503).json({
    error: 'channel_service_unavailable',
    message: 'Connected Channels is temporarily unavailable.',
  });
}

function createChannelsRouter(options = {}) {
  const router = express.Router();
  router.use(requireJwtAuth, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(async (_req, res, next) => {
    try {
      await resolveReadiness(options)();
      next();
    } catch {
      return res.status(503).json({
        error: 'channel_service_unavailable',
        message: 'Connected Channels is temporarily unavailable.',
      });
    }
  });

  router.get('/', checkAdmin, async (_req, res) => {
    try {
      const channels = await resolveService(options).list();
      return res.status(200).json({ channels });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get('/availability', async (_req, res) => {
    try {
      const channels = await resolveService(options).availability();
      return res.status(200).json({ channels });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get('/slack/manifest', checkAdmin, (_req, res) =>
    res.status(200).json({ manifest: SLACK_SOCKET_MODE_MANIFEST }),
  );

  router.post('/:channel/connect', checkAdmin, async (req, res) => {
    const { channel } = req.params;
    if (!isChannelId(channel)) {
      return res.status(404).json({ error: 'unsupported_channel' });
    }
    try {
      const summary = await resolveService(options).connect(
        channel,
        req.body ?? {},
        getAdminUserId(req),
      );
      return res.status(200).json({ channel: summary });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post('/:channel/test', checkAdmin, async (req, res) => {
    const { channel } = req.params;
    if (!isChannelId(channel)) {
      return res.status(404).json({ error: 'unsupported_channel' });
    }
    try {
      return res.status(200).json(await resolveService(options).test(channel));
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post('/:channel/disconnect', checkAdmin, async (req, res) => {
    const { channel } = req.params;
    if (!isChannelId(channel)) {
      return res.status(404).json({ error: 'unsupported_channel' });
    }
    try {
      const summary = await resolveService(options).disconnect(channel);
      return res.status(200).json({ channel: summary });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post('/:channel/pairing-code', async (req, res) => {
    const { channel } = req.params;
    if (!isChannelId(channel)) {
      return res.status(404).json({ error: 'unsupported_channel' });
    }
    try {
      const createPairingCode = options.createPairingCode || createChannelPairingCode;
      const result = await createPairingCode(channel, getAdminUserId(req));
      return res.status(200).json({
        pairingCode: result.code,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ error: 'channel_not_configured' });
      }
      return sendRouteError(res, error);
    }
  });

  return router;
}

const router = createChannelsRouter();
router.createChannelsRouter = createChannelsRouter;

module.exports = router;
