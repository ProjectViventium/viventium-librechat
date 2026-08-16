/* === VIVENTIUM START ===
 * Feature: LibreChat Telegram Bridge - Telegram Gateway Endpoints
 *
 * Purpose:
 * - Allow the Telegram bot to call LibreChat Agents without user JWTs.
 * - Authenticate via shared secret + configured userId.
 *
 * Endpoints:
 * - POST /api/viventium/telegram/chat   -> starts Agents run; returns { streamId, conversationId }
 * - GET  /api/viventium/telegram/stream/:streamId -> SSE subscription to GenerationJobManager stream
 *
 * Added: 2026-01-13
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const mime = require('mime');
const { Readable } = require('stream');
const { GenerationJobManager } = require('@librechat/api');
const { EnvVar } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ContentTypes,
  FileSources,
  EModelEndpoint,
  checkOpenAIStorage,
} = require('librechat-data-provider');
const {
  configMiddleware,
  validateConvoAccess,
  buildEndpointOption,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeImageBuffer } = require('~/server/services/Files/images');
const { cleanFileName } = require('~/server/utils/files');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const {
  getUserById,
  getMessages,
  getConvo,
  updateUserViventiumOrchestrationPreferences,
} = require('~/models');
/* === VIVENTIUM START ===
 * Feature: Telegram ingress idempotency store.
 * === VIVENTIUM END === */
const { ViventiumTelegramIngressEvent } = require('~/db/models');
const {
  normalizeTelegramId,
  createLinkToken,
  buildLinkUrl,
  resolveTelegramMapping,
  touchTelegramMapping,
} = require('~/server/services/TelegramLinkService');
/* === VIVENTIUM NOTE ===
 * Feature: Sidebar parity for gateway-created conversations (title + icon).
 * Purpose: Match web UI behavior for new conversations created via Telegram gateway.
 * === VIVENTIUM NOTE === */
