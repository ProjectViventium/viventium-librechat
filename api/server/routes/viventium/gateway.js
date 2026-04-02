/* === VIVENTIUM START ===
 * Feature: Generic Viventium Gateway Endpoints
 *
 * Purpose:
 * - Provide one shared multi-channel ingress contract for OpenClaw and future channel bridges.
 * - Keep LibreChat Agents as the single reasoning pipeline.
 * - Preserve Telegram parity patterns (dedupe, streaming, attachments, follow-up polling).
 *
 * Endpoints:
 * - POST /api/viventium/gateway/chat
 * - GET  /api/viventium/gateway/stream/:streamId
 * - GET  /api/viventium/gateway/cortex/:messageId
 * - GET  /api/viventium/gateway/files/download/:file_id
 * - GET  /api/viventium/gateway/files/code/download/:session_id/:fileId
 * - GET  /api/viventium/gateway/link/:token
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mime = require('mime');
const { Readable } = require('stream');
const { GenerationJobManager } = require('@librechat/api');
const { EnvVar } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const {
  SystemRoles,
  Constants,
  ContentTypes,
  FileSources,
  EModelEndpoint,
  checkOpenAIStorage,
} = require('librechat-data-provider');
const { configMiddleware, validateConvoAccess, buildEndpointOption } = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { cleanFileName } = require('~/server/utils/files');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { getUserById, getMessages, getConvo } = require('~/models');
const { ViventiumGatewayIngressEvent } = require('~/db/models');
const {
  normalizeGatewayId,
  normalizeGatewayChannelId,
  normalizeGatewayAccountId,
  normalizeGatewayIdentity,
  createGatewayLinkToken,
  buildGatewayLinkUrl,
  resolveGatewayMapping,
  touchGatewayMapping,
  upsertGatewayMapping,
  resolveUserIdFromCookies,
  consumeGatewayLinkToken,
} = require('~/server/services/GatewayLinkService');
const {
  ensureGatewaySpec,
  normalizeGatewayParentMessageId,
} = require('~/server/services/viventium/gatewayConvoDefaults');
const {
  resolveReusableConversationState,
} = require('~/server/services/viventium/conversationThreading');
const {
  GATEWAY_SECRET_HEADER,
  parseBoolEnv,
  parseIntEnv,
  getGatewaySecret,
  verifyGatewayRequestSignature,
} = require('~/server/services/viventium/gateway/security');
const {
  extractTextDeltas,
  extractFinalResponseText,
  extractResponseMessageId,
  extractAttachments,
  extractFinalError,
} = require('~/server/services/viventium/gateway/streamExtractors');
const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

const router = express.Router();

const GATEWAY_FILE_UPLOAD_ENABLED = parseBoolEnv('VIVENTIUM_GATEWAY_FILE_UPLOAD_ENABLED', true);
const GATEWAY_MAX_FILE_BYTES = parseIntEnv('VIVENTIUM_GATEWAY_MAX_FILE_SIZE', 10485760);
const GATEWAY_INGRESS_DEDUPE_ENABLED = parseBoolEnv(
  'VIVENTIUM_GATEWAY_INGRESS_DEDUPE_ENABLED',
  true,
);
const GATEWAY_INGRESS_DEDUPE_TTL_S = Math.max(
  parseIntEnv('VIVENTIUM_GATEWAY_INGRESS_DEDUPE_TTL_S', 86400),
  60,
);
const GATEWAY_REQUIRE_SIGNATURE = parseBoolEnv('VIVENTIUM_GATEWAY_REQUIRE_SIGNATURE', true);

function extractGatewayIdentity(req) {
  const body = req.body ?? {};
  const query = req.query ?? {};

  const channel = normalizeGatewayChannelId(body.channel || query.channel || '');
  const accountId = normalizeGatewayAccountId(body.accountId || query.accountId || '');
  const externalUserId = normalizeGatewayId(body.externalUserId || query.externalUserId || '');
  const externalChatId = normalizeGatewayId(body.externalChatId || query.externalChatId || '');
  const externalUsername =
    typeof body.externalUsername === 'string'
      ? body.externalUsername.trim()
      : typeof query.externalUsername === 'string'
        ? query.externalUsername.trim()
        : '';

  return {
    channel,
    accountId,
    externalUserId,
    externalChatId,
    externalUsername,
  };
}

async function resolveGatewayUserId({ channel, accountId, externalUserId }) {
  if (!channel || !externalUserId) {
    return { userId: '', source: 'missing' };
  }
  const mapping = await resolveGatewayMapping({ channel, accountId, externalUserId });
  if (!mapping?.libreChatUserId) {
    return { userId: '', source: 'unlinked' };
  }
  return { userId: mapping.libreChatUserId.toString(), source: 'mapping' };
}

async function issueGatewayLink(req, identity) {
  const { token } = await createGatewayLinkToken({
    channel: identity.channel,
    accountId: identity.accountId,
    externalUserId: identity.externalUserId,
    externalUsername: identity.externalUsername,
    metadata: {
      externalChatId: identity.externalChatId,
    },
  });
  return buildGatewayLinkUrl(req, token);
}

function normalizeIngressId(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function isMongoDuplicateKeyError(error) {
  return Boolean(error) && Number(error.code) === 11000;
}

function dedupeKeyFromIngress({
  channel,
  accountId,
  externalUserId,
  externalChatId,
  externalMessageId,
  externalUpdateId,
  externalThreadId,
}) {
  const base = `${channel}:${accountId}:${externalChatId || externalUserId}:${externalThreadId || 'main'}`;
  if (externalMessageId) {
    return `m:${base}:${externalMessageId}`;
  }
  if (externalUpdateId) {
    return `u:${base}:${externalUpdateId}`;
  }
  return '';
}

async function reserveGatewayIngress({
  channel,
  accountId,
  externalUserId,
  externalChatId,
  externalMessageId,
  externalUpdateId,
  externalThreadId,
  conversationId,
  traceId,
}) {
  if (!GATEWAY_INGRESS_DEDUPE_ENABLED) {
    return { duplicate: false };
  }

  const dedupeKey = dedupeKeyFromIngress({
    channel,
    accountId,
    externalUserId,
    externalChatId,
    externalMessageId,
    externalUpdateId,
    externalThreadId,
  });

  if (!dedupeKey) {
    return { duplicate: false };
  }

  const expiresAt = new Date(Date.now() + GATEWAY_INGRESS_DEDUPE_TTL_S * 1000);
  try {
    const record = await ViventiumGatewayIngressEvent.create({
      dedupeKey,
      channel,
      accountId,
      externalUserId,
      externalChatId,
      externalMessageId,
      externalUpdateId,
      externalThreadId,
      conversationId,
      traceId,
      expiresAt,
    });
    return { duplicate: false, recordId: record?._id || null, dedupeKey };
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      return { duplicate: true, dedupeKey };
    }
    throw error;
  }
}

async function resolveAgentId({ req, conversationId, requestedAgentId, userId }) {
  if (conversationId && conversationId !== 'new') {
    try {
      const convo = await getConvo(userId, conversationId);
      if (convo?.agent_id) {
        return convo.agent_id;
      }
    } catch (err) {
      logger.warn('[VIVENTIUM][gateway] Failed to load conversation agent_id: %s', err?.message);
    }
  }

  if (typeof requestedAgentId === 'string' && requestedAgentId.length > 0) {
    return requestedAgentId;
  }

  const config = req.config || {};
  return (
    config.interface?.defaultAgent ||
    config.endpoints?.agents?.defaultId ||
    process.env.VIVENTIUM_MAIN_AGENT_ID ||
    ''
  );
}

function extractAttachmentBase64(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const raw =
    payload.data ||
    payload.buffer ||
    payload.base64 ||
    payload.bufferBase64 ||
    payload.content;
  if (typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  const match = trimmed.match(/^data:([A-Za-z-+/]+);base64,(.*)$/);
  return match ? match[2] : trimmed;
}

function estimateBase64Bytes(base64Data) {
  if (!base64Data) {
    return 0;
  }
  const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64Data.length * 3) / 4) - padding);
}

function normalizeGatewayFilename(filename, fallback) {
  const raw = typeof filename === 'string' && filename.trim() ? filename.trim() : fallback;
  const base = path.basename(raw || fallback || 'gateway-file');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeGatewayTempFile(buffer, filename) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'librechat-gateway-'));
  const filePath = path.join(tempDir, filename);
  await fs.promises.writeFile(filePath, buffer);
  return { tempDir, filePath };
}

function normalizeAttachmentMimeType(attachment) {
  return (
    (typeof attachment?.mime_type === 'string' && attachment.mime_type.trim()) ||
    (typeof attachment?.mimeType === 'string' && attachment.mimeType.trim()) ||
    (attachment?.filename ? mime.getType(attachment.filename) : '') ||
    'application/octet-stream'
  );
}

function splitGatewayAttachments(attachments) {
  const images = [];
  const nonImages = [];

  if (!Array.isArray(attachments)) {
    return { images, nonImages };
  }

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue;
    }
    const mimeType = normalizeAttachmentMimeType(attachment);
    if (mimeType.startsWith('image/')) {
      images.push(attachment);
    } else {
      nonImages.push(attachment);
    }
  }

  return { images, nonImages };
}

function formatGatewayImagesForVision(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  return attachments
    .map((attachment) => {
      const base64Data = extractAttachmentBase64(attachment);
      if (!base64Data) {
        return null;
      }
      const mimeType = normalizeAttachmentMimeType(attachment);
      if (!mimeType.startsWith('image/')) {
        return null;
      }
      return {
        type: ContentTypes.IMAGE_URL,
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`,
          detail: 'auto',
        },
      };
    })
    .filter(Boolean);
}

async function uploadGatewayFiles({ req, attachments }) {
  if (!GATEWAY_FILE_UPLOAD_ENABLED) {
    return [];
  }

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  let filterFile;
  let processAgentFileUpload;
  ({ filterFile, processAgentFileUpload } = require('~/server/services/Files/process'));

  const uploaded = [];
  const originalFile = req.file;
  const originalBody = req.body;

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const base64Data = extractAttachmentBase64(attachment);
    if (!base64Data) {
      continue;
    }

    const byteCount = estimateBase64Bytes(base64Data);
    if (byteCount <= 0 || byteCount > GATEWAY_MAX_FILE_BYTES) {
      logger.warn(
        '[VIVENTIUM][gateway/chat] Skipping attachment (size=%d max=%d)',
        byteCount,
        GATEWAY_MAX_FILE_BYTES,
      );
      continue;
    }

    const mimeType = normalizeAttachmentMimeType(attachment);
    const fallbackName = `gateway-file-${Date.now()}-${index + 1}`;
    let safeName = normalizeGatewayFilename(attachment.filename, fallbackName);
    if (!path.extname(safeName)) {
      const extension = mime.getExtension(mimeType);
      if (extension) {
        safeName = `${safeName}.${extension}`;
      }
    }

    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (_err) {
      logger.warn('[VIVENTIUM][gateway/chat] Invalid base64 payload for %s', safeName);
      continue;
    }

    if (!buffer || buffer.length === 0) {
      continue;
    }

    const { tempDir, filePath } = await writeGatewayTempFile(buffer, safeName);
    const fileId = crypto.randomUUID();
    const tempFile = {
      path: filePath,
      originalname: safeName,
      mimetype: mimeType,
      size: buffer.length,
      filename: safeName,
      destination: tempDir,
    };

    const metadata = {
      file_id: fileId,
      temp_file_id: fileId,
      message_file: true,
    };

    try {
      req.file = tempFile;
      const model =
        originalBody && typeof originalBody === 'object' ? originalBody.model : undefined;
      req.body = {
        endpoint: 'agents',
        endpointType: 'agents',
        file_id: fileId,
        model,
      };

      filterFile({ req });

      let result;
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          result = payload;
          return payload;
        },
      };

      await processAgentFileUpload({ req, res, metadata });
      if (result) {
        uploaded.push(result);
      }
    } catch (err) {
      logger.error('[VIVENTIUM][gateway/chat] Attachment upload failed:', err);
    } finally {
      req.file = originalFile;
      req.body = originalBody;
      try {
        await fs.promises.unlink(filePath);
      } catch (_err) {
        // no-op
      }
      try {
        await fs.promises.rmdir(tempDir);
      } catch (_err) {
        // no-op
      }
    }
  }

  return uploaded;
}

function renderLinkResult({ ok, message }) {
  const status = ok ? 'Linked' : 'Link failed';
  const body = message || (ok ? 'Your channel account is now linked.' : 'Unable to link.');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${status}</title>
  </head>
  <body>
    <h2>${status}</h2>
    <p>${body}</p>
    <p>You can return to your chat application.</p>
  </body>
</html>`;
}

function writeSseEvent(res, eventName, payload) {
  if (res.writableEnded) {
    return;
  }
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

async function gatewayAuth(req, res, next) {
  try {
    const providedSecret =
      req.get('X-VIVENTIUM-GATEWAY-SECRET') || req.get(GATEWAY_SECRET_HEADER) || '';
    const expectedSecret = getGatewaySecret();

    if (!expectedSecret) {
      const err = new Error('VIVENTIUM_GATEWAY_SECRET is not set');
      err.status = 500;
      throw err;
    }

    if (!providedSecret || providedSecret !== expectedSecret) {
      const err = new Error('Unauthorized gateway request');
      err.status = 401;
      throw err;
    }

    const signatureResult = verifyGatewayRequestSignature(req, {
      secret: expectedSecret,
      requireSignature: GATEWAY_REQUIRE_SIGNATURE,
    });
    if (!signatureResult.ok) {
      const err = new Error(signatureResult.error || 'Invalid gateway signature');
      err.status = 401;
      throw err;
    }

    const identity = extractGatewayIdentity(req);
    if (!identity.channel) {
      const err = new Error('channel is required');
      err.status = 400;
      throw err;
    }
    if (!identity.externalUserId) {
      const err = new Error('externalUserId is required');
      err.status = 400;
      throw err;
    }

    const { userId, source } = await resolveGatewayUserId(identity);
    if (!userId) {
      if (req.method === 'POST' && req.path === '/chat') {
        const linkUrl = await issueGatewayLink(req, identity);
        if (!linkUrl) {
          const err = new Error('Link URL base is not configured');
          err.status = 500;
          throw err;
        }
        return res.status(401).json({
          error: 'Channel account not linked',
          linkRequired: true,
          linkUrl,
        });
      }

      const err = new Error(
        source === 'missing' ? 'externalUserId is required' : 'Channel account not linked',
      );
      err.status = 401;
      throw err;
    }

    const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      const err = new Error('User not found for gateway mapping');
      err.status = 401;
      throw err;
    }

    user.id = user._id.toString();
    if (!user.role) {
      user.role = SystemRoles.USER;
    }

    await touchGatewayMapping({
      ...identity,
      metadata: {
        externalChatId: identity.externalChatId,
      },
    });

    req.user = user;
    req.gatewayIdentity = identity;
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][gatewayAuth] Auth failed:', err);
    return res.status(status).json({ error: err?.message || 'Unauthorized' });
  }
}

router.get('/link/:token', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      return res.status(400).send(renderLinkResult({ ok: false, message: 'Invalid link.' }));
    }

    const userId = resolveUserIdFromCookies(req);
    if (!userId) {
      return res.status(401).send(
        renderLinkResult({
          ok: false,
          message: 'Please log in to LibreChat, then reopen this link.',
        }),
      );
    }

    const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      return res.status(401).send(renderLinkResult({ ok: false, message: 'User not found.' }));
    }

    const linkToken = await consumeGatewayLinkToken(token);
    if (!linkToken) {
      return res.status(400).send(
        renderLinkResult({
          ok: false,
          message: 'This link has expired or was already used.',
        }),
      );
    }

    const normalizedIdentity = normalizeGatewayIdentity({
      channel: linkToken.channel,
      accountId: linkToken.accountId,
      externalUserId: linkToken.externalUserId,
      externalUsername: linkToken.externalUsername,
    });

    await upsertGatewayMapping({
      channel: normalizedIdentity.channel,
      accountId: normalizedIdentity.accountId,
      externalUserId: normalizedIdentity.externalUserId,
      externalUsername: normalizedIdentity.externalUsername,
      libreChatUserId: user._id,
      metadata: linkToken.metadata,
    });

    return res.status(200).send(renderLinkResult({ ok: true }));
  } catch (err) {
    logger.error('[VIVENTIUM][gateway/link] Failed to link external account:', err);
    return res
      .status(500)
      .send(renderLinkResult({ ok: false, message: 'Unexpected error linking account.' }));
  }
});

router.post(
  '/chat',
  gatewayAuth,
  configMiddleware,
  async (req, _res, next) => {
    const incoming = req.body ?? {};
    const identity = req.gatewayIdentity || extractGatewayIdentity(req);

    const text = typeof incoming.text === 'string' ? incoming.text : '';
    const requestedConversationId =
      typeof incoming.conversationId === 'string' ? incoming.conversationId : 'new';
    const requestedAgentId =
      typeof incoming.agentId === 'string'
        ? incoming.agentId
        : typeof incoming.agent_id === 'string'
          ? incoming.agent_id
          : '';

    const externalMessageId = normalizeIngressId(incoming.externalMessageId);
    const externalUpdateId = normalizeIngressId(incoming.externalUpdateId);
    const externalThreadId = normalizeIngressId(incoming.externalThreadId);
    const traceId = typeof incoming.traceId === 'string' ? incoming.traceId : '';

    const ingressReservation = await reserveGatewayIngress({
      channel: identity.channel,
      accountId: identity.accountId,
      externalUserId: identity.externalUserId,
      externalChatId: identity.externalChatId,
      externalMessageId,
      externalUpdateId,
      externalThreadId,
      conversationId: requestedConversationId,
      traceId,
    });

    if (ingressReservation.duplicate) {
      logger.info(
        '[VIVENTIUM][gateway/chat] Duplicate ingress suppressed key=%s channel=%s account=%s externalUserId=%s',
        ingressReservation.dedupeKey,
        identity.channel,
        identity.accountId,
        identity.externalUserId,
      );
      return _res.status(200).json({
        duplicate: true,
        streamId: '',
        conversationId: requestedConversationId,
      });
    }

    if (ingressReservation.recordId) {
      _res.on('finish', () => {
        if (_res.statusCode < 400) {
          return;
        }
        ViventiumGatewayIngressEvent.deleteOne({ _id: ingressReservation.recordId }).catch((err) => {
          logger.warn(
            '[VIVENTIUM][gateway/chat] Failed to release ingress reservation %s: %s',
            ingressReservation.recordId,
            err?.message,
          );
        });
      });
    }

    const streamId = `gateway-${identity.channel}-${crypto.randomUUID()}`;

    let parentMessageId =
      typeof incoming.parentMessageId === 'string' ? incoming.parentMessageId : null;
    let conversationId = requestedConversationId;
    if (!parentMessageId) {
      const conversationState = await resolveReusableConversationState({
        conversationId: requestedConversationId,
        userId: req.user?.id,
        surface: 'gateway',
      });
      conversationId = conversationState.conversationId;
      parentMessageId = conversationState.parentMessageId;
      if (requestedConversationId !== conversationId) {
        logger.info(
          '[VIVENTIUM][gateway/chat] Conversation reset: requested=%s resolved=%s reason=%s channel=%s account=%s externalUserId=%s',
          requestedConversationId,
          conversationId,
          conversationState.reason,
          identity.channel,
          identity.accountId,
          identity.externalUserId,
        );
      }
    }

    const agentId = await resolveAgentId({
      req,
      conversationId,
      requestedAgentId,
      userId: req.user?.id,
    });

    if (!agentId) {
      return _res.status(400).json({ error: 'agentId is required' });
    }

    parentMessageId = normalizeGatewayParentMessageId({ conversationId, parentMessageId });
    if (!parentMessageId && conversationId === 'new') {
      parentMessageId = Constants.NO_PARENT;
    }

    const resolvedSpec = ensureGatewaySpec({
      req,
      existingSpec: incoming?.spec,
      agentId,
    });

    const attachments =
      Array.isArray(incoming.attachments) && incoming.attachments.length > 0
        ? incoming.attachments
        : Array.isArray(incoming.files)
          ? incoming.files
          : [];

    const { images: imageAttachments, nonImages: nonImageAttachments } =
      splitGatewayAttachments(attachments);

    const formattedImages =
      GATEWAY_FILE_UPLOAD_ENABLED && imageAttachments.length > 0
        ? formatGatewayImagesForVision(imageAttachments)
        : [];

    const uploadedFiles =
      GATEWAY_FILE_UPLOAD_ENABLED && nonImageAttachments.length > 0
        ? await uploadGatewayFiles({ req, attachments: nonImageAttachments })
        : [];

    const { attachments: _ignoredAttachments, files: _ignoredFiles, ...safeIncoming } = incoming;

    req.body = {
      ...safeIncoming,
      text,
      endpoint: 'agents',
      endpointType: 'agents',
      conversationId,
      parentMessageId,
      agent_id: agentId,
      streamId,
      files: uploadedFiles,
      channel: identity.channel,
      accountId: identity.accountId,
      externalUserId: identity.externalUserId,
      externalChatId: identity.externalChatId,
      externalMessageId,
      externalUpdateId,
      externalThreadId,
    };

    const inputMode =
      typeof incoming.inputMode === 'string'
        ? incoming.inputMode
        : typeof incoming.viventiumInputMode === 'string'
          ? incoming.viventiumInputMode
          : '';
    if (inputMode) {
      req.body.viventiumInputMode = inputMode;
    }

    if (resolvedSpec) {
      req.body.spec = resolvedSpec;
    }

    if (!req.body.viventiumSurface) {
      req.body.viventiumSurface = identity.channel;
    }

    if (formattedImages.length > 0) {
      req._gatewayImages = formattedImages;
      logger.info(
        '[VIVENTIUM][gateway/chat] Images prepared for vision: count=%d channel=%s',
        formattedImages.length,
        identity.channel,
      );
    }

    req._viventiumGateway = true;

    logger.info(
      '[VIVENTIUM][gateway/chat] Request channel=%s account=%s externalUserId=%s conversationId=%s parentMessageId=%s agentId=%s streamId=%s',
      identity.channel,
      identity.accountId,
      identity.externalUserId,
      conversationId,
      parentMessageId,
      agentId,
      streamId,
    );

    next();
  },
  validateConvoAccess,
  buildEndpointOption,
  async (req, res, next) => {
    const originalJson = typeof res.json === 'function' ? res.json.bind(res) : null;
    if (originalJson) {
      res.json = (payload) => {
        if (payload && typeof payload === 'object') {
          if (!payload.conversationId && typeof req.body?.conversationId === 'string') {
            payload.conversationId = req.body.conversationId;
          }
          if (!payload.parentMessageId && typeof req.body?.parentMessageId === 'string') {
            payload.parentMessageId = req.body.parentMessageId;
          }
          if (!payload.streamId && typeof req.body?.streamId === 'string') {
            payload.streamId = req.body.streamId;
          }
        }
        return originalJson(payload);
      };
    }
    return AgentController(req, res, next, initializeClient, addTitle);
  },
);

router.get('/stream/:streamId', gatewayAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = req.user?.id;
  const isResume = req.query.resume === 'true';

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (job.metadata?.userId && job.metadata.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sentAttachmentKeys = new Set();

  const rememberAttachment = (attachment) => {
    const key = attachment?.file_id || attachment?.filepath || attachment?.filename || '';
    if (!key) {
      return false;
    }
    if (sentAttachmentKeys.has(key)) {
      return true;
    }
    sentAttachmentKeys.add(key);
    return false;
  };

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded) {
      writeSseEvent(res, 'message', { type: 'sync', resumeState });
    }
  }

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      if (res.writableEnded) {
        return;
      }

      const attachments = extractAttachments(event);
      for (const attachment of attachments) {
        if (rememberAttachment(attachment)) {
          continue;
        }
        writeSseEvent(res, 'attachment', attachment);
      }

      const deltas = extractTextDeltas(event);
      for (const delta of deltas) {
        if (delta) {
          writeSseEvent(res, 'message', { type: 'delta', text: delta });
        }
      }

      if (event?.event === 'on_cortex_update' || event?.event === 'on_cortex_followup') {
        writeSseEvent(res, 'message', {
          type: 'status',
          event: event.event,
          data: event.data,
        });
      }
    },
    (event) => {
      if (res.writableEnded) {
        return;
      }

      const finalError = extractFinalError(event);
      if (finalError) {
        writeSseEvent(res, 'error', { error: finalError });
      }

      const finalText = extractFinalResponseText(event);
      const responseMessageId = extractResponseMessageId(event);

      const attachments = extractAttachments(event);
      for (const attachment of attachments) {
        if (rememberAttachment(attachment)) {
          continue;
        }
        writeSseEvent(res, 'attachment', attachment);
      }

      if (finalText) {
        writeSseEvent(res, 'message', {
          type: 'final',
          text: finalText,
          messageId: responseMessageId,
        });
      }

      writeSseEvent(res, 'done', {
        final: true,
        messageId: responseMessageId,
      });
      res.end();
    },
    (error) => {
      if (!res.writableEnded) {
        writeSseEvent(res, 'error', { error: String(error || 'Stream error') });
        res.end();
      }
    },
  );

  if (!result) {
    return res.status(404).json({ error: 'Failed to subscribe to stream' });
  }

  req.on('close', () => {
    result.unsubscribe();
  });
});

router.get('/cortex/:messageId', gatewayAuth, async (req, res) => {
  const userId = req.user?.id;
  const messageId = req.params?.messageId;
  const conversationId =
    typeof req.query?.conversationId === 'string' ? req.query.conversationId : '';

  if (typeof userId !== 'string' || userId.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return res.status(400).json({ error: 'messageId is required' });
  }

  try {
    const state = await getCortexMessageState({
      userId,
      messageId,
      conversationId,
    });
    if (!state) {
      return res.status(404).json({ error: 'Message not found' });
    }

    return res.json(state);
  } catch (err) {
    logger.error('[VIVENTIUM][gateway/cortex] Failed to load cortex data:', err);
    return res.status(500).json({ error: 'Failed to load cortex data' });
  }
});

router.get('/files/download/:file_id', gatewayAuth, configMiddleware, fileAccess, async (req, res) => {
  try {
    const file = req.fileAccess?.file;
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (checkOpenAIStorage(file.source) && !file.model) {
      return res.status(400).send('The model used when creating this file is not available');
    }

    const { getDownloadStream } = getStrategyFunctions(file.source);
    if (!getDownloadStream) {
      logger.warn(
        '[VIVENTIUM][gateway/files/download] No getDownloadStream for source=%s file_id=%s',
        file.source,
        file.file_id,
      );
      return res.status(501).send('Not Implemented');
    }

    const cleanedFilename = cleanFileName(file.filename);
    res.setHeader('Content-Disposition', `attachment; filename="${cleanedFilename}"`);
    res.setHeader('Content-Type', file.type || 'application/octet-stream');
    res.setHeader('X-File-Metadata', JSON.stringify(file));

    if (checkOpenAIStorage(file.source)) {
      req.body = { model: file.model };
      const endpointMap = {
        [FileSources.openai]: EModelEndpoint.assistants,
        [FileSources.azure]: EModelEndpoint.azureAssistants,
      };
      const { openai } = await getOpenAIClient({
        req,
        res,
        overrideEndpoint: endpointMap[file.source],
      });
      const passThrough = await getDownloadStream(file.file_id, openai);
      const stream =
        passThrough.body && typeof passThrough.body.getReader === 'function'
          ? Readable.fromWeb(passThrough.body)
          : passThrough.body;
      stream.pipe(res);
      return;
    }

    const fileStream = await getDownloadStream(req, file.filepath);
    fileStream.on('error', (streamError) => {
      logger.error('[VIVENTIUM][gateway/files/download] Stream error:', streamError);
    });
    fileStream.pipe(res);
  } catch (error) {
    logger.error('[VIVENTIUM][gateway/files/download] Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

function isValidCodeFileId(str) {
  return /^[A-Za-z0-9_-]{21}$/.test(str);
}

router.get('/files/code/download/:session_id/:fileId', gatewayAuth, configMiddleware, async (req, res) => {
  try {
    const { session_id, fileId } = req.params;
    const logPrefix = `[VIVENTIUM][gateway/files/code/download] session=${session_id} file=${fileId}`;

    if (!session_id || !fileId) {
      return res.status(400).send('Bad request');
    }

    if (!isValidCodeFileId(session_id) || !isValidCodeFileId(fileId)) {
      logger.debug('%s invalid session_id or fileId', logPrefix);
      return res.status(400).send('Bad request');
    }

    const { getDownloadStream } = getStrategyFunctions(FileSources.execute_code);
    if (!getDownloadStream) {
      logger.warn('%s missing execute_code getDownloadStream', logPrefix);
      return res.status(501).send('Not Implemented');
    }

    const result = await loadAuthValues({ userId: req.user.id, authFields: [EnvVar.CODE_API_KEY] });
    const response = await getDownloadStream(`${session_id}/${fileId}`, result[EnvVar.CODE_API_KEY]);
    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    logger.error('[VIVENTIUM][gateway/files/code/download] Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

module.exports = router;
