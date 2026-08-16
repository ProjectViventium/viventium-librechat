/**
 * VIVENTIUM START
 * Feature: Privacy-safe saved-memory read/writer health receipts.
 * Purpose: Let the joined cognitive-integrity gate distinguish a healthy, unavailable, and
 * unobserved per-turn memory path without scraping logs or persisting user content/identifiers.
 * VIVENTIUM END
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEALTH_DIR_NAME = 'memory-continuity-health';
const ALLOWED_PATHS = new Set(['read', 'writer']);
const ALLOWED_STATUSES = new Set(['ok', 'degraded']);

function memoryContinuityUserHash(userId) {
  return crypto
    .createHash('sha256')
    .update(String(userId ?? ''))
    .digest('hex')
    .slice(0, 24);
}

function safeLabel(value, fallback = 'unknown') {
  const label = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .slice(0, 128);
  return label || fallback;
}

async function recordMemoryContinuityHealth({
  userId,
  path: continuityPath,
  status,
  reason,
  provider,
  model,
  effort,
} = {}) {
  const appSupportDir = String(process.env.VIVENTIUM_APP_SUPPORT_DIR || '').trim();
  if (!appSupportDir || !userId || !ALLOWED_PATHS.has(continuityPath)) {
    return null;
  }
  if (!ALLOWED_STATUSES.has(status)) {
    return null;
  }

  const userHash = memoryContinuityUserHash(userId);
  const directory = path.join(appSupportDir, 'state', HEALTH_DIR_NAME);
  const destination = path.join(directory, `${userHash}.${continuityPath}.json`);
  const temporary = path.join(
    directory,
    `.${userHash}.${continuityPath}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const receipt = {
    schemaVersion: 2,
    userHash,
    path: continuityPath,
    status,
    reason: safeLabel(reason, status === 'ok' ? 'healthy' : 'unavailable'),
    ...(provider ? { provider: safeLabel(provider) } : {}),
    ...(model ? { model: safeLabel(model) } : {}),
    ...(effort ? { effort: safeLabel(effort) } : {}),
    updatedAt: new Date().toISOString(),
  };

  try {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.promises.rename(temporary, destination);
    await fs.promises.chmod(destination, 0o600);
    return receipt;
  } catch {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    return null;
  }
}

module.exports = {
  memoryContinuityUserHash,
  recordMemoryContinuityHealth,
};