const {
  ensureGatewaySpec,
  normalizeGatewayParentMessageId,
} = require('~/server/services/viventium/gatewayConvoDefaults');
const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');
const {
  getGlassHiveCallbackStateForMessage,
} = require('~/server/services/viventium/GlassHiveCallbackMessageService');
const {
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  deliveryBacklogSummary,
} = require('~/server/services/viventium/GlassHiveCallbackDeliveryService');
const {
  resolveReusableConversationState,
} = require('~/server/services/viventium/conversationThreading');
const {
  attachLogicalTurnMetadata,
  createTelegramInteractionContext,
  getTrustedInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');

const EXTRACTED_DOCUMENT_IMAGE_MAX_DIMENSION = 768;
/* === VIVENTIUM START ===
 * Feature: Telegram quick-call launch
 * Purpose: Reuse the same call-session creation contract as the web call button.
 * === VIVENTIUM END === */
const {
  createCallSession,
  resolveUserVoiceRoute,
} = require('~/server/services/viventium/CallSessionService');
const {
  buildCallLaunchResponse,
  resolveTelegramPublicPlaygroundBaseUrl,
} = require('~/server/services/viventium/callLaunch');
const {
  assertVoiceAgentAccess,
} = require('~/server/services/viventium/VoiceAgentAuthorizationService');
const {
  getActiveWorkInteractiveSnapshot,
  getActiveWorkPage,
} = require('~/server/services/viventium/GlassHiveAccountService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');

const router = express.Router();

/* === VIVENTIUM NOTE ===
 * Feature: Telegram SSE trace logging (opt-in)
 * Enable with VIVENTIUM_TELEGRAM_TRACE=1
 * === VIVENTIUM NOTE === */
const TELEGRAM_TRACE_ENABLED = (process.env.VIVENTIUM_TELEGRAM_TRACE || '').trim() === '1';
const traceTelegram = (...args) => {
  if (TELEGRAM_TRACE_ENABLED) {
    logger.info(...args);
  }
};

/* === VIVENTIUM NOTE ===
 * Feature: Optional Telegram timing logs (per-request microstep timing).
 * Enable with VIVENTIUM_TELEGRAM_TIMING_ENABLED=1
 * === VIVENTIUM NOTE === */
const TELEGRAM_TIMING_ENABLED =
  String(process.env.VIVENTIUM_TELEGRAM_TIMING_ENABLED || '').trim() === '1';
const logTelegramTiming = (traceId, step, startTs, extra = '') => {
  if (!TELEGRAM_TIMING_ENABLED) {
    return;
  }
  const elapsedMs = performance.now() - startTs;
  const suffix = extra ? ` ${extra}` : '';
  logger.info(
    `[TG_TIMING][lc] trace=${traceId || 'na'} step=${step} ms=${elapsedMs.toFixed(1)}${suffix}`,
  );
};
/* === VIVENTIUM NOTE ===
 * Feature: Deep timing base synchronization (optional)
 * === VIVENTIUM NOTE === */
const { setTimingBase } = require('~/server/services/viventium/telegramTimingDeep');

const TELEGRAM_SECRET_HEADER = 'x-viventium-telegram-secret';
const TELEGRAM_PUBLIC_PLAYGROUND_REQUIRED_ERROR =
  'Telegram calls need a configured public HTTPS Viventium voice URL';

function getTelegramSecret() {
  return process.env.VIVENTIUM_TELEGRAM_SECRET || process.env.VIVENTIUM_CALL_SESSION_SECRET || '';
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalBoolean(value, defaultValue = null) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return defaultValue;
  }
  if (typeof value !== 'string') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/* === VIVENTIUM START ===
 * Feature: Normalize Telegram ingress id values for idempotency keys.
 * === VIVENTIUM END === */
function normalizeIngressId(value) {
  if (value == null) {
    return '';
  }
  const normalized = String(value).trim();
  return normalized;
}

/* === VIVENTIUM START ===
 * Feature: Detect duplicate-key insert errors from Mongo.
 * === VIVENTIUM END === */
function isMongoDuplicateKeyError(error) {
  return Boolean(error) && Number(error.code) === 11000;
}

/* === VIVENTIUM START ===
 * Feature: Reserve a Telegram ingress key to absorb retries/replays.
 * === VIVENTIUM END === */
async function reserveTelegramIngress({
  telegramUserId,
  telegramChatId,
  telegramMessageId,
  telegramUpdateId,
  conversationId,
  traceId,
}) {
  if (!TELEGRAM_INGRESS_DEDUPE_ENABLED) {
    return { duplicate: false };
  }

  const messageKeyPart = telegramMessageId ? `m:${telegramChatId}:${telegramMessageId}` : '';
  const updateKeyPart = telegramUpdateId ? `u:${telegramUpdateId}` : '';
  const dedupeKey = messageKeyPart || updateKeyPart;
  if (!dedupeKey) {
    return { duplicate: false };
  }

  const expiresAt = new Date(Date.now() + TELEGRAM_INGRESS_DEDUPE_TTL_S * 1000);
  try {
    const record = await ViventiumTelegramIngressEvent.create({
      dedupeKey,
      telegramUserId,
      telegramChatId,
      telegramMessageId,
      telegramUpdateId,
      traceId,
      conversationId,
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

/* === VIVENTIUM NOTE ===
 * Feature: Telegram file upload settings
 * === VIVENTIUM NOTE === */
function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

const TELEGRAM_FILE_UPLOAD_ENABLED = parseBoolEnv('VIVENTIUM_TELEGRAM_FILE_UPLOAD_ENABLED', true);
const TELEGRAM_MAX_FILE_BYTES = parseIntEnv('VIVENTIUM_TELEGRAM_MAX_FILE_SIZE', 10485760);
/* === VIVENTIUM START ===
 * Feature: Telegram ingress de-duplication controls.
 * === VIVENTIUM END === */
const TELEGRAM_INGRESS_DEDUPE_ENABLED = parseBoolEnv(
  'VIVENTIUM_TELEGRAM_INGRESS_DEDUPE_ENABLED',
  true,
);
const TELEGRAM_INGRESS_DEDUPE_TTL_S = Math.max(
  parseIntEnv('VIVENTIUM_TELEGRAM_INGRESS_DEDUPE_TTL_S', 86400),
  60,
);
const TELEGRAM_CONVERSATION_IDLE_MAX_M = Math.max(
  parseIntEnv('VIVENTIUM_TELEGRAM_CONVERSATION_IDLE_MAX_M', 1440),
  0,
);
const TELEGRAM_CONVERSATION_IDLE_MAX_MS =
  TELEGRAM_CONVERSATION_IDLE_MAX_M > 0 ? TELEGRAM_CONVERSATION_IDLE_MAX_M * 60 * 1000 : 0;

function resolveLingerMs(req) {
  const lingerQuery = req.query?.linger;
  const requestedMs = Number.parseInt(req.query?.lingerMs, 10);
  const defaultMs = parseIntEnv('VIVENTIUM_TELEGRAM_SSE_LINGER_MS', 0);
  const maxMs = parseIntEnv('VIVENTIUM_TELEGRAM_SSE_LINGER_MAX_MS', 300000);
  const enabled = lingerQuery === '1' || lingerQuery === 'true' || Number.isFinite(requestedMs);

  if (!enabled) {
    return 0;
  }

  let candidate = Number.isFinite(requestedMs) ? requestedMs : defaultMs;
  if (!Number.isFinite(candidate) || candidate < 0) {
    candidate = 0;
  }
  if (candidate > maxMs) {
    candidate = maxMs;
  }
  return candidate;
}

/* === VIVENTIUM NOTE ===
 * Feature: Telegram follow-up polling (DB-backed cortex parts)
 * Purpose: Allow Telegram to mirror LibreChat UI follow-up behavior.
 * === VIVENTIUM NOTE === */
/* === VIVENTIUM NOTE ===
 * Feature: Per-Telegram-user auth + linking
 * Purpose: Resolve LibreChat users by Telegram user id and return link URLs when unlinked.
 * === VIVENTIUM NOTE === */
function extractTelegramIdentity(req) {
  const body = req.body ?? {};
  const query = req.query ?? {};
  const telegramUserId = normalizeTelegramId(body.telegramUserId || query.telegramUserId || '');
  const telegramChatId = normalizeTelegramId(body.telegramChatId || query.telegramChatId || '');
  const telegramUsername =
    typeof body.telegramUsername === 'string'
      ? body.telegramUsername.trim()
      : typeof query.telegramUsername === 'string'
        ? query.telegramUsername.trim()
        : '';
  const alwaysVoiceResponse = parseOptionalBoolean(
    body.alwaysVoiceResponse ??
      body.always_voice_response ??
      query.alwaysVoiceResponse ??
      query.always_voice_response,
    null,
  );
  const voiceResponsesEnabled = parseOptionalBoolean(
    body.voiceResponsesEnabled ??
      body.voice_responses_enabled ??
      query.voiceResponsesEnabled ??
      query.voice_responses_enabled,
    null,
  );
  return {
    telegramUserId,
    telegramChatId,
    telegramUsername,
    alwaysVoiceResponse,
    voiceResponsesEnabled,
  };
}

async function resolveTelegramUserId({ telegramUserId }) {
  if (!telegramUserId) {
    return { userId: '', source: 'missing' };
  }
  const mapping = await resolveTelegramMapping({ telegramUserId });
  if (!mapping?.libreChatUserId) {
    return { userId: '', source: 'unlinked' };
  }
  return { userId: mapping.libreChatUserId.toString(), source: 'mapping' };
}

async function issueTelegramLink(req, { telegramUserId, telegramUsername }) {
  const { token } = await createLinkToken({ telegramUserId, telegramUsername });
  const linkUrl = buildLinkUrl(req, token);
  return linkUrl;
}

async function resolveAgentId({ req, conversationId, requestedAgentId, userId }) {
  if (conversationId && conversationId !== 'new') {
    try {
      const convo = await getConvo(userId, conversationId);
      if (convo?.agent_id) {
        return convo.agent_id;
      }
    } catch (err) {
      logger.warn('[VIVENTIUM][telegram] Failed to load conversation agent_id:', err?.message);
    }
  }

  if (typeof requestedAgentId === 'string' && requestedAgentId.length > 0) {
    return requestedAgentId;
  }

  const config = req.config || {};
  const fallback =
    config.interface?.defaultAgent ||
    config.endpoints?.agents?.defaultId ||
    process.env.VIVENTIUM_MAIN_AGENT_ID ||
    '';

  return fallback;
}

async function telegramAuth(req, res, next) {
  try {
    const secret = req.get('X-VIVENTIUM-TELEGRAM-SECRET') || req.get(TELEGRAM_SECRET_HEADER) || '';
    const expected = getTelegramSecret();

    if (!expected) {
      const err = new Error('VIVENTIUM_TELEGRAM_SECRET is not set');
      err.status = 500;
      throw err;
    }
    if (!secret || secret !== expected) {
      const err = new Error('Unauthorized telegram gateway');
      err.status = 401;
      throw err;
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Per-Telegram-user auth + linking
     * === VIVENTIUM NOTE === */
    const identity = extractTelegramIdentity(req);
    if (!identity.telegramUserId) {
      const err = new Error('telegramUserId is required');
      err.status = 400;
      throw err;
    }

    /* === VIVENTIUM NOTE === */
    const { userId, source } = await resolveTelegramUserId({
      telegramUserId: identity.telegramUserId,
    });
    /* === VIVENTIUM NOTE === */
    if (!userId) {
      if (req.method === 'POST' && (req.path === '/chat' || req.path === '/call-link')) {
        /* === VIVENTIUM NOTE === */
        const linkUrl = await issueTelegramLink(req, identity);
        if (!linkUrl) {
          const err = new Error('Link URL base is not configured');
          err.status = 500;
          throw err;
        }
        return res.status(401).json({
          error: 'Telegram account not linked',
          code: 'TELEGRAM_ACCOUNT_NOT_LINKED',
          linkRequired: true,
          linkUrl,
        });
        /* === VIVENTIUM NOTE === */
      }
      const err = new Error(
        source === 'missing' ? 'telegramUserId is required' : 'Telegram account not linked',
      );
      err.status = 401;
      if (source !== 'missing') {
        err.code = 'TELEGRAM_ACCOUNT_NOT_LINKED';
        err.linkRequired = true;
      }
      throw err;
    }

    const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      const err = new Error('User not found for telegram bridge');
      err.status = 401;
      throw err;
    }

    user.id = user._id.toString();
    if (!user.role) {
      user.role = SystemRoles.USER;
    }
    await touchTelegramMapping({
      telegramUserId: identity.telegramUserId,
      telegramUsername: identity.telegramUsername,
      alwaysVoiceResponse: identity.alwaysVoiceResponse,
      voiceResponsesEnabled: identity.voiceResponsesEnabled,
    });

    req.user = user;
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][telegramAuth] Auth failed:', err);
    /* === VIVENTIUM START ===
     * Feature: Stable Telegram authentication outcomes.
     * Purpose: Clients must classify account linking from structured authority, never prose.
     * === VIVENTIUM END === */
    return res.status(status).json({
      error: err?.message || 'Unauthorized',
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.linkRequired === true ? { linkRequired: true } : {}),
    });
  }
}

/* === VIVENTIUM START ===
 * Feature: Durable GlassHive Telegram callback dispatcher auth.
 * Purpose: The bot must claim pending callback deliveries across linked users without
 * requiring a per-user Telegram id in the request body. This route is scoped to the
 * delivery ledger only and uses the existing Telegram gateway shared secret.
 * Added: 2026-05-06
 * === VIVENTIUM END === */
async function telegramBridgeAuth(req, res, next) {
  try {
    const secret = req.get('X-VIVENTIUM-TELEGRAM-SECRET') || req.get(TELEGRAM_SECRET_HEADER) || '';
    const expected = getTelegramSecret();
    if (!expected) {
      const err = new Error('VIVENTIUM_TELEGRAM_SECRET is not set');
      err.status = 500;
      throw err;
    }
    if (!secret || secret !== expected) {
      const err = new Error('Unauthorized telegram gateway');
      err.status = 401;
      throw err;
    }
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][telegramBridgeAuth] Auth failed:', err);
    return res.status(status).json({ error: err?.message || 'Unauthorized' });
  }
}

/* === VIVENTIUM NOTE ===
 * Feature: Telegram file upload to LibreChat agent
 * Purpose: Format Telegram files (images) as image_url parts for vision model support.
 * Updated: 2026-01-31 - Changed to use req._telegramImages for direct injection into agent messages.
 * === VIVENTIUM NOTE === */
function formatTelegramImagesForVision(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }
  // Only process image files for vision model support
  return files
    .map((file) => {
      if (!file || typeof file !== 'object') {
        return null;
      }
      const filename = typeof file.filename === 'string' ? file.filename : '';
      const mimeType =
        (typeof file.mime_type === 'string' && file.mime_type.trim()) ||
        (filename ? mime.getType(filename) : '') ||
        '';
      if (!file.data || !mimeType.startsWith('image/')) {
        return null;
      }
      const base64Data = extractBase64Payload(file.data);
      if (!base64Data) {
        return null;
      }
      return {
        base64Data,
        mimeType,
      };
    })
    .filter(Boolean)
    .map((file) => ({
      // Format matches LibreChat's image_url content part structure
      type: ContentTypes.IMAGE_URL,
      image_url: {
        url: `data:${file.mimeType};base64,${file.base64Data}`,
        detail: 'auto',
      },
    }));
}

/* === VIVENTIUM START ===
 * Feature: Mixed-document visual parity for Telegram uploads.
 * Purpose: Reuse the same vision injection path for images extracted from PPTX/OCR document
 * attachments so the agent sees deck visuals along with extracted text and notes.
 * === VIVENTIUM END === */
async function formatExtractedImagesForVision(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const formatted = [];
  for (const image of images) {
    try {
      if (typeof image !== 'string' || !image.trim()) {
        continue;
      }
      const trimmed = image.trim();
      const match = trimmed.match(/^data:([^;]+);base64,(.*)$/);
      const mimeType = match ? match[1] : 'image/png';
      const base64Data = match ? match[2] : extractBase64Payload(trimmed);
      if (!mimeType.startsWith('image/') || !base64Data) {
        continue;
      }
      const inputBuffer = Buffer.from(base64Data, 'base64');
      const { buffer } = await resizeImageBuffer(
        inputBuffer,
        { px: EXTRACTED_DOCUMENT_IMAGE_MAX_DIMENSION },
        EModelEndpoint.anthropic,
      );
      const resizedBase64 = buffer.toString('base64');
      formatted.push({
        type: ContentTypes.IMAGE_URL,
        image_url: {
          url: `data:${mimeType};base64,${resizedBase64}`,
          detail: 'auto',
        },
      });
    } catch (err) {
      logger.warn(
        '[VIVENTIUM][telegram/chat] Failed to prepare extracted document image for vision: %s',
        err?.message || err,
      );
    }
  }

  return formatted;
}

/* === VIVENTIUM NOTE ===
 * Feature: Telegram non-image file uploads (Option B: upload to provider/storage)
 * === VIVENTIUM NOTE === */
function extractBase64Payload(payload) {
  if (typeof payload !== 'string') {
    return '';
  }
  const trimmed = payload.trim();
  if (!trimmed) {
    return '';
  }
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

function normalizeTelegramFilename(filename, fallback) {
  const raw = typeof filename === 'string' && filename.trim() ? filename.trim() : fallback;
  const base = path.basename(raw || fallback || 'telegram-file');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeTelegramTempFile(buffer, filename) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'librechat-telegram-'));
  const filePath = path.join(tempDir, filename);
  await fs.promises.writeFile(filePath, buffer);
  return { tempDir, filePath };
}

