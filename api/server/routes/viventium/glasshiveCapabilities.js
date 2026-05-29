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
  rememberBrokerRequest,
  verifyBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
const {
  buildCapabilityCatalog,
  handleToolCall,
  toolDefinitionsForMcp,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerService');

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
    grant = verifyBrokerGrant(bearerToken(req), { allowRenewal: true });
    if (grant.renewed) {
      res.set('x-glasshive-capability-grant-renewed', 'true');
    }
    const rateLimit = await rememberBrokerRequest({ grant });
    if (!rateLimit.accepted) {
      res.set('Retry-After', String(Math.ceil(Number(rateLimit.retryAfterMs || 1000) / 1000)));
      return res.status(429).json(rpcError(id, -32029, 'GlassHive capability broker rate limit exceeded'));
    }
    if (rateLimit.remaining !== undefined) {
      res.set('x-glasshive-capability-rate-limit-remaining', String(rateLimit.remaining));
    }
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Rejected broker request', {
      message: error?.message,
    });
    return res.status(401).json(rpcError(id, -32001, 'Unauthorized GlassHive capability broker request'));
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
      const catalog = await buildCapabilityCatalog({ grant, signal: req.signal });
      return res.json(rpcResult(id, { tools: toolDefinitionsForMcp(catalog) }));
    }
    if (body.method === 'tools/call') {
      const result = await handleToolCall({
        grant,
        toolName: body.params?.name,
        args: body.params?.arguments || {},
        signal: req.signal,
      });
      return res.json(
        rpcResult(id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
          structuredContent: result,
        }),
      );
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
router.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'glasshive-capability-broker',
  }),
);

module.exports = router;
