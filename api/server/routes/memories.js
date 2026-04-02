const express = require('express');
const {
  evaluateMemoryWrite,
  generateCheckAccess,
  prepareMemoryValueForWrite,
  runMemoryMaintenance,
} = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAllUserMemories,
  toggleUserMemories,
  updateUserPersonalization,
  createMemory,
  deleteMemory,
  setMemory,
} = require('~/models');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const { getRoleByName } = require('~/models/Role');
/* === VIVENTIUM START ===
 * Feature: Conversation Recall RAG refresh on personalization changes
 * Added: 2026-02-19
 */
const {
  scheduleConversationRecallRefresh,
} = require('~/server/services/viventium/conversationRecallService');
const { resolveMemoryTokenLimit } = require('~/server/services/viventium/memoryTokenLimit');
/* === VIVENTIUM END === */

const router = express.Router();

const memoryPayloadLimit = express.json({ limit: '100kb' });

const checkMemoryRead = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.READ],
  getRoleByName,
});
const checkMemoryCreate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const checkMemoryUpdate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryDelete = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryOptOut = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.OPT_OUT],
  getRoleByName,
});

router.use(requireJwtAuth);

function getMemoryPolicy(config) {
  const memoryConfig = config?.memory ?? {};
  return {
    validKeys: memoryConfig.validKeys,
    tokenLimit: resolveMemoryTokenLimit(memoryConfig.tokenLimit),
    keyLimits: memoryConfig.keyLimits,
    maintenanceThresholdPercent: memoryConfig.maintenanceThresholdPercent,
  };
}

async function runRouteMemoryMaintenance({ userId, policy }) {
  await runMemoryMaintenance({
    userId: String(userId),
    getAllUserMemories: async (resolvedUserId) => getAllUserMemories(resolvedUserId),
    setMemory: async ({ userId: maintenanceUserId, key, value, tokenCount }) =>
      setMemory({
        userId: maintenanceUserId,
        key,
        value,
        tokenCount,
      }),
    policy,
  });
}

/**
 * GET /memories
 * Returns all memories for the authenticated user, sorted by updated_at (newest first).
 * Also includes memory usage percentage based on token limit.
 */
