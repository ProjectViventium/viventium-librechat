const express = require('express');
const { generateCheckAccess, getCustomEndpointConfig } = require('@librechat/api');
const {
  PermissionTypes,
  Permissions,
  PermissionBits,
  extractEnvVariable,
} = require('librechat-data-provider');
const { requireJwtAuth, configMiddleware, canAccessAgentResource } = require('~/server/middleware');
const v1 = require('~/server/controllers/agents/v1');
const { getRoleByName } = require('~/models/Role');
const actions = require('./actions');
const tools = require('./tools');

const router = express.Router();
const avatar = express.Router();

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkAgentCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

const checkGlobalAgentShare = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  bodyProps: {
    [Permissions.SHARE]: ['projectIds', 'removeProjectIds'],
  },
  getRoleByName,
});

router.use(requireJwtAuth);

/**
 * Agent actions route.
 * @route GET|POST /agents/actions
 */
router.use('/actions', configMiddleware, actions);

/**
 * Get a list of available tools for agents.
 * @route GET /agents/tools
 */
router.use('/tools', configMiddleware, tools);

/**
 * Get all agent categories with counts
 * @route GET /agents/categories
 */
router.get('/categories', v1.getAgentCategories);
/* === VIVENTIUM START ===
 * Feature: Authenticated harness provider readiness.
 * Purpose: Let Agent Builder show actual GlassHive binary/auth status without exposing the
 * provider credential or allowing arbitrary user-selected proxy destinations.
 * === VIVENTIUM END === */
router.get('/provider-readiness/:provider', configMiddleware, checkAgentAccess, async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const capability = req.config?.endpoints?.agents?.providerCapabilities?.[provider];
  if (!capability?.activity_stream) {
    return res.status(404).json({ status: 'unavailable', detail: 'Provider readiness is not declared.' });
  }
  try {
    const endpoint = getCustomEndpointConfig({ endpoint: provider, appConfig: req.config });
    const apiKey = extractEnvVariable(endpoint?.apiKey || '');
    const baseURL = extractEnvVariable(endpoint?.baseURL || '').replace(/\/$/, '');
    if (!apiKey || !baseURL || apiKey.includes('${') || baseURL.includes('${')) {
      return res.json({ status: 'unavailable', detail: 'Provider configuration is incomplete.', models: [] });
    }
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Viventium-User-Id': String(req.user?.id || ''),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return res.json({ status: 'unavailable', detail: `Provider returned HTTP ${response.status}.`, models: [] });
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data.map((model) => ({
          id: String(model?.id || ''),
          display_name: String(model?.display_name || model?.id || ''),
          readiness: model?.readiness || { status: 'unknown' },
        }))
      : [];
    const selected = models.find((model) => model.readiness?.status === 'ready');
    return res.json({
      status: selected ? 'ready' : models[0]?.readiness?.status || 'unavailable',
      detail: selected?.readiness?.detail || models[0]?.readiness?.detail || 'No harness models returned.',
      models,
    });
  } catch (error) {
    return res.json({
      status: 'unavailable',
      detail: error?.name === 'TimeoutError' ? 'Provider readiness check timed out.' : 'Provider is not reachable.',
      models: [],
    });
  }
});
/**
 * Creates an agent.
 * @route POST /agents
 * @param {AgentCreateParams} req.body - The agent creation parameters.
 * @returns {Agent} 201 - Success response - application/json
 */
router.post('/', configMiddleware, checkAgentCreate, v1.createAgent);

/**
 * Retrieves basic agent information (VIEW permission required).
 * Returns safe, non-sensitive agent data for viewing purposes.
 * @route GET /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - Basic agent info - application/json
 */
router.get(
  '/:id',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'id',
  }),
  v1.getAgent,
);

/**
 * Retrieves full agent details including sensitive configuration (EDIT permission required).
 * Returns complete agent data for editing/configuration purposes.
 * @route GET /agents/:id/expanded
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - Full agent details - application/json
 */
router.get(
  '/:id/expanded',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  (req, res) => v1.getAgent(req, res, true), // Expanded version
);
/**
 * Updates an agent.
 * @route PATCH /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @param {AgentUpdateParams} req.body - The agent update parameters.
 * @returns {Agent} 200 - Success response - application/json
 */
router.patch(
  '/:id',
  configMiddleware,
  checkGlobalAgentShare,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  v1.updateAgent,
);

/**
 * Duplicates an agent.
 * @route POST /agents/:id/duplicate
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 201 - Success response - application/json
 */
router.post(
  '/:id/duplicate',
  configMiddleware,
  checkAgentCreate,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  v1.duplicateAgent,
);

/**
 * Deletes an agent.
 * @route DELETE /agents/:id
 * @param {string} req.params.id - Agent identifier.
 * @returns {Agent} 200 - success response - application/json
 */
router.delete(
  '/:id',
  checkAgentCreate,
  canAccessAgentResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'id',
  }),
  v1.deleteAgent,
);

/**
 * Reverts an agent to a previous version.
 * @route POST /agents/:id/revert
 * @param {string} req.params.id - Agent identifier.
 * @param {number} req.body.version_index - Index of the version to revert to.
 * @returns {Agent} 200 - success response - application/json
 */
router.post(
  '/:id/revert',
  configMiddleware,
  checkGlobalAgentShare,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'id',
  }),
  v1.revertAgentVersion,
);

/**
 * Returns a list of agents.
 * @route GET /agents
 * @param {AgentListParams} req.query - The agent list parameters for pagination and sorting.
 * @returns {AgentListResponse} 200 - success response - application/json
 */
router.get('/', checkAgentAccess, v1.getListAgents);

/**
 * Uploads and updates an avatar for a specific agent.
 * @route POST /agents/:agent_id/avatar
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {Express.Multer.File} req.file - The avatar image file.
 * @param {string} [req.body.metadata] - Optional metadata for the agent's avatar.
 * @returns {Object} 200 - success response - application/json
 */
avatar.post(
  '/:agent_id/avatar/',
  checkAgentAccess,
  canAccessAgentResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'agent_id',
  }),
  v1.uploadAgentAvatar,
);

module.exports = { v1: router, avatar };
