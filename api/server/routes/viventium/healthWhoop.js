/* === VIVENTIUM START ===
 * Feature: Admin-only WHOOP owner onboarding.
 * Purpose: Expose the local health courier without making host-wide health state multi-tenant or
 * placing secrets, OAuth callbacks, and export bytes in process arguments or logs.
 * === VIVENTIUM END === */

const express = require('express');
const {
  WhoopHealthError,
  beginWhoopAuthorization,
  completeWhoopOnboarding,
  configureWhoopClient,
  disconnectWhoop,
  getWhoopStatus,
  importWhoopExport,
  importWhoopEvidence,
  isEnabled,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { checkAdmin, requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const parseExportBody = express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: '100mb',
});
const parseEvidenceBody = express.raw({
  type: ['image/png', 'image/jpeg'],
  limit: '10mb',
});

function whoopEnabled() {
  return (
    isEnabled(process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH) &&
    isEnabled(process.env.VIVENTIUM_HEALTH_ENABLED)
  );
}

function requireWhoopEnabled(_req, res, next) {
  if (!whoopEnabled()) {
    return res.status(404).json({ error: 'whoop_not_enabled' });
  }
  return next();
}

function requireExportContentType(req, res, next) {
  if (!req.is('application/zip') && !req.is('application/octet-stream')) {
    return res.status(415).json({ error: 'whoop_export_type_unsupported' });
  }
  return next();
}

function requireEvidenceContentType(req, res, next) {
  if (!req.is('image/png') && !req.is('image/jpeg')) {
    return res.status(415).json({ error: 'whoop_evidence_type_unsupported' });
  }
  return next();
}

function safeFailure(error, res) {
  const known = error instanceof WhoopHealthError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'whoop_operation_failed';
  logger.error('[Viventium][Health][WHOOP] Local owner operation failed', {
    errorCode: code,
    errorClass: error?.constructor?.name || 'Error',
  });
  return res.status(status).json({
    error: code,
    message: 'The WHOOP operation could not be completed from this local runtime.',
  });
}

const ownerOnly = [requireWhoopEnabled, requireJwtAuth, checkAdmin];

router.get('/status', ...ownerOnly, async (_req, res) => {
  try {
    return res.status(200).json(await getWhoopStatus());
  } catch (error) {
    return safeFailure(error, res);
  }
});

router.post('/configure', ...ownerOnly, async (req, res) => {
  try {
    return res.status(200).json(
      await configureWhoopClient({
        clientId: req.body?.clientId,
        clientSecret: req.body?.clientSecret,
        redirectUri: req.body?.redirectUri,
      }),
    );
  } catch (error) {
    return safeFailure(error, res);
  }
});

router.post('/authorize', ...ownerOnly, async (_req, res) => {
  try {
    return res.status(200).json(await beginWhoopAuthorization());
  } catch (error) {
    return safeFailure(error, res);
  }
});

router.post('/complete', ...ownerOnly, async (req, res) => {
  try {
    return res.status(202).json(await completeWhoopOnboarding(req.body?.callbackUrl));
  } catch (error) {
    return safeFailure(error, res);
  }
});

router.post(
  '/import',
  ...ownerOnly,
  requireExportContentType,
  parseExportBody,
  async (req, res) => {
    try {
      return res.status(200).json(await importWhoopExport(req.body));
    } catch (error) {
      return safeFailure(error, res);
    }
  },
);

router.post(
  '/evidence',
  ...ownerOnly,
  requireEvidenceContentType,
  parseEvidenceBody,
  async (req, res) => {
    try {
      const mediaType = req.is('image/png') ? 'image/png' : 'image/jpeg';
      return res.status(200).json(await importWhoopEvidence(req.body, mediaType));
    } catch (error) {
      return safeFailure(error, res);
    }
  },
);

router.post('/disconnect', ...ownerOnly, async (_req, res) => {
  try {
    return res.status(200).json(await disconnectWhoop());
  } catch (error) {
    return safeFailure(error, res);
  }
});

router.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    logger.error('[Viventium][Health][WHOOP] Upload rejected by local size boundary', {
      errorCode: 'whoop_upload_too_large',
      errorClass: error?.constructor?.name || 'Error',
    });
    return res.status(413).json({
      error: 'whoop_upload_too_large',
      message: 'The WHOOP upload exceeded the local size limit.',
    });
  }
  return safeFailure(error, res);
});

module.exports = router;
