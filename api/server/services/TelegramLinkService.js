/* === VIVENTIUM START ===
 * Feature: Telegram account linking helpers
 * Purpose: Centralize link token generation, hashing, and mapping utilities.
 * === VIVENTIUM END === */
const crypto = require('crypto');
const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { isEnabled } = require('@librechat/api');
const { TelegramLinkToken, TelegramUserMapping } = require('~/db/models');

const OBJECT_ID_LENGTH = 24;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function normalizeTelegramId(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function coerceBoolean(value, defaultValue) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value == null) {
    return defaultValue;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
    return defaultValue;
  }
  return Boolean(value);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getLinkTtlMinutes() {
  return parseIntEnv('VIVENTIUM_TELEGRAM_LINK_TTL_MINUTES', 15);
}

function getLinkBaseUrl(req) {
  const configured =
    (process.env.VIVENTIUM_TELEGRAM_LINK_BASE_URL || '').trim() ||
    (process.env.DOMAIN_SERVER || '').trim() ||
    (process.env.DOMAIN_CLIENT || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  const host = req?.get?.('host') || '';
  if (!host) {
    return '';
  }
  const protocol = req?.protocol || 'http';
  return `${protocol}://${host}`;
}

async function createLinkToken({ telegramUserId, telegramUsername }) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const ttlMinutes = getLinkTtlMinutes();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await TelegramLinkToken.create({
    tokenHash,
    telegramUserId,
    telegramUsername: telegramUsername || '',
    expiresAt,
  });
  return { token, expiresAt };
}

function buildLinkUrl(req, token) {
  const baseUrl = getLinkBaseUrl(req);
  if (!baseUrl) {
    return '';
  }
  return `${baseUrl}/api/viventium/telegram/link/${token}`;
}

async function resolveTelegramMapping({ telegramUserId }) {
  if (!telegramUserId) {
    return null;
  }
  return TelegramUserMapping.findOne({ telegramUserId }).lean();
}

/* === VIVENTIUM NOTE ===
 * Feature: Scheduler-safe lookup for Telegram mapping by LibreChat user id.
 * Purpose: Allow internal services (scheduler) to resolve Telegram identity without user JWTs.
 * === VIVENTIUM NOTE === */
async function resolveTelegramMappingByUserId({ libreChatUserId }) {
  if (!libreChatUserId) {
    return null;
  }
  return TelegramUserMapping.findOne({ libreChatUserId }).lean();
}

async function touchTelegramMapping({
  telegramUserId,
  telegramUsername,
  alwaysVoiceResponse,
  voiceResponsesEnabled,
}) {
  if (!telegramUserId) {
    return;
  }
  const update = {
    lastSeenAt: new Date(),
  };
  if (telegramUsername) {
    update.telegramUsername = telegramUsername;
  }
  const hasAlwaysVoice = alwaysVoiceResponse != null;
  const hasVoiceEnabled = voiceResponsesEnabled != null;
  if (hasAlwaysVoice) {
    update.alwaysVoiceResponse = coerceBoolean(alwaysVoiceResponse, false);
  }
  if (hasVoiceEnabled) {
    update.voiceResponsesEnabled = coerceBoolean(voiceResponsesEnabled, true);
  }
  if (hasAlwaysVoice || hasVoiceEnabled) {
    update.voicePrefsUpdatedAt = new Date();
  }
  await TelegramUserMapping.updateOne({ telegramUserId }, { $set: update }).catch((err) => {
    logger.warn('[VIVENTIUM][telegram] Failed to update Telegram mapping metadata', err);
  });
}

async function upsertTelegramMapping({ telegramUserId, libreChatUserId, telegramUsername }) {
  const update = {
    libreChatUserId,
    lastSeenAt: new Date(),
    linkedAt: new Date(),
  };
  if (telegramUsername) {
    update.telegramUsername = telegramUsername;
  }
  return TelegramUserMapping.findOneAndUpdate(
    { telegramUserId },
    { $set: update },
    { new: true, upsert: true },
  );
}

function isValidObjectId(id) {
  if (typeof id !== 'string') {
    return false;
  }
  if (id.length !== OBJECT_ID_LENGTH) {
    return false;
  }
  return OBJECT_ID_PATTERN.test(id);
}

function validateRefreshToken(refreshToken) {
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (!isValidObjectId(payload.id)) {
      return { valid: false, error: 'Invalid User ID' };
    }
    const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp < currentTimeInSeconds) {
      return { valid: false, error: 'Refresh token expired' };
    }
    return { valid: true, userId: payload.id };
  } catch (err) {
    logger.warn('[VIVENTIUM][telegram-link] Invalid refresh token', err);
    return { valid: false, error: 'Invalid token' };
  }
}

function resolveUserIdFromCookies(req) {
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) {
    return '';
  }
  const parsedCookies = cookies.parse(cookieHeader);
  const tokenProvider = parsedCookies.token_provider;
  if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    const openidUserId = parsedCookies.openid_user_id;
    if (!openidUserId) {
      return '';
    }
    const validation = validateRefreshToken(openidUserId);
    return validation.valid ? validation.userId : '';
  }
  const refreshToken = parsedCookies.refreshToken;
  if (!refreshToken) {
    return '';
  }
  const validation = validateRefreshToken(refreshToken);
  return validation.valid ? validation.userId : '';
}

async function consumeLinkToken(token) {
  const tokenHash = hashToken(token);
  const now = new Date();
  return TelegramLinkToken.findOneAndUpdate(
    {
      tokenHash,
      consumedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now } },
    { new: true },
  );
}

module.exports = {
  normalizeTelegramId,
  createLinkToken,
  buildLinkUrl,
  resolveTelegramMapping,
  resolveTelegramMappingByUserId,
  touchTelegramMapping,
  upsertTelegramMapping,
  resolveUserIdFromCookies,
  consumeLinkToken,
};
