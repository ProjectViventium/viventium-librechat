/* === VIVENTIUM START ===
 * Feature: Authenticated Feelings profile/state API.
 * Purpose: Expose the package-owned Feelings domain through authenticated transport without
 * client-supplied user identity or duplicate route-level state rules.
 * === VIVENTIUM END === */

const express = require('express');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const {
  FEELING_BANDS,
  FEELING_BAND_IDS,
  FEELING_LEVEL_IDS,
  MAX_FEELING_RANGE_PROMPT_CHARS,
  DEFAULT_REACTION_INSTRUCTION,
  loadFeelingsReadContext,
  createInitialFeelingState,
  prepareManualFeelingPatch,
  updateFeelingRangePromptOverride,
  clearFeelingsReadCache,
  resolveFeelingsRuntimeConfig,
} = require('@librechat/api');
const {
  getFeelingState,
  createFeelingStateIfMissing,
  updateFeelingState,
  deleteFeelingState,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const { logFeelingsEvent } = require('~/server/services/viventium/feelingsTelemetry');

const router = express.Router();
const bodyLimit = express.json({ limit: '32kb' });

const profileSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    enabled: z.boolean().optional(),
    reactionInstruction: z.string().trim().max(4000).optional(),
    reactionActivationMode: z.enum(['always', 'classified', 'disabled']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.enabled != null ||
      value.reactionInstruction != null ||
      value.reactionActivationMode != null,
    'At least one profile field is required',
  );

const bandSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    baseline: z.number().min(0).max(100).optional(),
    current: z.number().min(0).max(100).optional(),
    halfLifeMinutes: z.number().min(1).max(525600).optional(),
    enabled: z.boolean().optional(),
    reset: z.boolean().optional(),
    rangePromptOverride: z
      .object({
        levelId: z.enum(FEELING_LEVEL_IDS),
        instruction: z.string().trim().min(1).max(MAX_FEELING_RANGE_PROMPT_CHARS).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.baseline != null ||
      value.current != null ||
      value.halfLifeMinutes != null ||
      value.enabled != null ||
      value.reset === true ||
      value.rangePromptOverride != null,
    'At least one band field is required',
  );

const versionSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();

router.use(requireJwtAuth);

function errorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function requireFeelingsAvailable(_req, res, next) {
  if (resolveFeelingsRuntimeConfig().available) return next();
  return res
    .status(503)
    .json(errorBody('FEELINGS_UNAVAILABLE', 'Feelings is unavailable in this runtime.'));
}

async function ensureState(userId) {
  return createFeelingStateIfMissing({
    userId,
    state: createInitialFeelingState(),
  });
}

async function readSnapshot(userId, bypassCache = false) {
  return loadFeelingsReadContext({
    userId,
    getFeelingState,
    bypassCache,
  });
}

function responsePayload(state) {
  const config = resolveFeelingsRuntimeConfig();
  return {
    definitions: FEELING_BANDS,
    config: {
      available: config.available,
      agentScope: config.agentScope,
      reaction: {
        defaultInstruction: DEFAULT_REACTION_INSTRUCTION,
        activationMode: config.reaction.activationMode,
        provider: config.reaction.provider,
        model: config.reaction.model,
        useResponsesApi: config.reaction.useResponsesApi,
        reasoningEffort: config.reaction.reasoningEffort,
        fast: config.reaction.fast,
        serviceTier: config.reaction.serviceTier,
        fallbackProvider: config.reaction.fallbackProvider,
        fallbackModel: config.reaction.fallbackModel,
      },
    },
    state,
  };
}

async function finishMutation(req, res, result, startedAt, telemetry = {}) {
  const userId = String(req.user.id);
  if (!result) {
    logFeelingsEvent(
      logger,
      req,
      'feelings.api.conflict',
      {
        route: req.route?.path || 'unknown',
        durationMs: Date.now() - startedAt,
      },
      'warn',
    );
    return res
      .status(409)
      .json(
        errorBody(
          'FEELINGS_VERSION_CONFLICT',
          'Feelings changed in another request. Refresh and retry.',
        ),
      );
  }
  clearFeelingsReadCache(userId);
  const state = await readSnapshot(userId, true);
  logFeelingsEvent(logger, req, 'feelings.api.write', {
    route: req.route?.path || 'unknown',
    version: state.version,
    rangePromptOverrideCount: state.rangePromptOverrideCount,
    activeRangePromptOverrideCount: state.activeRangePromptOverrideCount,
    activeRangePromptOverrideChars: state.activeRangePromptOverrideChars,
    ...telemetry,
    durationMs: Date.now() - startedAt,
  });
  return res.json(responsePayload(state));
}

router.get('/', async (req, res) => {
  const startedAt = Date.now();
  try {
    const state = await readSnapshot(String(req.user.id));
    logFeelingsEvent(logger, req, 'feelings.api.read', {
      enabled: state.enabled,
      hasInnerState: Boolean(state.innerState?.text),
      version: state.version,
      cacheHit: state.cacheHit === true,
      rangePromptOverrideCount: state.rangePromptOverrideCount,
      activeRangePromptOverrideCount: state.activeRangePromptOverrideCount,
      activeRangePromptOverrideChars: state.activeRangePromptOverrideChars,
      durationMs: Date.now() - startedAt,
    });
    return res.json(responsePayload(state));
  } catch (_error) {
    logFeelingsEvent(
      logger,
      req,
      'feelings.api.failure',
      {
        route: 'GET /',
        errorClass: 'state_read_failed',
        durationMs: Date.now() - startedAt,
      },
      'error',
    );
    return res.status(500).json(errorBody('FEELINGS_READ_FAILED', 'Unable to load Feelings.'));
  }
});

router.patch('/profile', bodyLimit, requireFeelingsAvailable, async (req, res) => {
  const startedAt = Date.now();
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json(
        errorBody(
          'FEELINGS_VALIDATION_ERROR',
          'Invalid Feelings profile update.',
          parsed.error.flatten(),
        ),
      );
  }
  try {
    const userId = String(req.user.id);
    await ensureState(userId);
    const { expectedVersion, ...set } = parsed.data;
    if (typeof set.enabled === 'boolean') set.innerState = null;
    const result = await updateFeelingState({ userId, expectedVersion, set });
    return finishMutation(req, res, result, startedAt);
  } catch (_error) {
    logFeelingsEvent(
      logger,
      req,
      'feelings.api.failure',
      {
        route: 'PATCH /profile',
        errorClass: 'profile_write_failed',
        durationMs: Date.now() - startedAt,
      },
      'error',
    );
    return res.status(500).json(errorBody('FEELINGS_WRITE_FAILED', 'Unable to update Feelings.'));
  }
});

router.patch('/bands/:bandId', bodyLimit, requireFeelingsAvailable, async (req, res) => {
  const startedAt = Date.now();
  const bandId = String(req.params.bandId || '').toLowerCase();
  if (!FEELING_BAND_IDS.includes(bandId)) {
    return res.status(404).json(errorBody('FEELINGS_BAND_NOT_FOUND', 'Unknown feeling band.'));
  }
  const parsed = bandSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json(
        errorBody(
          'FEELINGS_VALIDATION_ERROR',
          'Invalid feeling band update.',
          parsed.error.flatten(),
        ),
      );
  }
  try {
    const userId = String(req.user.id);
    await ensureState(userId);
    const snapshot = await readSnapshot(userId, true);
    const { expectedVersion, rangePromptOverride, ...change } = parsed.data;
    const hasBandStateChange = Object.keys(change).length > 0;
    const prepared = hasBandStateChange
      ? prepareManualFeelingPatch({ bands: snapshot.bands, bandId, change })
      : null;
    const set = { innerState: null };
    if (prepared) set[`bands.${bandId}`] = prepared.band;
    if (rangePromptOverride) {
      set.rangePromptOverrides = updateFeelingRangePromptOverride({
        overrides: snapshot.rangePromptOverrides,
        bandId,
        levelId: rangePromptOverride.levelId,
        instruction: rangePromptOverride.instruction,
      });
    }
    const result = await updateFeelingState({
      userId,
      expectedVersion,
      set,
      trailEntries: prepared?.trail ?? [],
    });
    return finishMutation(req, res, result, startedAt, {
      ...(rangePromptOverride
        ? {
            bandId,
            rangeLevelId: rangePromptOverride.levelId,
            rangePromptOverrideChanged: true,
            rangePromptOverridePresent: Boolean(rangePromptOverride.instruction?.trim()),
          }
        : {}),
    });
  } catch (_error) {
    logFeelingsEvent(
      logger,
      req,
      'feelings.api.failure',
      {
        route: 'PATCH /bands/:bandId',
        errorClass: 'band_write_failed',
        durationMs: Date.now() - startedAt,
      },
      'error',
    );
    return res
      .status(500)
      .json(errorBody('FEELINGS_WRITE_FAILED', 'Unable to update this feeling.'));
  }
});