router.get('/', checkMemoryRead, configMiddleware, async (req, res) => {
  try {
    const memories = await getAllUserMemories(req.user.id);

    const sortedMemories = memories.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

    const totalTokens = memories.reduce((sum, memory) => {
      return sum + (memory.tokenCount || 0);
    }, 0);

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = resolveMemoryTokenLimit(memoryConfig?.tokenLimit);
    const charLimit = memoryConfig?.charLimit || 10000;

    let usagePercentage = null;
    if (tokenLimit && tokenLimit > 0) {
      usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
    }

    res.json({
      memories: sortedMemories,
      totalTokens,
      tokenLimit: tokenLimit || null,
      charLimit,
      usagePercentage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /memories
 * Creates a new memory entry for the authenticated user.
 * Body: { key: string, value: string }
 * Returns 201 and { created: true, memory: <createdDoc> } when successful.
 */
router.post('/', memoryPayloadLimit, checkMemoryCreate, configMiddleware, async (req, res) => {
  const { key, value } = req.body;

  if (typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ error: 'Key is required and must be a non-empty string.' });
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (key.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${key.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  try {
    const memories = await getAllUserMemories(req.user.id);
    const memoryPolicy = getMemoryPolicy(req.config);
    const preparedValue = prepareMemoryValueForWrite({
      key: key.trim(),
      value: value.trim(),
      keyLimits: memoryPolicy.keyLimits,
    });
    const nextValue = preparedValue.value;
    const tokenCount = preparedValue.tokenCount;
    const currentTotalTokens = memories.reduce((sum, memory) => sum + (memory.tokenCount || 0), 0);
    const evaluation = evaluateMemoryWrite({
      key: key.trim(),
      value: nextValue,
      tokenCount,
      validKeys: memoryPolicy.validKeys,
      tokenLimit: memoryPolicy.tokenLimit,
      keyLimits: memoryPolicy.keyLimits,
      baselineTotalTokens: currentTotalTokens,
      previousTokenCount: 0,
    });
    if (!evaluation.ok) {
      return res.status(400).json({
        error: evaluation.message,
        details: evaluation.details,
      });
    }

    const result = await createMemory({
      userId: req.user.id,
      key: key.trim(),
      value: nextValue,
      tokenCount,
    });

    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to create memory.' });
    }

    await runRouteMemoryMaintenance({
      userId: req.user.id,
      policy: memoryPolicy,
    });

    const updatedMemories = await getAllUserMemories(req.user.id);
    const newMemory = updatedMemories.find((m) => m.key === key.trim());

    res.status(201).json({ created: true, memory: newMemory });
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
      return res.status(409).json({ error: 'Memory with this key already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/preferences
 * Updates the user's memory preferences (e.g., enabling/disabling memories).
 * Body: { memories?: boolean, conversation_recall?: boolean }
 * Returns 200 and resolved preferences when successful.
 */
router.patch('/preferences', checkMemoryOptOut, async (req, res) => {
  const { memories, conversation_recall } = req.body ?? {};
  const hasMemories = typeof memories === 'boolean';
  const hasConversationRecall = typeof conversation_recall === 'boolean';

  if (!hasMemories && !hasConversationRecall) {
    return res.status(400).json({
      error:
        'At least one boolean preference must be provided: memories and/or conversation_recall.',
    });
  }

  try {
    const updatedUser =
      hasMemories && !hasConversationRecall
        ? await toggleUserMemories(req.user.id, memories)
        : await updateUserPersonalization(req.user.id, {
            ...(hasMemories ? { memories } : {}),
            ...(hasConversationRecall ? { conversation_recall } : {}),
          });

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (hasConversationRecall) {
      scheduleConversationRecallRefresh({
        userId: req.user.id,
      });
    }

    res.json({
      updated: true,
      preferences: {
        memories: updatedUser.personalization?.memories ?? true,
        conversation_recall: updatedUser.personalization?.conversation_recall ?? false,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/:key
 * Updates the value of an existing memory entry for the authenticated user.
 * Body: { key?: string, value: string }
 * Returns 200 and { updated: true, memory: <updatedDoc> } when successful.
 */
router.patch('/:key', memoryPayloadLimit, checkMemoryUpdate, configMiddleware, async (req, res) => {
  const { key: urlKey } = req.params;
  const { key: bodyKey, value } = req.body || {};

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const newKey = bodyKey || urlKey;
  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (newKey.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${newKey.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  try {
    const memories = await getAllUserMemories(req.user.id);
    const existingMemory = memories.find((m) => m.key === urlKey);
    const memoryPolicy = getMemoryPolicy(req.config);
    const currentTotalTokens = memories.reduce((sum, memory) => sum + (memory.tokenCount || 0), 0);
    const preparedValue = prepareMemoryValueForWrite({
      key: newKey,
      value,
      keyLimits: memoryPolicy.keyLimits,
    });
    const nextValue = preparedValue.value;
    const tokenCount = preparedValue.tokenCount;

    if (!existingMemory) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    if (newKey !== urlKey) {
      const keyExists = memories.find((m) => m.key === newKey);
      if (keyExists) {
        return res.status(409).json({ error: 'Memory with this key already exists.' });
      }

      const createEvaluation = evaluateMemoryWrite({
        key: newKey,
        value: nextValue,
        tokenCount,
        validKeys: memoryPolicy.validKeys,
        tokenLimit: memoryPolicy.tokenLimit,
        keyLimits: memoryPolicy.keyLimits,
        baselineTotalTokens: currentTotalTokens - (existingMemory.tokenCount || 0),
        previousTokenCount: 0,
      });
      if (!createEvaluation.ok) {
        return res.status(400).json({
          error: createEvaluation.message,
          details: createEvaluation.details,
        });
      }

      const createResult = await createMemory({
        userId: req.user.id,
        key: newKey,
        value: nextValue,
        tokenCount,
      });

      if (!createResult.ok) {
        return res.status(500).json({ error: 'Failed to create new memory.' });
      }

      const deleteResult = await deleteMemory({ userId: req.user.id, key: urlKey });
      if (!deleteResult.ok) {
        return res.status(500).json({ error: 'Failed to delete old memory.' });
      }
    } else {
      const updateEvaluation = evaluateMemoryWrite({
        key: newKey,
        value: nextValue,
        tokenCount,
        validKeys: memoryPolicy.validKeys,
        tokenLimit: memoryPolicy.tokenLimit,
        keyLimits: memoryPolicy.keyLimits,
        baselineTotalTokens: currentTotalTokens,
        previousTokenCount: existingMemory.tokenCount || 0,
      });
      if (!updateEvaluation.ok) {
        return res.status(400).json({
          error: updateEvaluation.message,
          details: updateEvaluation.details,
        });
      }

      const result = await setMemory({
        userId: req.user.id,
        key: newKey,
        value: nextValue,
        tokenCount,
      });

      if (!result.ok) {
        return res.status(500).json({ error: 'Failed to update memory.' });
      }
    }

    await runRouteMemoryMaintenance({
      userId: req.user.id,
      policy: memoryPolicy,
    });

    const updatedMemories = await getAllUserMemories(req.user.id);
    const updatedMemory = updatedMemories.find((m) => m.key === newKey);

    res.json({ updated: true, memory: updatedMemory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /memories/:key
 * Deletes a memory entry for the authenticated user.
 * Returns 200 and { deleted: true } when successful.
 */
router.delete('/:key', checkMemoryDelete, async (req, res) => {
  const { key } = req.params;

  try {
    const result = await deleteMemory({ userId: req.user.id, key });

    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
