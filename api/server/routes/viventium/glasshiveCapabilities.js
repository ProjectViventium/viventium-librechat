/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker MCP endpoint
 * Purpose:
 * - Expose a single host-owned MCP surface that GlassHive workers can use to reach reviewed
 *   LibreChat-managed MCP capabilities without receiving provider credentials.
 *
 * Endpoint:
 * - POST /api/viventium/glasshive/capabilities/mcp
 * === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
/* === VIVENTIUM START ===
 * Feature: Tenant-bound and direct user-scoped GlassHive capability authorization.
 */
const { findUser, getUserById } = require('~/models');
const {
  assertBrokerGrantActive,
  rememberInvocation,
  rememberBrokerRequest,
  resolveBrokerTenantId,
  verifyBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
const {
  buildCapabilityCatalog,
  handleToolCall,
  toolDefinitionsForMcp,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerService');
const {
  buildDirectGlassHiveCapabilityBundle,
  directCapabilityReadiness,
  revokeDirectGlassHiveCapabilityGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBootstrapService');
const {
  verifyDirectIssuerAssertion,
} = require('~/server/services/viventium/GlassHiveCapabilityDirectIssuerAuth');
/* === VIVENTIUM END === */

const router = express.Router();

function bearerToken(req) {
  const header = String(req.get('authorization') || req.get('Authorization') || '').trim();
  return header.replace(/^Bearer\s+/i, '').trim();
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

async function handleRpc(req, res) {
  const body = req.body || {};
  const id = body.id ?? null;
  let grant;
  try {
    /* === VIVENTIUM START === Tenant-bound grants and durable revocation. === */
    grant = verifyBrokerGrant(bearerToken(req), {
      allowRenewal: true,
      expectedTenantId: resolveBrokerTenantId(),
      // Existing direct-conversation grants live for minutes. Accept those v1 grants during the
      // rolling upgrade only; all newly minted grants are tenant-bound v2 grants.
      allowLegacyTenantless: true,
    });
    await assertBrokerGrantActive(grant);
    /* === VIVENTIUM END === */
    if (grant.renewed) {
      res.set('x-glasshive-capability-grant-renewed', 'true');
    }
    const rateLimit = await rememberBrokerRequest({ grant });
    if (!rateLimit.accepted) {
      res.set('Retry-After', String(Math.ceil(Number(rateLimit.retryAfterMs || 1000) / 1000)));
      return res
        .status(429)
        .json(rpcError(id, -32029, 'GlassHive capability broker rate limit exceeded'));
    }
    if (rateLimit.remaining !== undefined) {
      res.set('x-glasshive-capability-rate-limit-remaining', String(rateLimit.remaining));
    }
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Rejected broker request', {
      message: error?.message,
    });
    return res
      .status(401)
      .json(rpcError(id, -32001, 'Unauthorized GlassHive capability broker request'));
  }

  try {
    if (body.method === 'initialize') {
      return res.json(
        rpcResult(id, {
          protocolVersion: body.params?.protocolVersion || '2025-06-18',
          serverInfo: {
            name: 'glasshive-user-capabilities',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        }),
      );
    }
    if (body.method === 'notifications/initialized' || body.method === 'initialized') {
      return res.status(202).end();
    }
    if (body.method === 'ping') {
      return res.json(rpcResult(id, {}));
    }
    if (body.method === 'tools/list') {
      /* === VIVENTIUM START ===
       * Feature: Durable GlassHive broker tool execution.
       * Purpose: The host request signal is already aborted by the surrounding HTTP lifecycle
       *   before an MCP tool may execute. Passing it downstream made every healthy provider call
       *   fail locally. GlassHive owns explicit run cancellation; the broker owns its bounded
       *   provider timeout, so neither operation is coupled to this completed request signal.
       */
      const catalog = await buildCapabilityCatalog({ grant });
      return res.json(rpcResult(id, { tools: toolDefinitionsForMcp(catalog) }));
    }
    if (body.method === 'tools/call') {
      const result = await handleToolCall({
        grant,
        toolName: body.params?.name,
        args: body.params?.arguments || {},
      });
      /* === VIVENTIUM END === */
      // MCP requires structuredContent to be a JSON object. Some underlying tools
      // (e.g. MS365 list_mail_messages) return arrays; emitting an array here makes
      // strict MCP clients (claude-code workers) reject the result with
      // "expected record, received array". No broker tool advertises an outputSchema,
      // so structuredContent is optional — emit it only for plain objects; the text
      // content always carries the full result (lenient clients like codex use it).
      const isRecord = result !== null && typeof result === 'object' && !Array.isArray(result);
      const payload = {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };
      if (isRecord) {
        payload.structuredContent = result;
      }
      return res.json(rpcResult(id, payload));
    }
    if (id === null || id === undefined) {
      return res.status(202).end();
    }
    return res.status(400).json(rpcError(id, -32601, 'Method not found'));
  } catch (error) {
    logger.error('[VIVENTIUM][glasshive-capability-broker] Broker RPC failed', {
      message: error?.message,
    });
    return res.status(500).json(rpcError(id, -32000, 'GlassHive capability broker request failed'));
  }
}

router.post('/mcp', handleRpc);

/* === VIVENTIUM START ===
 * Feature: Replay-safe direct capability readiness, grant, and revoke issuer surface.
 */
async function directIssuerContext(req, action) {
  const claims = verifyDirectIssuerAssertion(bearerToken(req), {
    action,
    expectedTenantId: resolveBrokerTenantId(),
  });
  const replay = await rememberInvocation({
    grantId: 'direct-issuer',
    invocationId: `${action}:${claims.nonce}`,
    ttlMs: 90 * 1000,
  });
  if (!replay.accepted) {
    const error = new Error('Direct issuer assertion replay rejected');
    error.code = replay.reason || 'issuer_assertion_replay';
    error.status = 409;
    throw error;
  }
  const projection = '_id role expiresAt viventiumApprovalStatus';
  const user =
    claims.binding_proof === 'shared_oidc_subject'
      ? await findUser({ viventiumGlassHivePrincipalId: claims.user_id }, projection)
      : await getUserById(claims.user_id, projection);
  if (!user && claims.binding_proof === 'shared_oidc_subject') {
    const error = new Error('Shared OIDC principal has not linked a LibreChat account');
    error.code = 'owner_binding_required';
    error.status = 409;
    throw error;
  }
  const expiresAt = user?.expiresAt ? new Date(user.expiresAt).getTime() : null;
  if (
    !user ||
    (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) ||
    ['pending', 'denied'].includes(String(user.viventiumApprovalStatus || '').toLowerCase())
  ) {
    const error = new Error('Verified LibreChat user is unavailable');
    error.code = 'user_unavailable';
    error.status = 401;
    throw error;
  }
  user.id = String(user._id);
  return { claims, user };
}

function directError(res, error) {
  const status = Number(error?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 401;
  const code = String(error?.code || (safeStatus === 401 ? 'unauthorized' : 'broker_unavailable'))
    .replace(/[^a-z0-9_.:-]/gi, '')
    .slice(0, 120);
  logger.warn('[VIVENTIUM][glasshive-capability-broker] Direct issuer request failed', {
    code,
    status: safeStatus,
  });
  return res.status(safeStatus).json({
    error: {
      code,
      message: 'GlassHive connected capability authorization failed',
    },
    status:
      code === 'owner_binding_required'
        ? 'unmapped'
        : code === 'issuer_assertion_replay'
          ? 'broker_unavailable'
          : code === 'connected_account_action_required'
            ? 'action_required'
            : 'broker_unavailable',
  });
}

router.post('/direct/status', async (req, res) => {
  try {
    const { claims, user } = await directIssuerContext(req, 'status');
    const readiness = await directCapabilityReadiness({
      user,
      executionMode: claims.execution_mode || 'docker',
    });
    return res.json({
      status: readiness.status,
      reason: readiness.reason || '',
      connections: readiness.connections || [],
    });
  } catch (error) {
    return directError(res, error);
  }
});

router.post('/direct/grant', async (req, res) => {
  try {
    const { claims, user } = await directIssuerContext(req, 'grant');
    const result = await buildDirectGlassHiveCapabilityBundle({
      user,
      workerId: claims.worker_id,
      runId: claims.run_id,
      executionMode: claims.execution_mode,
    });
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    return directError(res, error);
  }
});

router.post('/direct/revoke', async (req, res) => {
  try {
    const { claims, user } = await directIssuerContext(req, 'revoke');
    const result = await revokeDirectGlassHiveCapabilityGrant({
      user,
      workerId: claims.worker_id,
      runId: claims.run_id,
      executionMode: claims.execution_mode,
      grantId: req.body?.grant_id,
      renewableUntil: req.body?.renewable_until,
    });
    return res.json({ revoked: result.revoked === true, grant_id: result.grantId });
  } catch (error) {
    return directError(res, error);
  }
});
/* === VIVENTIUM END === */

router.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'glasshive-capability-broker',
  }),
);

module.exports = router;