async function uploadTelegramFiles({ req, files, agentId }) {
  if (!TELEGRAM_FILE_UPLOAD_ENABLED) {
    return [];
  }

  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  let filterFile;
  let processAgentFileUpload;
  ({ filterFile, processAgentFileUpload } = require('~/server/services/Files/process'));

  const uploaded = [];
  req._telegramUploadedDocumentImages = [];
  const originalFile = req.file;
  const originalBody = req.body;
  const originalDurableMissionAttachment = req._viventiumBridgeDurableMissionAttachment;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || typeof file !== 'object' || !file.data) {
      continue;
    }

    const base64Data = extractBase64Payload(file.data);
    if (!base64Data) {
      continue;
    }

    const byteCount = estimateBase64Bytes(base64Data);
    if (byteCount <= 0 || byteCount > TELEGRAM_MAX_FILE_BYTES) {
      logger.warn(
        '[VIVENTIUM][telegram/chat] Skipping file (size=%d, max=%d)',
        byteCount,
        TELEGRAM_MAX_FILE_BYTES,
      );
      continue;
    }

    const mimeType =
      (typeof file.mime_type === 'string' && file.mime_type.trim()) ||
      (file.filename ? mime.getType(file.filename) : '') ||
      'application/octet-stream';

    const fallbackName = `telegram-file-${Date.now()}-${index + 1}`;
    let safeName = normalizeTelegramFilename(file.filename, fallbackName);
    if (!path.extname(safeName)) {
      const extension = mime.getExtension(mimeType);
      if (extension) {
        safeName = `${safeName}.${extension}`;
      }
    }

    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (err) {
      logger.warn('[VIVENTIUM][telegram/chat] Invalid base64 payload for %s', safeName);
      continue;
    }

    if (!buffer || buffer.length === 0) {
      continue;
    }

    const { tempDir, filePath } = await writeTelegramTempFile(buffer, safeName);
    const fileId = crypto.randomUUID();
    const tempFile = {
      path: filePath,
      originalname: safeName,
      mimetype: mimeType,
      size: buffer.length,
      filename: safeName,
      destination: tempDir,
    };

    /* === VIVENTIUM START ===
     * Feature: Bridge attachment parity with native agent uploads.
     * Purpose: Preserve the active agent context when resolving provider-native vs context uploads.
     * === VIVENTIUM END === */
    const metadata = {
      file_id: fileId,
      temp_file_id: fileId,
      message_file: true,
      agent_id: agentId,
    };

    try {
      req.file = tempFile;
      req._viventiumBridgeDocumentImageExtraction = true;
      // Keep an owner-scoped copy of Telegram-native images under the canonical uploads root.
      // Main still receives the already-formatted vision part, while a durable GlassHive mission
      // receives only this file reference (never raw Telegram ids or base64 in its prompt).
      req._viventiumBridgeDurableMissionAttachment = mimeType.startsWith('image/');
      const model =
        originalBody && typeof originalBody === 'object' ? originalBody.model : undefined;
      req.body = {
        endpoint: 'agents',
        endpointType: 'agents',
        agent_id: agentId,
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
        uploaded.push({
          ...result,
          viventium_media_group_index: index,
          viventium_media_group_kind: mimeType.startsWith('image/') ? 'image' : 'file',
        });
        const extractedImages = await formatExtractedImagesForVision(
          result.viventiumExtractedImages,
        );
        if (extractedImages.length > 0) {
          req._telegramUploadedDocumentImages.push(...extractedImages);
          logger.info(
            '[VIVENTIUM][telegram/chat] Prepared %d extracted document image(s) for vision from %s',
            extractedImages.length,
            safeName,
          );
        }
      }
    } catch (err) {
      logger.error('[VIVENTIUM][telegram/chat] File upload failed:', err);
      const reason =
        typeof err?.message === 'string' && err.message.trim().length > 0
          ? err.message.trim()
          : 'Attachment processing failed';
      throw new Error(`Telegram attachment upload failed for "${safeName}": ${reason}`);
    } finally {
      req.file = originalFile;
      req.body = originalBody;
      req._viventiumBridgeDurableMissionAttachment = originalDurableMissionAttachment;
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        logger.debug('[VIVENTIUM][telegram/chat] Temp file cleanup failed: %s', err?.message);
      }
      try {
        await fs.promises.rmdir(tempDir);
      } catch (err) {
        logger.debug('[VIVENTIUM][telegram/chat] Temp dir cleanup failed: %s', err?.message);
      }
    }
  }

  return uploaded;
}

