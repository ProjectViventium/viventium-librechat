/* === VIVENTIUM START ===
 * Feature: Deep timing instrumentation (toggleable, surface-neutral)
 * Purpose: Provide microstep timing across LC internals without always-on overhead.
 *   Works for any surface (web chat, voice, Telegram) so latency sub-steps stay observable
 *   at parity instead of being visible only on the Telegram path.
 * Toggle via env:
 *   - VIVENTIUM_TIMING_DEEP=true           enables deep marks for ALL surfaces
 *   - VIVENTIUM_TELEGRAM_TIMING_DEEP=true   legacy Telegram-only gate (kept for back-compat)
 * === VIVENTIUM END === */

const { performance } = require('perf_hooks');
const { logger } = require('@librechat/data-schemas');

const parseBoolEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const isDeepTimingEnabled = (req) => {
  // Surface-neutral global switch: deep marks fire for web chat, voice, and Telegram alike.
  if (parseBoolEnv('VIVENTIUM_TIMING_DEEP', false)) {
    return true;
  }
  // Legacy Telegram-only gate, preserved for back-compat.
  return !!req?._viventiumTelegram && parseBoolEnv('VIVENTIUM_TELEGRAM_TIMING_DEEP', false);
};

const setTimingBase = (req, baseTs) => {
  if (!req) return;
  req._viventiumTimingBase = baseTs;
};

const getTimingBase = (req) => {
  if (!req) return null;
  if (!req._viventiumTimingBase) {
    req._viventiumTimingBase = performance.now();
  }
  return req._viventiumTimingBase;
};

const startDeepTiming = (req) => {
  if (!isDeepTimingEnabled(req)) return null;
  return performance.now();
};

const formatMs = (value) => (Number.isFinite(value) ? value.toFixed(1) : 'na');

const logDeepTiming = (req, step, startTs = null, extra = '') => {
  if (!isDeepTimingEnabled(req)) return;
  const traceId = typeof req?.body?.traceId === 'string' ? req.body.traceId : 'na';
  const base = getTimingBase(req);
  const now = performance.now();
  const t = base != null ? now - base : null;
  const ms = startTs != null ? now - startTs : t;
  const suffix = extra ? ` ${extra}` : '';
  logger.info(
    `[TG_TIMING][lc][deep] trace=${traceId} step=${step} ms=${formatMs(ms)} t=${formatMs(t)}${suffix}`,
  );
};

module.exports = {
  isDeepTimingEnabled,
  setTimingBase,
  startDeepTiming,
  logDeepTiming,
};
