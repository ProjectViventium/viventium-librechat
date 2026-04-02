/* === VIVENTIUM START ===
 * Feature: Gateway ingress request authentication + signature verification
 * Purpose: Enforce shared-secret + HMAC signed gateway calls with replay protection.
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const crypto = require('crypto');

const GATEWAY_SECRET_HEADER = 'x-viventium-gateway-secret';
const GATEWAY_SIGNATURE_HEADER = 'x-viventium-gateway-signature';
const GATEWAY_TIMESTAMP_HEADER = 'x-viventium-gateway-timestamp';
const GATEWAY_NONCE_HEADER = 'x-viventium-gateway-nonce';

const DEFAULT_TIMESTAMP_WINDOW_SECONDS = 300;
const DEFAULT_NONCE_TTL_SECONDS = 600;

const nonceCache = new Map();

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

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getGatewaySecret() {
  return (
    (process.env.VIVENTIUM_GATEWAY_SECRET || '').trim() ||
    (process.env.VIVENTIUM_TELEGRAM_SECRET || '').trim()
  );
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function computeGatewaySignature({ secret, timestamp, nonce, method, path, bodyHash }) {
  const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('.');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function cleanupNonceCache(nowMs) {
  for (const [key, expiresAt] of nonceCache.entries()) {
    if (expiresAt <= nowMs) {
      nonceCache.delete(key);
    }
  }
}

function resolveRequestPath(req) {
  const original = req?.originalUrl;
  if (typeof original === 'string' && original.length > 0) {
    return original.split('?')[0] || '/';
  }
  const baseUrl = typeof req?.baseUrl === 'string' ? req.baseUrl : '';
  const reqPath = typeof req?.path === 'string' ? req.path : '';
  const full = `${baseUrl}${reqPath}`;
  return full || '/';
}

function resolveBodyHash(req) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  return sha256Hex(JSON.stringify(body));
}

function verifyGatewayRequestSignature(req, { secret, requireSignature = true } = {}) {
  if (!requireSignature) {
    return { ok: true };
  }

  const signature = (req.get(GATEWAY_SIGNATURE_HEADER) || '').trim();
  const timestamp = (req.get(GATEWAY_TIMESTAMP_HEADER) || '').trim();
  const nonce = (req.get(GATEWAY_NONCE_HEADER) || '').trim();

  if (!signature || !timestamp || !nonce) {
    return { ok: false, error: 'Missing gateway signature headers' };
  }

  if (!secret) {
    return { ok: false, error: 'Gateway secret is not configured' };
  }

  const timestampValue = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampValue)) {
    return { ok: false, error: 'Invalid gateway timestamp' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const allowedSkew = parseIntEnv(
    'VIVENTIUM_GATEWAY_SIGNATURE_WINDOW_SECONDS',
    DEFAULT_TIMESTAMP_WINDOW_SECONDS,
  );
  if (Math.abs(nowSeconds - timestampValue) > allowedSkew) {
    return { ok: false, error: 'Gateway signature timestamp expired' };
  }

  const nowMs = Date.now();
  cleanupNonceCache(nowMs);
  const nonceKey = `${timestamp}:${nonce}`;
  if (nonceCache.has(nonceKey)) {
    return { ok: false, error: 'Gateway nonce replay detected' };
  }

  const method = (req.method || 'GET').toUpperCase();
  const path = resolveRequestPath(req);
  const bodyHash = resolveBodyHash(req);
  const expected = computeGatewaySignature({
    secret,
    timestamp,
    nonce,
    method,
    path,
    bodyHash,
  });

  if (!timingSafeEqualHex(signature, expected)) {
    return { ok: false, error: 'Invalid gateway signature' };
  }

  const nonceTtlSeconds = parseIntEnv('VIVENTIUM_GATEWAY_NONCE_TTL_SECONDS', DEFAULT_NONCE_TTL_SECONDS);
  nonceCache.set(nonceKey, nowMs + nonceTtlSeconds * 1000);

  return { ok: true };
}

module.exports = {
  GATEWAY_SECRET_HEADER,
  GATEWAY_SIGNATURE_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  GATEWAY_NONCE_HEADER,
  parseBoolEnv,
  parseIntEnv,
  getGatewaySecret,
  sha256Hex,
  computeGatewaySignature,
  verifyGatewayRequestSignature,
  resolveRequestPath,
  resolveBodyHash,
};