function splitTelegramFiles(files) {
  const images = [];
  const nonImages = [];
  if (!Array.isArray(files)) {
    return { images, nonImages };
  }

  for (const file of files) {
    if (!file || typeof file !== 'object') {
      continue;
    }
    const mimeType =
      (typeof file.mime_type === 'string' && file.mime_type.trim()) ||
      (file.filename ? mime.getType(file.filename) : '') ||
      '';
    if (mimeType.startsWith('image/')) {
      images.push(file);
    } else {
      nonImages.push(file);
    }
  }

  return { images, nonImages };
}

/* === VIVENTIUM START ===
 * Feature: Telegram quick-call launch
 * Purpose: Mint a browser-facing call deep-link for the linked Telegram user.
 * === VIVENTIUM END === */
router.post('/call-link', telegramAuth, configMiddleware, async (req, res) => {
  try {
    const incoming = req.body ?? {};
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const normalizedConversationId =
      typeof incoming.conversationId === 'string' && incoming.conversationId.trim()
        ? incoming.conversationId.trim()
        : 'new';
    const requestedAgentId = typeof incoming.agentId === 'string' ? incoming.agentId.trim() : '';

    const effectiveAgentId = await resolveAgentId({
      req,
      conversationId: normalizedConversationId,
      requestedAgentId,
      userId,
    });

    if (!effectiveAgentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    await assertVoiceAgentAccess({ req, agentId: effectiveAgentId });

    /* === VIVENTIUM START ===
     * Purpose: Telegram cannot open localhost browser-voice links.
     * Contract: /call must fail honestly until a public HTTPS playground URL is configured.
     * === VIVENTIUM END === */
    const telegramPlaygroundBase = resolveTelegramPublicPlaygroundBaseUrl();
    if (!telegramPlaygroundBase) {
      return res.status(409).json({
        error: TELEGRAM_PUBLIC_PLAYGROUND_REQUIRED_ERROR,
        publicPlaygroundRequired: true,
      });
    }

    const session = await createCallSession({
      userId,
      agentId: effectiveAgentId,
      conversationId: normalizedConversationId,
    });
    return res.json(buildCallLaunchResponse(session, { preferPublicPlayground: true }));
  } catch (err) {
    if (err?.code === 'no_route' && err?.status === 404) {
      return res.status(404).json({
        code: 'no_route',
        message: 'Voice assistant is unavailable.',
        retryable: false,
      });
    }
    logger.error('[VIVENTIUM][telegram/call-link] Failed to create call link:', err);
    return res.status(500).json({ error: 'Failed to create call link' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Telegram voice route parity
 * Purpose: Let the Telegram bridge read the linked user's saved effective voice route
 * without introducing a separate Telegram-only settings surface.
 * === VIVENTIUM END === */
router.get('/voice-route', telegramAuth, async (req, res) => {
  try {
    const voiceRoute = await resolveUserVoiceRoute(req.user?.id);
    return res.json({ voiceRoute });
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/voice-route] Failed to resolve voice route:', err);
    return res.status(500).json({ error: 'Failed to resolve voice route' });
  }
});

router.post(
  '/chat',
  telegramAuth,
  configMiddleware,
  async (req, _res, next) => {
    const incoming = req.body ?? {};
    const text = typeof incoming.text === 'string' ? incoming.text : '';
    const requestedConversationId =
      typeof incoming.conversationId === 'string' ? incoming.conversationId : 'new';
    /* === VIVENTIUM NOTE ===
     * Feature: Telegram request timing (microstep profiling).
     * Purpose: Capture granular latency for Telegram -> LibreChat pipeline.
     * === VIVENTIUM NOTE === */
    const traceId = typeof incoming.traceId === 'string' ? incoming.traceId : '';
    const requestStartTs = performance.now();
    logTelegramTiming(traceId, 'request_start', requestStartTs);
    // === VIVENTIUM NOTE ===
    // Feature: Deep timing base sync (align deep logs with request_start).
    setTimingBase(req, requestStartTs);
    // === VIVENTIUM NOTE ===
    const requestedAgentId =
      typeof incoming.agentId === 'string'
        ? incoming.agentId
        : typeof incoming.agent_id === 'string'
          ? incoming.agent_id
          : '';
    const telegramChatId =
      typeof incoming.telegramChatId === 'string' ? incoming.telegramChatId : '';
    const telegramUserId =
      typeof incoming.telegramUserId === 'string' ? incoming.telegramUserId : '';
    const telegramMessageId = normalizeIngressId(
      incoming.telegramMessageId ?? incoming.telegram_message_id,
    );
    const telegramUpdateId = normalizeIngressId(
      incoming.telegramUpdateId ?? incoming.telegram_update_id,
    );
    const alwaysVoiceResponse = parseOptionalBoolean(
      incoming.alwaysVoiceResponse ?? incoming.always_voice_response,
      null,
    );
    const voiceResponsesEnabled = parseOptionalBoolean(
      incoming.voiceResponsesEnabled ?? incoming.voice_responses_enabled,
      null,
    );
    const voiceMode = parseOptionalBoolean(incoming.voiceMode ?? incoming.voice_mode, null);
    const telegramAudioRequested = parseOptionalBoolean(
      incoming.telegramAudioRequested ??
        incoming.viventiumAudioRequested ??
        incoming.audioRequested ??
        incoming.audio_requested,
      null,
    );

    /* === VIVENTIUM START ===
     * Feature: Telegram ingress de-duplication (defense-in-depth).
     * Duplicate replay requests return 200/no-op so the bot does not emit duplicate turns.
     * === VIVENTIUM END === */
    const ingressReservation = await reserveTelegramIngress({
      telegramUserId,
      telegramChatId,
      telegramMessageId,
      telegramUpdateId,
      conversationId: requestedConversationId,
      traceId,
    });
    if (ingressReservation.duplicate) {
      logger.info(
        '[VIVENTIUM][telegram/chat] Duplicate ingress suppressed key=%s chatId=%s userId=%s',
        ingressReservation.dedupeKey,
        telegramChatId,
        telegramUserId,
      );
      logTelegramTiming(
        traceId,
        'duplicate_ingress',
        requestStartTs,
        `key=${ingressReservation.dedupeKey}`,
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
        ViventiumTelegramIngressEvent.deleteOne({ _id: ingressReservation.recordId }).catch(
          (err) => {
            logger.warn(
              '[VIVENTIUM][telegram/chat] Failed to release ingress reservation %s: %s',
              ingressReservation.recordId,
              err?.message,
            );
          },
        );
      });
    }

    await touchTelegramMapping({
      telegramUserId: telegramUserId || req.query?.telegramUserId || '',
      telegramUsername:
        typeof incoming.telegramUsername === 'string' ? incoming.telegramUsername : '',
      alwaysVoiceResponse,
      voiceResponsesEnabled,
    });
    /* === VIVENTIUM NOTE ===
     * Feature: Extract files for vision model support
     * === VIVENTIUM NOTE === */
    const telegramFiles = Array.isArray(incoming.files) ? incoming.files : [];
    /* === VIVENTIUM NOTE ===
     * Feature: Telegram stream isolation
     * Purpose: Ensure each Telegram request has a unique streamId (prevents stream collisions).
     * === VIVENTIUM NOTE === */
    const streamId = `telegram-${crypto.randomUUID()}`;

    const parentStartTs = performance.now();
    const conversationState = await resolveReusableConversationState({
      conversationId: requestedConversationId,
      userId: req.user?.id,
      surface: 'telegram',
      maxIdleMs: TELEGRAM_CONVERSATION_IDLE_MAX_MS,
    });
    const conversationId = conversationState.conversationId;
    let parentMessageId = conversationState.parentMessageId;
    const sourceEventId =
      normalizeIngressId(incoming.sourceEventId ?? incoming.source_event_id) ||
      telegramMessageId ||
      telegramUpdateId ||
      streamId;
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: conversationId,
        source_event_id: sourceEventId,
      }),
      {
        segment_stability: 'immediate',
        supersede_scope: 'response_and_authoring',
      },
      { commit_authority: 'external_adapter' },
    );
    logTelegramTiming(
      traceId,
      'parent_message_lookup',
      parentStartTs,
      `requestedConversationId=${requestedConversationId} conversationId=${conversationId} reason=${conversationState.reason}`,
    );
    if (requestedConversationId !== conversationId) {
      logger.info(
        '[VIVENTIUM][telegram/chat] Conversation reset: requested=%s resolved=%s reason=%s chatId=%s',
        requestedConversationId,
        conversationId,
        conversationState.reason,
        telegramChatId,
      );
    }
    logger.info(
      '[VIVENTIUM][telegram/chat] Resolved parentMessageId=%s for conversationId=%s chatId=%s',
      parentMessageId,
      conversationId,
      telegramChatId,
    );

    const agentResolveStartTs = performance.now();
    const agentId = await resolveAgentId({
      req,
      conversationId,
      requestedAgentId,
      userId: req.user?.id,
    });
    logTelegramTiming(
      traceId,
      'resolve_agent',
      agentResolveStartTs,
      `agentId=${agentId || 'none'}`,
    );

    if (!agentId) {
      return _res.status(400).json({ error: 'agentId is required' });
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Sidebar parity for gateway-created conversations (title + icon).
     * - Title generation: requires `parentMessageId === Constants.NO_PARENT` for new convos.
     * - Icon rendering: sidebar list relies on `conversation.iconURL`, which LibreChat derives
     *   from `spec` (modelSpecs) server-side (client-sent iconURL is stripped).
     * === VIVENTIUM NOTE === */
    parentMessageId = normalizeGatewayParentMessageId({ conversationId, parentMessageId });
    const resolvedSpec = ensureGatewaySpec({
      req,
      existingSpec: incoming?.spec,
      agentId,
    });

    /* === VIVENTIUM NOTE ===
     * Feature: Format images for vision model injection
     * Updated: 2026-01-31 - Use req._telegramImages for direct injection into agent messages
     * === VIVENTIUM NOTE === */
    const { images: telegramImageFiles } = splitTelegramFiles(telegramFiles);
    const imageFormatStartTs = performance.now();
    const formattedImages = TELEGRAM_FILE_UPLOAD_ENABLED
      ? formatTelegramImagesForVision(telegramImageFiles)
      : [];
    logTelegramTiming(
      traceId,
      'format_images',
      imageFormatStartTs,
      `count=${formattedImages.length}`,
    );
    const resolvedVoiceRoute = await resolveUserVoiceRoute(req.user?.id);

    const uploadStartTs = performance.now();
    let uploadedFiles = [];
    try {
      uploadedFiles = TELEGRAM_FILE_UPLOAD_ENABLED
        ? await uploadTelegramFiles({ req, files: telegramFiles, agentId })
        : [];
      logTelegramTiming(traceId, 'upload_files', uploadStartTs, `count=${uploadedFiles.length}`);
    } catch (err) {
      const reason =
        typeof err?.message === 'string' && err.message.trim().length > 0
          ? err.message.trim()
          : 'Attachment processing failed';
      logger.warn('[VIVENTIUM][telegram/chat] Attachment processing failed: %s', reason);
      logTelegramTiming(traceId, 'upload_files', uploadStartTs, 'failed=1');
      return _res.status(422).json({ attachmentProcessingError: true, error: reason });
    }
    const extractedDocumentImages = Array.isArray(req._telegramUploadedDocumentImages)
      ? req._telegramUploadedDocumentImages
      : [];
    const allFormattedImages = [...formattedImages, ...extractedDocumentImages];
    const hasImages = allFormattedImages.length > 0;
    const {
      files: _unusedFiles,
      iconURL: _unusedIconURL,
      interactionContext: _untrustedInteractionContext,
      interaction_context: _untrustedInteractionContextSnake,
      viventiumInteractionContext: _untrustedViventiumInteractionContext,
      adapterCapabilities: _untrustedAdapterCapabilities,
      adapter_capabilities: _untrustedAdapterCapabilitiesSnake,
      ...safeIncoming
    } = incoming;

    req.body = {
      ...safeIncoming,
      text,
      endpoint: 'agents',
      endpointType: 'agents',
      conversationId,
      parentMessageId,
      agent_id: agentId,
      streamId,
      files: uploadedFiles
        .filter((file) => file?.viventium_media_group_kind !== 'image')
        .map(
          ({ viventium_media_group_index: _index, viventium_media_group_kind: _kind, ...file }) =>
            file,
        ),
    };
    if (resolvedSpec) {
      req.body.spec = resolvedSpec;
    }
    if (traceId) {
      req.body.traceId = traceId;
    }
    if (telegramAudioRequested !== null) {
      req.body.telegramAudioRequested = telegramAudioRequested;
    }
    if (voiceMode !== null) {
      req.body.voiceMode = voiceMode;
    }
    if (
      (voiceMode === true || telegramAudioRequested === true) &&
      resolvedVoiceRoute?.tts?.provider
    ) {
      req.body.voiceProvider = resolvedVoiceRoute.tts.provider;
    }
    req.viventiumTelegramVoiceRoute = resolvedVoiceRoute;

    /* === VIVENTIUM NOTE ===
     * Feature: Store pre-formatted images for injection into agent messages
     * The AgentClient.buildMessages() will check req._telegramImages and inject into message.image_urls
     * === VIVENTIUM NOTE === */
    if (hasImages) {
      req._telegramImages = allFormattedImages;
      logger.info(
        '[VIVENTIUM][telegram/chat] Images prepared for vision: count=%d',
        allFormattedImages.length,
      );
    }
    /* === VIVENTIUM START ===
     * Feature: Durable Telegram media parity for background missions.
     * Purpose: Preserve the authenticated media-group order as owner-scoped upload references.
     * These private request fields are projected only into GlassHive's trusted file envelope.
     * === VIVENTIUM END === */
    if (uploadedFiles.length > 0) {
      req._viventiumMissionAttachments = uploadedFiles.map(
        ({ viventium_media_group_kind: _kind, ...file }) => ({ ...file }),
      );
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Surface hint for Telegram-specific formatting.
     * === VIVENTIUM NOTE === */
    if (!req.body.viventiumSurface) {
      req.body.viventiumSurface = 'telegram';
    }
    /* === VIVENTIUM NOTE ===
     * Feature: Flag for Telegram-specific logging in AgentController.
     * Added: 2026-02-01
     * === VIVENTIUM NOTE === */
    req._viventiumTelegram = true;

    logger.info(
      '[VIVENTIUM][telegram/chat] Request: conversationId=%s parentMessageId=%s agentId=%s streamId=%s chatId=%s userId=%s messageId=%s updateId=%s',
      conversationId,
      parentMessageId,
      agentId,
      streamId,
      telegramChatId,
      telegramUserId,
      telegramMessageId || 'na',
      telegramUpdateId || 'na',
    );
    logTelegramTiming(traceId, 'payload_ready', requestStartTs, `streamId=${streamId}`);

    _res.on('finish', () => {
      logTelegramTiming(traceId, 'request_complete', requestStartTs, `status=${_res.statusCode}`);
    });

    next();
  },
  validateConvoAccess,
  buildEndpointOption,
  async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const withLogicalTurn = attachLogicalTurnMetadata(payload, getTrustedInteractionContext(req));
      if (
        withLogicalTurn &&
        typeof withLogicalTurn === 'object' &&
        req.viventiumTelegramVoiceRoute &&
        !Object.prototype.hasOwnProperty.call(withLogicalTurn, 'voiceRoute')
      ) {
        return originalJson({
          ...withLogicalTurn,
          voiceRoute: req.viventiumTelegramVoiceRoute,
        });
      }
      return originalJson(withLogicalTurn);
    };
    const controllerStartTs = performance.now();
    const result = await AgentController(req, res, next, initializeClient, addTitle);
    const traceId = typeof req.body?.traceId === 'string' ? req.body.traceId : '';
    logTelegramTiming(traceId, 'agent_controller', controllerStartTs);
    return result;
  },
);

/* === VIVENTIUM NOTE ===
 * Feature: Telegram voice preference sync endpoint for scheduler parity.
 * Contract:
 * - POST /api/viventium/telegram/preferences
 *   body: { telegramUserId, alwaysVoiceResponse, voiceResponsesEnabled }
 * === VIVENTIUM NOTE === */
router.post('/preferences', telegramAuth, async (req, res) => {
  const body = req.body ?? {};
  const identity = extractTelegramIdentity(req);
  const telegramUserId = identity.telegramUserId;
  if (!telegramUserId) {
    return res.status(400).json({ error: 'telegramUserId is required' });
  }

  const alwaysVoiceResponse = parseOptionalBoolean(
    body.alwaysVoiceResponse ?? body.always_voice_response,
    null,
  );
  const voiceResponsesEnabled = parseOptionalBoolean(
    body.voiceResponsesEnabled ?? body.voice_responses_enabled,
    null,
  );

  if (alwaysVoiceResponse == null && voiceResponsesEnabled == null) {
    return res
      .status(400)
      .json({ error: 'alwaysVoiceResponse or voiceResponsesEnabled is required' });
  }

  try {
    await touchTelegramMapping({
      telegramUserId,
      telegramUsername: identity.telegramUsername,
      alwaysVoiceResponse,
      voiceResponsesEnabled,
    });
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/preferences] Failed to persist voice preferences:', err);
    return res.status(500).json({ error: 'Failed to update voice preferences' });
  }

  return res.json({
    updated: true,
    voice_preferences: {
      always_voice_response: alwaysVoiceResponse,
      voice_responses_enabled: voiceResponsesEnabled,
    },
  });
});

