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
const {
  hydrateBrokerGrantResources,
  rememberBrokerRequest,
  verifyBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
const {
  buildCapabilityCatalog,
  handleToolCall,
  toolDefinitionsForMcp,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerService');
const { requestLifetimeSignal } = require('./GlassHiveRequestLifetimeSignal');
const { getAppConfig } = require('~/server/services/Config');
const {
  assertActiveCapabilityAuthorizationGrant,
  CapabilityAuthorizationError,
  admitCapabilityAuthorization,
  revokeCapabilityAuthorizationGrant,
  verifyAndConsumeAdmission,
} = require('~/server/services/viventium/GlassHiveCapabilityAuthorizationService');
const {
  canonicalConversationOrchestrationArguments,
  isConversationOrchestrationMutationTool,
  isConversationOrchestrationTool,
  mainOrchestrationInvocationIdentity,
} = require('~/server/services/viventium/GlassHiveConversationOrchestration');

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

function brokerInvocationIdentity({ grant, toolName, args } = {}) {
  if (!isConversationOrchestrationTool(toolName)) return '';
  if (isConversationOrchestrationMutationTool(toolName)) return '';
  return mainOrchestrationInvocationIdentity({
    userId: grant?.user_id,
    requestBody: {
      conversationId: grant?.conversation_id || grant?.turn_id,
      messageId: grant?.message_id,
    },
    toolName,
    args: canonicalConversationOrchestrationArguments(toolName, args),
  });
}

async function handleRpc(req, res) {
  const body = req.body || {};
  const id = body.id ?? null;
  // Broker grants and native operation tokens are short-lived capabilities, never cacheable data.
  res.set('Cache-Control', 'no-store, private');
  const signal = requestLifetimeSignal(req, res);
  let grant;
  try {
    // The broker is deliberately a short-lived bearer boundary. Require the signed
    // conversation/message tuple on every production grant so a broad user-only grant cannot
    // silently become a reusable cross-turn capability. Tool authorization continues to use the
    // signed user/turn values; possession of the bearer remains the caller-authentication model.
    const verifiedGrant = verifyBrokerGrant(bearerToken(req), { requireTurnScope: true });
    if (String(verifiedGrant?.authorization_ref || '').trim()) {
      await assertActiveCapabilityAuthorizationGrant(verifiedGrant);
    }
    grant = await hydrateBrokerGrantResources(verifiedGrant);
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
    const appConfig =
      req.config ||
      (body.method === 'tools/list' || body.method === 'tools/call'
        ? await getAppConfig({ role: String(grant?.user_role || '').trim() || undefined })
        : undefined);
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
      const catalog = await buildCapabilityCatalog({ grant, signal, appConfig });
      return res.json(rpcResult(id, { tools: toolDefinitionsForMcp(catalog) }));
    }
    if (body.method === 'tools/call') {
      /* === VIVENTIUM START ===
       * Feature: Turn-and-objective identity for idempotent Main orchestration.
       * Purpose: Bind launch/action identity to the signed Core turn plus canonical arguments,
       * never a model-authored owner/operation id or reconnect-unstable MCP request id.
       * === VIVENTIUM END === */
      const invocationId = brokerInvocationIdentity({
        grant,
        toolName: body.params?.name,
        args: body.params?.arguments || {},
      });
      const toolName = body.params?.name;
      const result = await handleToolCall({
        grant,
        toolName,
        args: body.params?.arguments || {},
        invocationId,
        signal,
        appConfig,
      });
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
 * Feature: Mission-admission broker grant minting.
 * Purpose: GlassHive receives a worker bearer only after an exact queued mission owns capacity.
 * === VIVENTIUM END === */
router.post('/admit', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const allowedKeys = new Set([
    'authorizationRef',
    'originRef',
    'workRef',
    'workerId',
    'runId',
    'containerGenerationId',
  ]);
  const values = Object.values(body);
  if (
    Object.keys(body).length !== allowedKeys.size ||
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    values.some((value) => typeof value !== 'string' || value.length < 8 || value.length > 192)
  ) {
    return res.status(400).json({
      error: {
        code: 'capability_admission_request_invalid',
        message: 'The GlassHive capability admission request is invalid.',
        needsInput: false,
      },
    });
  }
  try {
    await verifyAndConsumeAdmission({
      body,
      header: req.get('X-Viventium-GlassHive-Admission'),
    });
    const admitted = await admitCapabilityAuthorization(body);
    return res.status(200).json(admitted);
  } catch (error) {
    const known = error instanceof CapabilityAuthorizationError;
    const status = known ? error.status : 500;
    logger[status >= 500 ? 'error' : 'warn'](
      '[VIVENTIUM][glasshive-capability-authorization] Admission rejected',
      { code: known ? error.code : 'capability_admission_failed', status },
    );
    return res.status(status).json({
      error: {
        code: known ? error.code : 'capability_admission_failed',
        message: known
          ? error.message
          : 'GlassHive mission capability admission failed.',
        needsInput: known ? error.needsInput : false,
      },
    });
  }
});
router.post('/revoke', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const allowedKeys = new Set([
    'authorizationRef',
    'originRef',
    'workRef',
    'workerId',
    'runId',
    'containerGenerationId',
    'grantId',
  ]);
  const values = Object.values(body);
  if (
    Object.keys(body).length !== allowedKeys.size ||
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    values.some((value) => typeof value !== 'string' || value.length < 8 || value.length > 192)
  ) {
    return res.status(400).json({
      error: {
        code: 'capability_revocation_request_invalid',
        message: 'The GlassHive capability revocation request is invalid.',
        needsInput: false,
      },
    });
  }
  try {
    await verifyAndConsumeAdmission({
      body,
      header: req.get('X-Viventium-GlassHive-Admission'),
    });
    await revokeCapabilityAuthorizationGrant(body);
    return res.status(204).end();
  } catch (error) {
    const known = error instanceof CapabilityAuthorizationError;
    const status = known ? error.status : 500;
    logger[status >= 500 ? 'error' : 'warn'](
      '[VIVENTIUM][glasshive-capability-authorization] Revocation rejected',
      { code: known ? error.code : 'capability_revocation_failed', status },
    );
    return res.status(status).json({
      error: {
        code: known ? error.code : 'capability_revocation_failed',
        message: known
          ? error.message
          : 'GlassHive mission capability revocation failed.',
        needsInput: false,
      },
    });
  }
});
router.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'glasshive-capability-broker',
  }),
);

module.exports = router;
