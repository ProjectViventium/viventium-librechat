/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Registration approval workflow (pending/approved/denied)
 *
 * Responsibilities:
 * - Provide shared approval-state helpers and auth gates
 * - Mark new users pending when approval mode is enabled
 * - Notify admin via Telegram with signed approve/deny links
 * - Validate and apply approval decisions from admin links
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const jwt = require('jsonwebtoken');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getUserById, updateUser } = require('~/models');
const { sendAdminMessage } = require('./telegramNotifier');

const APPROVAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
});

const PENDING_APPROVAL_MESSAGE =
  'Your account is pending approval. We will notify you once approved.';
const APPROVAL_ERROR_CODE = 'VIVENTIUM_APPROVAL_PENDING';

function isRegistrationApprovalEnabled() {
  return isEnabled(process.env.VIVENTIUM_REGISTRATION_APPROVAL);
}

function normalizeApprovalStatus(user) {
  const raw = user?.viventiumApprovalStatus;
  if (
    raw === APPROVAL_STATUSES.PENDING ||
    raw === APPROVAL_STATUSES.APPROVED ||
    raw === APPROVAL_STATUSES.DENIED
  ) {
    return raw;
  }
  return APPROVAL_STATUSES.APPROVED;
}

function isViventiumApproved(user) {
  if (!isRegistrationApprovalEnabled()) {
    return true;
  }
  return normalizeApprovalStatus(user) === APPROVAL_STATUSES.APPROVED;
}

function createPendingApprovalError() {
  const error = new Error(PENDING_APPROVAL_MESSAGE);
  error.code = APPROVAL_ERROR_CODE;
  error.status = 403;
  return error;
}

async function assertViventiumApproved(userOrId) {
  if (!isRegistrationApprovalEnabled()) {
    return null;
  }

  const user =
    typeof userOrId === 'string'
      ? await getUserById(userOrId, 'viventiumApprovalStatus email username name provider')
      : userOrId;

  if (!user || !isViventiumApproved(user)) {
    throw createPendingApprovalError();
  }

  return user;
}

async function markUserPendingApproval(userId) {
  if (!isRegistrationApprovalEnabled() || !userId) {
    return;
  }

  await updateUser(userId, {
    viventiumApprovalStatus: APPROVAL_STATUSES.PENDING,
    viventiumApprovalRequestedAt: new Date(),
    viventiumApprovalReviewedAt: null,
  });
}

function buildDecisionToken({ userId, action }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required for registration decision links');
  }

  return jwt.sign(
    {
      purpose: 'viventium_registration_decision',
      userId,
      action,
    },
    secret,
    { expiresIn: '7d' },
  );
}

function buildDecisionUrl({ userId, action }) {
  const baseUrl = (process.env.DOMAIN_SERVER || '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    logger.warn(
      '[VIVENTIUM][registrationApproval] DOMAIN_SERVER is not set — approval/deny links will be missing from Telegram notifications',
    );
    return '';
  }
  const token = buildDecisionToken({ userId, action });
  return `${baseUrl}/api/viventium/registration/decision?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}`;
}

async function notifyAdminRegistration({ userId, name, email, provider }) {
  if (!isRegistrationApprovalEnabled() || !userId) {
    return false;
  }

  let approveUrl = '';
  let denyUrl = '';
  try {
    approveUrl = buildDecisionUrl({ userId, action: 'approve' });
    denyUrl = buildDecisionUrl({ userId, action: 'deny' });
  } catch (error) {
    logger.warn('[VIVENTIUM][registrationApproval] Failed to build decision links', error);
  }

  const lines = [
    'New Viventium registration requires approval.',
    `Name: ${name || 'Unknown'}`,
    `Email: ${email || 'Unknown'}`,
    `Provider: ${provider || 'local'}`,
    `User ID: ${userId}`,
    `Requested At (UTC): ${new Date().toISOString()}`,
  ];

  const inlineKeyboard = [];
  if (approveUrl || denyUrl) {
    const row = [];
    if (approveUrl) {
      row.push({ text: 'Approve', url: approveUrl });
    }
    if (denyUrl) {
      row.push({ text: 'Deny', url: denyUrl });
    }
    if (row.length > 0) {
      inlineKeyboard.push(row);
    }
  }

  return sendAdminMessage({
    text: lines.join('\n'),
    inlineKeyboard,
  });
}

function verifyDecisionToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }

  const decoded = jwt.verify(token, secret);
  if (decoded?.purpose !== 'viventium_registration_decision') {
    throw new Error('Invalid decision token');
  }
  return decoded;
}

async function applyRegistrationDecision({ token, action }) {
  if (!isRegistrationApprovalEnabled()) {
    throw new Error('Registration approval workflow is disabled');
  }

  if (action !== 'approve' && action !== 'deny') {
    throw new Error('Invalid decision action');
  }

  const decoded = verifyDecisionToken(token);
  const userId = decoded?.userId;
  if (!userId) {
    throw new Error('Decision token missing userId');
  }

  const status = action === 'approve' ? APPROVAL_STATUSES.APPROVED : APPROVAL_STATUSES.DENIED;
  await updateUser(userId, {
    viventiumApprovalStatus: status,
    viventiumApprovalReviewedAt: new Date(),
  });

  return { userId, status };
}

module.exports = {
  APPROVAL_STATUSES,
  APPROVAL_ERROR_CODE,
  PENDING_APPROVAL_MESSAGE,
  isRegistrationApprovalEnabled,
  normalizeApprovalStatus,
  isViventiumApproved,
  assertViventiumApproved,
  markUserPendingApproval,
  notifyAdminRegistration,
  applyRegistrationDecision,
};