/* === VIVENTIUM START ===
 * Feature: Telegram Parallel work account and Active work controls.
 * Purpose: Use the same linked account preference and exact-work plane as Web/Main, without a
 * model call or Telegram-owned mission registry.
 * === VIVENTIUM END === */
const PARALLEL_WORK_ACTIONS = new Set([
  'queue',
  'message',
  'steer',
  'pause',
  'resume',
  'stop',
  'retry',
  'dismiss',
]);
const PARALLEL_WORK_INSTRUCTION_ACTIONS = new Set(['queue', 'message', 'steer']);
const WORK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const {
  effectiveOrchestrationMode,
  parallelWorkAvailable,
} = require('~/server/services/viventium/ViventiumOrchestrationMode');
const {
  observeOrchestrationOwner,
  refreshOrchestrationReadiness,
} = require('~/server/services/viventium/GlassHiveOrchestrationReadinessService');

function telegramOrchestrationResponse(user) {
  const available = parallelWorkAvailable();
  return {
    available,
    mode: effectiveOrchestrationMode(user, { available }),
    hasKnownWork: user?.personalization?.parallel_work_known === true,
  };
}

function setTelegramOrchestrationNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
}

router.get('/orchestration', telegramAuth, async (req, res) => {
  setTelegramOrchestrationNoStore(res);
  observeOrchestrationOwner(String(req.user.id));
  return res.json(telegramOrchestrationResponse(req.user));
});

