/* === VIVENTIUM START ===
 * Feature: Voice-agent authorization parity
 * Purpose: Calls use the same global AGENTS USE and resource VIEW gates as standard Agents chat.
 * Session ownership never grants assistant authority, and every Call/Wing turn rechecks access so
 * revocation takes effect immediately. Listen-Only transcript ingress does not execute an agent.
 * === VIVENTIUM END === */
const { checkAccess } = require('@librechat/api');
const {
  PermissionTypes,
  Permissions,
  PermissionBits,
  ResourceType,
  SystemRoles,
} = require('librechat-data-provider');
const { getRoleByName } = require('~/models/Role');
const { getAgent } = require('~/models/Agent');
const { checkPermission } = require('~/server/services/PermissionService');

function unavailableAgentError() {
  const error = new Error('Voice assistant is unavailable');
  error.status = 404;
  error.code = 'no_route';
  error.retryable = false;
  return error;
}

async function assertVoiceAgentAccess({ req, agentId }) {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  if (!normalizedAgentId || !req?.user?.id || !req.user.role) {
    throw unavailableAgentError();
  }
  const hasGlobalUse = await checkAccess({
    req,
    user: req.user,
    permissionType: PermissionTypes.AGENTS,
    permissions: [Permissions.USE],
    getRoleByName,
  });
  if (!hasGlobalUse) {
    throw unavailableAgentError();
  }
  const agent = await getAgent({ id: normalizedAgentId });
  if (!agent?._id) {
    throw unavailableAgentError();
  }
  if (req.user.role === SystemRoles.ADMIN) {
    return agent;
  }
  const canView = await checkPermission({
    userId: req.user.id,
    role: req.user.role,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission: PermissionBits.VIEW,
  });
  if (!canView) {
    throw unavailableAgentError();
  }
  return agent;
}

async function requireVoiceAgentAccess(req, res, next) {
  try {
    const session = req.viventiumCallSession;
    if (session?.mode === 'listen_only' || session?.listenOnlyModeEnabled === true) {
      return next();
    }
    await assertVoiceAgentAccess({
      req,
      // The call session is the only authority for agent selection. Voice ingress is
      // server-to-server, but its body is still transport data and must never be able
      // to substitute an accessible decoy for a revoked session agent.
      agentId: session?.agentId,
    });
    return next();
  } catch (error) {
    return res.status(error?.status || 404).json({
      code: 'no_route',
      message: 'Voice assistant is unavailable.',
      retryable: false,
    });
  }
}

module.exports = {
  assertVoiceAgentAccess,
  requireVoiceAgentAccess,
};
