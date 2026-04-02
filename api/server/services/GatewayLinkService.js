/* === VIVENTIUM START ===
 * Feature: Generic gateway account linking helpers
 * Purpose: Centralize multi-channel link token generation, hashing, and mapping utilities.
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { GatewayLinkToken, GatewayUserMapping } = require('~/db/models');
const { resolveUserIdFromCookies } = require('~/server/services/TelegramLinkService');

function normalizeGatewayId(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function normalizeGatewayChannelId(value) {
  return normalizeGatewayId(value).toLowerCase();
}

function normalizeGatewayAccountId(value) {
  const normalized = normalizeGatewayId(value);
  return normalized || 'default';
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
  return parseIntEnv('VIVENTIUM_GATEWAY_LINK_TTL_MINUTES', 15);
}

function getLinkBaseUrl(req) {
  const configured =
    (process.env.VIVENTIUM_GATEWAY_LINK_BASE_URL || '').trim() ||
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

function normalizeGatewayIdentity(identity = {}) {
  const channel = normalizeGatewayChannelId(identity.channel);
  const accountId = normalizeGatewayAccountId(identity.accountId);
  const externalUserId = normalizeGatewayId(identity.externalUserId);
  const externalUsername = normalizeGatewayId(identity.externalUsername);

  return {
    channel,
    accountId,
    externalUserId,
    externalUsername,
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function createGatewayLinkToken({
  channel,
  accountId,
  externalUserId,
  externalUsername,
  metadata,
}) {
  const normalized = normalizeGatewayIdentity({ channel, accountId, externalUserId, externalUsername });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const ttlMinutes = getLinkTtlMinutes();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await GatewayLinkToken.create({
    tokenHash,
    channel: normalized.channel,
    accountId: normalized.accountId,
    externalUserId: normalized.externalUserId,
    externalUsername: normalized.externalUsername,
    metadata: normalizeMetadata(metadata),
    expiresAt,
  });
  return { token, expiresAt };
}

function buildGatewayLinkUrl(req, token) {
  const baseUrl = getLinkBaseUrl(req);
  if (!baseUrl) {
    return '';
  }
  return `${baseUrl}/api/viventium/gateway/link/${token}`;
}

async function resolveGatewayMapping({ channel, accountId, externalUserId }) {
  const normalized = normalizeGatewayIdentity({ channel, accountId, externalUserId });
  if (!normalized.channel || !normalized.externalUserId) {
    return null;
  }
  return GatewayUserMapping.findOne({
    channel: normalized.channel,
    accountId: normalized.accountId,
    externalUserId: normalized.externalUserId,
  }).lean();
}

async function resolveGatewayMappingByUserId({ libreChatUserId, channel, accountId }) {
  const normalizedChannel = normalizeGatewayChannelId(channel);
  const normalizedAccountId = normalizeGatewayAccountId(accountId);
  if (!libreChatUserId) {
    return null;
  }

  const query = { libreChatUserId };
  if (normalizedChannel) {
    query.channel = normalizedChannel;
  }
  if (normalizedChannel || accountId != null) {
    query.accountId = normalizedAccountId;
  }

  return GatewayUserMapping.findOne(query).lean();
}

async function touchGatewayMapping({ channel, accountId, externalUserId, externalUsername, metadata }) {
  const normalized = normalizeGatewayIdentity({ channel, accountId, externalUserId, externalUsername });
  if (!normalized.channel || !normalized.externalUserId) {
    return;
  }

  const update = {
    lastSeenAt: new Date(),
  };
  if (normalized.externalUsername) {
    update.externalUsername = normalized.externalUsername;
  }

  const safeMetadata = normalizeMetadata(metadata);
  if (Object.keys(safeMetadata).length > 0) {
    update.metadata = safeMetadata;
  }

  await GatewayUserMapping.updateOne(
    {
      channel: normalized.channel,
      accountId: normalized.accountId,
      externalUserId: normalized.externalUserId,
    },
    { $set: update },
  ).catch((err) => {
    logger.warn('[VIVENTIUM][gateway] Failed to update gateway mapping metadata', err);
  });
}

async function upsertGatewayMapping({
  channel,
  accountId,
  externalUserId,
  externalUsername,
  libreChatUserId,
  metadata,
}) {
  const normalized = normalizeGatewayIdentity({ channel, accountId, externalUserId, externalUsername });
  const update = {
    channel: normalized.channel,
    accountId: normalized.accountId,
    externalUserId: normalized.externalUserId,
    externalUsername: normalized.externalUsername,
    libreChatUserId,
    metadata: normalizeMetadata(metadata),
    linkedAt: new Date(),
    lastSeenAt: new Date(),
  };

  return GatewayUserMapping.findOneAndUpdate(
    {
      channel: normalized.channel,
      accountId: normalized.accountId,
      externalUserId: normalized.externalUserId,
    },
    { $set: update },
    { new: true, upsert: true },
  );
}

async function consumeGatewayLinkToken(token) {
  const tokenHash = hashToken(token);
  const now = new Date();
  return GatewayLinkToken.findOneAndUpdate(
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
  normalizeGatewayId,
  normalizeGatewayChannelId,
  normalizeGatewayAccountId,
  normalizeGatewayIdentity,
  createGatewayLinkToken,
  buildGatewayLinkUrl,
  resolveGatewayMapping,
  resolveGatewayMappingByUserId,
  touchGatewayMapping,
  upsertGatewayMapping,
  resolveUserIdFromCookies,
  consumeGatewayLinkToken,
};