router.patch('/orchestration', telegramAuth, async (req, res) => {
  setTelegramOrchestrationNoStore(res);
  const ownerId = String(req.user.id);
  observeOrchestrationOwner(ownerId);
  const mode = String(req.body?.mode || '').trim();
  if (!['focused', 'parallel'].includes(mode)) {
    return res.status(400).json({
      error: 'Mode must be focused or parallel.',
      code: 'INVALID_ORCHESTRATION_PREFERENCE',
    });
  }
  if (mode === 'parallel' && !parallelWorkAvailable()) {
    await refreshOrchestrationReadiness({ ownerId });
  }
  if (mode === 'parallel' && !parallelWorkAvailable()) {
    return res.status(409).json({
      error: 'Parallel work is not available in this runtime yet.',
      code: 'PARALLEL_WORK_UNAVAILABLE',
    });
  }
  try {
    const user = await updateUserViventiumOrchestrationPreferences(ownerId, { mode });
    if (!user) {
      return res.status(404).json({ error: 'Account not found.', code: 'ACCOUNT_NOT_FOUND' });
    }
    return res.json(telegramOrchestrationResponse(user));
  } catch (error) {
    logger.error('[VIVENTIUM][telegram/orchestration] Preference update failed', {
      errorClass: String(error?.message || 'orchestration_update_failed').slice(0, 120),
    });
    return res.status(500).json({
      error: 'Unable to update Parallel work.',
      code: 'ORCHESTRATION_UPDATE_FAILED',
    });
  }
});

