/* === VIVENTIUM START ===
 * Feature: Account-wide adaptive parallel-work preference.
 * Purpose: Give Telegram, web, voice, and future surfaces one authenticated source of truth.
 * Security: User identity comes only from JWT middleware; caller-supplied identity is rejected.
 * === VIVENTIUM END === */

const express = require('express');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const {
  getUserById,
  updateUserViventiumOrchestrationPreferences,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  getActiveWorkInteractiveSnapshot,
  getActiveWorkPage,
} = require('~/server/services/viventium/GlassHiveAccountService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');
const {
  effectiveOrchestrationMode,
  parallelWorkAvailable,
} = require('~/server/services/viventium/ViventiumOrchestrationMode');
const {
  observeOrchestrationOwner,
  refreshOrchestrationReadiness,
} = require('~/server/services/viventium/GlassHiveOrchestrationReadinessService');

const router = express.Router();
const bodyLimit = express.json({ limit: '4kb' });
const preferenceSchema = z.object({ mode: z.enum(['focused', 'parallel']) }).strict();
const workRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const actionSchema = z
  .object({
    action: z.enum(['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss']),
    instruction: z.string().trim().min(1).max(8000).optional(),
    operationId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (['queue', 'message', 'steer'].includes(value.action) && !value.instruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: `${value.action} requires an instruction`,
      });
    }
  });

router.use(requireJwtAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  next();
});

const responseBody = (user) => {
  const available = parallelWorkAvailable();
  return {
    available,
    mode: effectiveOrchestrationMode(user, { available }),
    hasKnownWork: user?.personalization?.parallel_work_known === true,
  };
};

router.get('/', async (req, res) => {
  try {
    observeOrchestrationOwner(String(req.user.id));
    const user = await getUserById(
      String(req.user.id),
      'personalization.orchestration_mode personalization.parallel_work_known',
    );
    if (!user) {
      return res
        .status(404)
        .json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
    }
    return res.json(responseBody(user));
  } catch (error) {
    logger.error('[VIVENTIUM][orchestration] Failed to read account preference', {
      requestId: req.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: { code: 'ORCHESTRATION_READ_FAILED', message: 'Unable to read Parallel work.' },
    });
  }
});

router.patch('/', bodyLimit, async (req, res) => {
  const ownerId = String(req.user.id);
  observeOrchestrationOwner(ownerId);
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'INVALID_ORCHESTRATION_PREFERENCE',
        message: 'Mode must be focused or parallel.',
      },
    });
  }
  if (parsed.data.mode === 'parallel' && !parallelWorkAvailable()) {
    await refreshOrchestrationReadiness({ ownerId });
  }
  if (parsed.data.mode === 'parallel' && !parallelWorkAvailable()) {
    return res.status(409).json({
      error: {
        code: 'PARALLEL_WORK_UNAVAILABLE',
        message: 'Parallel work is not available in this runtime yet.',
      },
    });
  }

  try {
    const user = await updateUserViventiumOrchestrationPreferences(ownerId, parsed.data);
    if (!user) {
      return res
        .status(404)
        .json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
    }
    logger.info('[VIVENTIUM][orchestration] Account preference updated', {
      requestId: req.id,
      mode: parsed.data.mode,
    });
    return res.json(responseBody(user));
  } catch (error) {
    logger.error('[VIVENTIUM][orchestration] Failed to update account preference', {
      requestId: req.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: { code: 'ORCHESTRATION_UPDATE_FAILED', message: 'Unable to update Parallel work.' },
    });
  }
});

router.get('/work', async (req, res) => {
  const cursor = String(req.query?.cursor || '').trim();
  const limit = Number(req.query?.limit || 50);
  if (
    (cursor && (cursor.length > 2048 || !/^[A-Za-z0-9._~:@+-]+$/.test(cursor))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return res.status(400).json({
      error: { code: 'INVALID_ACTIVE_WORK_CURSOR', message: 'The Active work page is invalid.' },
    });
  }
  try {
    return res.json(
      cursor
        ? await getActiveWorkPage({ ownerId: String(req.user.id), cursor, limit })
        : await getActiveWorkInteractiveSnapshot({ ownerId: String(req.user.id) }),
    );
  } catch (error) {
    logger.error('[VIVENTIUM][orchestration] Failed to read active work', {
      requestId: req.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: { code: 'ACTIVE_WORK_READ_FAILED', message: 'Unable to read Active work.' },
    });
  }
});

router.post('/work/:workRef/actions', bodyLimit, async (req, res) => {
  const workRef = workRefSchema.safeParse(req.params.workRef);
  const action = actionSchema.safeParse(req.body);
  if (!workRef.success || !action.success) {
    return res.status(400).json({
      error: { code: 'INVALID_WORK_ACTION', message: 'The Active work action is invalid.' },
    });
  }

  const ownerId = String(req.user.id);
  const { operationId, ...safeAction } = action.data;
  try {
    const result = await executeGlassHiveWorkAction({
      ownerId,
      workRef: workRef.data,
      operationId,
      ...safeAction,
    });
    return res.status(202).json(result);
  } catch (error) {
    logger.warn('[VIVENTIUM][orchestration] Active work action rejected', {
      requestId: req.id,
      action: action.data.action,
      status: error?.status || 502,
      code: error?.message || 'glasshive_account_rejected',
    });
    const status = Number(error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502).json({
      error: {
        code: error?.message || 'ACTIVE_WORK_ACTION_FAILED',
        message: error?.userMessage || 'Unable to apply the Active work action.',
      },
    });
  }
});

module.exports = router;