router.post('/reset', bodyLimit, requireFeelingsAvailable, async (req, res) => {
  const startedAt = Date.now();
  const parsed = versionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json(errorBody('FEELINGS_VALIDATION_ERROR', 'Expected version is required.'));
  }
  try {
    const userId = String(req.user.id);
    await ensureState(userId);
    const snapshot = await readSnapshot(userId, true);
    const set = {};
    const trailEntries = [];
    for (const bandId of FEELING_BAND_IDS) {
      const prepared = prepareManualFeelingPatch({
        bands: snapshot.bands,
        bandId,
        change: { reset: true },
      });
      set[`bands.${bandId}`] = prepared.band;
      trailEntries.push(...prepared.trail);
    }
    set.innerState = null;
    const result = await updateFeelingState({
      userId,
      expectedVersion: parsed.data.expectedVersion,
      set,
      trailEntries,
    });
    return finishMutation(req, res, result, startedAt);
  } catch (_error) {
    return res.status(500).json(errorBody('FEELINGS_WRITE_FAILED', 'Unable to reset Feelings.'));
  }
});

router.delete('/', bodyLimit, async (req, res) => {
  const startedAt = Date.now();
  const parsed = versionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json(errorBody('FEELINGS_VALIDATION_ERROR', 'Expected version is required.'));
  }
  try {
    const userId = String(req.user.id);
    const deleted = await deleteFeelingState(userId, parsed.data.expectedVersion);
    if (!deleted) {
      return res
        .status(409)
        .json(
          errorBody(
            'FEELINGS_VERSION_CONFLICT',
            'Feelings changed before this erase. Reload and try again.',
          ),
        );
    }
    clearFeelingsReadCache(userId);
    logFeelingsEvent(logger, req, 'feelings.api.delete', {
      deleted,
      durationMs: Date.now() - startedAt,
    });
    return res.json({ deleted });
  } catch (_error) {
    return res.status(500).json(errorBody('FEELINGS_DELETE_FAILED', 'Unable to erase Feelings.'));
  }
});

module.exports = router;