router.get('/orchestration/work', telegramAuth, async (req, res) => {
  setTelegramOrchestrationNoStore(res);
  const cursor = String(req.query?.cursor || '').trim();
  const limit = Number(req.query?.limit || 50);
  if (
    (cursor && (cursor.length > 2048 || !/^[A-Za-z0-9._~:@+-]+$/.test(cursor))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return res.status(400).json({
      error: 'The Active work page is invalid.',
      code: 'INVALID_ACTIVE_WORK_CURSOR',
    });
  }
  try {
    return res.json(
      cursor
        ? await getActiveWorkPage({ ownerId: String(req.user.id), cursor, limit })
        : await getActiveWorkInteractiveSnapshot({ ownerId: String(req.user.id) }),
    );
  } catch (error) {
    logger.error('[VIVENTIUM][telegram/orchestration] Active work read failed', {
      errorClass: String(error?.message || 'active_work_read_failed').slice(0, 120),
    });
    return res.status(500).json({
      error: 'Unable to read Active work.',
      code: 'ACTIVE_WORK_READ_FAILED',
    });
  }
});

router.post('/orchestration/work/:workRef/actions', telegramAuth, async (req, res) => {
  setTelegramOrchestrationNoStore(res);
  const workRef = String(req.params?.workRef || '').trim();
  const action = String(req.body?.action || '').trim();
  const instruction = String(req.body?.instruction || '').trim();
  const operationId = String(req.body?.operationId || '').trim();
  if (
    !WORK_REF_PATTERN.test(workRef) ||
    !PARALLEL_WORK_ACTIONS.has(action) ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    (PARALLEL_WORK_INSTRUCTION_ACTIONS.has(action) && !instruction) ||
    instruction.length > 8000
  ) {
    return res.status(400).json({
      error: 'The Active work action is invalid.',
      code: 'INVALID_WORK_ACTION',
    });
  }

  const ownerId = String(req.user.id);
  try {
    const result = await executeGlassHiveWorkAction({
      ownerId,
      workRef,
      action,
      instruction,
      operationId,
    });
    return res.status(202).json(result);
  } catch (error) {
    const status = Number(error?.status);
    logger.warn('[VIVENTIUM][telegram/orchestration] Active work action rejected', {
      action,
      status: Number.isInteger(status) ? status : 502,
      errorClass: String(error?.message || 'active_work_action_failed').slice(0, 120),
    });
    return res
      .status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502)
      .json({
        error: error?.userMessage || 'Unable to apply the Active work action.',
        code: error?.message || 'ACTIVE_WORK_ACTION_FAILED',
      });
  }
});

router.get('/stream/:streamId', telegramAuth, async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';
  /* === VIVENTIUM NOTE ===
   * Feature: Telegram stream timing (microstep profiling).
   * Purpose: Measure SSE open -> first event -> done latencies.
   * === VIVENTIUM NOTE === */
  const traceId = typeof req.query?.traceId === 'string' ? req.query.traceId : '';
  const streamStartTs = performance.now();
  let firstEventLogged = false;
  logTelegramTiming(traceId, 'stream_open', streamStartTs, `streamId=${streamId}`);
  const userId = req.user?.id;
  const lingerMs = resolveLingerMs(req);
  let lingerTimer = null;

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (!userId || job.metadata?.userId !== userId) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }
  const withStreamLogicalTurn = (event) =>
    attachLogicalTurnMetadata(event, job.metadata?.interactionContext);

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  logger.debug(`[TelegramStream] Client subscribed to ${streamId}, resume: ${isResume}`);
  traceTelegram(
    '[VIVENTIUM][telegram/stream] Open streamId=%s resume=%s lingerMs=%s',
    streamId,
    isResume,
    lingerMs,
  );

  const endStream = () => {
    if (!res.writableEnded) {
      res.end();
    }
  };

  const scheduleEnd = () => {
    if (lingerMs <= 0) {
      endStream();
      return;
    }
    if (lingerTimer) {
      return;
    }
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      endStream();
    }, lingerMs);
  };

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded) {
      res.write(
        `event: message\ndata: ${JSON.stringify(withStreamLogicalTurn({ sync: true, resumeState }))}\n\n`,
      );
      if (typeof res.flush === 'function') {
        res.flush();
      }
      logger.debug(
        `[TelegramStream] Sent sync event for ${streamId} with ${resumeState.runSteps.length} run steps`,
      );
      traceTelegram(
        '[VIVENTIUM][telegram/stream] Resume sync streamId=%s runSteps=%s',
        streamId,
        resumeState.runSteps.length,
      );
    }
  }

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      if (TELEGRAM_TRACE_ENABLED && event && typeof event === 'object') {
        const eventName = event.event;
        const status = event?.data?.status;
        if (eventName === 'on_cortex_update' || eventName === 'on_cortex_followup') {
          traceTelegram(
            '[VIVENTIUM][telegram/stream] Event streamId=%s event=%s status=%s',
            streamId,
            eventName,
            status,
          );
        }
      }
      if (!res.writableEnded) {
        if (!firstEventLogged) {
          logTelegramTiming(traceId, 'stream_first_event', streamStartTs);
          firstEventLogged = true;
        }
        res.write(`event: message\ndata: ${JSON.stringify(withStreamLogicalTurn(event))}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      }
    },
    (event) => {
      if (TELEGRAM_TRACE_ENABLED && event && typeof event === 'object') {
        const eventName = event.event;
        if (event?.final || eventName === 'on_cortex_followup') {
          traceTelegram(
            '[VIVENTIUM][telegram/stream] Done streamId=%s event=%s final=%s',
            streamId,
            eventName,
            Boolean(event?.final),
          );
        }
      }
      if (!res.writableEnded) {
        res.write(`event: message\ndata: ${JSON.stringify(withStreamLogicalTurn(event))}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
        logTelegramTiming(traceId, 'stream_done', streamStartTs);
        scheduleEnd();
      }
    },
    (error) => {
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
        endStream();
      }
    },
  );

  if (!result) {
    return res.status(404).json({ error: 'Failed to subscribe to stream' });
  }

  req.on('close', () => {
    logger.debug(`[TelegramStream] Client disconnected from ${streamId}`);
    logTelegramTiming(traceId, 'stream_closed', streamStartTs);
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    result.unsubscribe();
  });
});

