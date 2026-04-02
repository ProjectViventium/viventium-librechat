const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');
const denyRequest = require('~/server/middleware/denyRequest');
const { logViolation } = require('~/cache');

/* VIVENTIUM START
 * Purpose: Harden rate limiter env parsing to avoid NaN init failures.
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-message-limiters
 */
/**
 * Env parsing helpers.
 *
 * Note: `process.env` values are always strings. If a variable is set to a non-numeric
 * value (e.g. "1m"), JS math produces NaN and express-rate-limit throws during init.
 */
function parsePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ipWindowMinutes = parsePositiveNumber(process.env.MESSAGE_IP_WINDOW, 1);
const ipWindowMs = Math.max(1, Math.trunc(ipWindowMinutes * 60 * 1000));
const ipMax = parsePositiveInt(process.env.MESSAGE_IP_MAX, 40);
const ipWindowInMinutes = ipWindowMs / 60000;

const userWindowMinutes = parsePositiveNumber(process.env.MESSAGE_USER_WINDOW, 1);
const userWindowMs = Math.max(1, Math.trunc(userWindowMinutes * 60 * 1000));
const userMax = parsePositiveInt(process.env.MESSAGE_USER_MAX, 40);
const userWindowInMinutes = userWindowMs / 60000;
const score = process.env.MESSAGE_VIOLATION_SCORE;
/* VIVENTIUM END */

/**
 * Creates either an IP/User message request rate limiter for excessive requests
 * that properly logs and denies the violation.
 *
 * @param {boolean} [ip=true] - Whether to create an IP limiter or a user limiter.
 * @returns {function} A rate limiter function.
 *
 */
const createHandler = (ip = true) => {
  return async (req, res) => {
    const type = ViolationTypes.MESSAGE_LIMIT;
    const errorMessage = {
      type,
      max: ip ? ipMax : userMax,
      limiter: ip ? 'ip' : 'user',
      windowInMinutes: ip ? ipWindowInMinutes : userWindowInMinutes,
    };

    await logViolation(req, res, type, errorMessage, score);
    return await denyRequest(req, res, errorMessage);
  };
};

/**
 * Message request rate limiters
 */
const ipLimiterOptions = {
  windowMs: ipWindowMs,
  max: ipMax,
  handler: createHandler(),
  store: limiterCache('message_ip_limiter'),
};

const userLimiterOptions = {
  windowMs: userWindowMs,
  max: userMax,
  handler: createHandler(false),
  keyGenerator: function (req) {
    return req.user?.id; // Use the user ID or NULL if not available
  },
  store: limiterCache('message_user_limiter'),
};

/**
 * Message request rate limiter by IP
 */
const messageIpLimiter = rateLimit(ipLimiterOptions);

/**
 * Message request rate limiter by userId
 */
const messageUserLimiter = rateLimit(userLimiterOptions);

module.exports = {
  messageIpLimiter,
  messageUserLimiter,
};