/* === VIVENTIUM NOTE ===
 * Feature: Telegram follow-up polling endpoint
 *
 * Contract:
 * - GET /api/viventium/telegram/cortex/:messageId
 *   -> { messageId, conversationId, cortexParts: [...], followUp?: { messageId, text } }
 *
 * Notes:
 * - Authenticated via telegramAuth (shared secret).
 * - Optionally validates conversationId query against the message.
 * === VIVENTIUM NOTE === */
router.get('/cortex/:messageId', telegramAuth, async (req, res) => {
  const userId = req.user?.id;
  const messageId = req.params?.messageId;
  const conversationId =
    typeof req.query?.conversationId === 'string' ? req.query.conversationId : '';
  const scheduleId = typeof req.query?.scheduleId === 'string' ? req.query.scheduleId : '';

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
      scheduleId,
    });
    if (!state) {
      return res.status(404).json({ error: 'Message not found' });
    }

    return res.json(state);
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/cortex] Failed to load cortex data:', err);
    return res.status(500).json({ error: 'Failed to load cortex data' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Telegram delivery for GlassHive worker completion
 * Purpose:
 * - Telegram already polls persisted same-conversation follow-ups.
 * - GlassHive worker callbacks are their own persisted callback messages, so expose the
 *   same DB truth without inventing a second upload/result path.
 * === VIVENTIUM END === */
router.get('/glasshive/:messageId', telegramAuth, async (req, res) => {
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
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  try {
    const state = await getGlassHiveCallbackStateForMessage({
      userId,
      messageId,
      conversationId,
    });
    return res.json(
      state ?? {
        messageId,
        conversationId,
        latest: null,
        callbacks: [],
      },
    );
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/glasshive] Failed to load GlassHive callback:', err);
    return res.status(500).json({ error: 'Failed to load GlassHive callback' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Durable Telegram dispatch for GlassHive callbacks.
 * Purpose:
 * - Let the Telegram bridge claim and send callbacks that arrive after the
 *   original per-turn poller has ended or after a bridge restart.
 * - Keep claim/sent/failed state in Mongo for observability and duplicate suppression.
 * Added: 2026-05-06
 * === VIVENTIUM END === */
router.post('/glasshive/deliveries/claim', telegramBridgeAuth, async (req, res) => {
  try {
    const deliveries = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'telegram',
      limit: req.body?.limit,
      leaseMs: req.body?.leaseMs,
      claimOwner: req.body?.dispatcherId || 'telegram-bridge',
      callbackId: req.body?.callbackId || '',
    });
    return res.json({ deliveries });
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/glasshive-delivery] Claim failed:', err);
    return res.status(500).json({ error: 'Failed to claim GlassHive deliveries' });
  }
});

router.post('/glasshive/deliveries/:deliveryId/status', telegramBridgeAuth, async (req, res) => {
  const deliveryId = String(req.params?.deliveryId || '').trim();
  const claimId = String(req.body?.claimId || '').trim();
  const status = String(req.body?.status || '').trim();
  if (!deliveryId || !claimId) {
    return res.status(400).json({ error: 'deliveryId and claimId are required' });
  }
  try {
    let delivery = null;
    if (status === 'sent') {
      delivery = await markGlassHiveCallbackDeliverySent({ deliveryId, claimId });
    } else if (status === 'failed') {
      delivery = await markGlassHiveCallbackDeliveryFailed({
        deliveryId,
        claimId,
        error: req.body?.error || '',
      });
    } else if (status === 'suppressed') {
      delivery = await markGlassHiveCallbackDeliverySuppressed({
        deliveryId,
        claimId,
        reason: req.body?.reason || '',
      });
    } else {
      return res.status(400).json({ error: 'Unsupported delivery status' });
    }
    if (!delivery) {
      return res.status(409).json({ error: 'delivery_not_claimed' });
    }
    return res.json({ delivery });
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/glasshive-delivery] Status update failed:', err);
    return res.status(500).json({ error: 'Failed to update GlassHive delivery' });
  }
});

router.post('/glasshive/deliveries/backlog', telegramBridgeAuth, async (req, res) => {
  try {
    const summary = await deliveryBacklogSummary({
      surface: 'telegram',
      olderThanMs: Number.parseInt(String(req.body?.olderThanMs || ''), 10) || undefined,
    });
    return res.json(summary);
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/glasshive-delivery] Backlog summary failed:', err);
    return res.status(500).json({ error: 'Failed to load GlassHive delivery backlog' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Telegram attachment download endpoints (no user JWT/cookies)
 *
 * Why:
 * - Tool outputs (e.g., NanoBanana / `gemini_image_gen`) + code interpreter artifacts are persisted
 *   as message `attachments` and streamed as `{ event: "attachment", data: ... }`.
 * - Telegram bot does not have LibreChat cookies/JWT, so it cannot fetch `/images/...` when
 *   `secureImageLinks` is enabled, and cannot call JWT-protected `/files/...` routes.
 *
 * Contract:
 * - GET /api/viventium/telegram/files/download/:file_id
 *   -> streams the file bytes for `file_id` if the Telegram user is linked and has access.
 * - GET /api/viventium/telegram/files/code/download/:session_id/:fileId
 *   -> streams code env file bytes (fallback path when a code artifact isn't persisted as a DB file).
 *
 * Added: 2026-02-10
 * === VIVENTIUM END === */
router.get(
  '/files/download/:file_id',
  telegramAuth,
  configMiddleware,
  fileAccess,
  async (req, res) => {
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
          '[VIVENTIUM][telegram/files/download] No getDownloadStream for source=%s file_id=%s',
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
        logger.error('[VIVENTIUM][telegram/files/download] Stream error:', streamError);
      });
      fileStream.pipe(res);
    } catch (error) {
      logger.error('[VIVENTIUM][telegram/files/download] Error downloading file:', error);
      res.status(500).send('Error downloading file');
    }
  },
);

function isValidCodeFileId(str) {
  return /^[A-Za-z0-9_-]{21}$/.test(str);
}

router.get(
  '/files/code/download/:session_id/:fileId',
  telegramAuth,
  configMiddleware,
  async (req, res) => {
    try {
      const { session_id, fileId } = req.params;
      const logPrefix = `[VIVENTIUM][telegram/files/code/download] session=${session_id} file=${fileId}`;
      logger.debug(logPrefix);

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

      const result = await loadAuthValues({
        userId: req.user.id,
        authFields: [EnvVar.CODE_API_KEY],
      });
      const response = await getDownloadStream(
        `${session_id}/${fileId}`,
        result[EnvVar.CODE_API_KEY],
      );
      res.set(response.headers);
      response.data.pipe(res);
    } catch (error) {
      logger.error('[VIVENTIUM][telegram/files/code/download] Error downloading file:', error);
      res.status(500).send('Error downloading file');
    }
  },
);

module.exports = router;

/* === VIVENTIUM NOTE === */
