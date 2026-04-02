/* === VIVENTIUM START ===
 * Feature: Morning Briefing Bootstrap (Default Starter Schedule)
 *
 * Purpose:
 * - Provision a default "Morning Brain Briefing" scheduled task for new users on first interaction.
 * - Idempotent: uses metadata.template_id to prevent duplicate schedules.
 * - Non-blocking: failures never delay the user's response.
 * - Channel-aware: includes Telegram only when linked, always includes librechat.
 *
 * Called from: ResumableAgentController (request.js) as fire-and-forget.
 *
 * Added: 2026-02-15
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');

const TEMPLATE_ID = 'morning_briefing_default_v1';
const DEFAULT_TIME = '08:00';
const DEFAULT_TIMEZONE = 'UTC';

const bootstrappedUsers = new Set();

function isBootstrapEnabled() {
  const raw = (process.env.VIVENTIUM_MORNING_BRIEFING_BOOTSTRAP_ENABLED || 'true').toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

function getSchedulingMcpUrl() {
  return (process.env.SCHEDULING_MCP_URL || 'http://localhost:7010').replace(/\/$/, '');
}

function getSchedulingBootstrapBaseUrl() {
  const raw = getSchedulingMcpUrl();
  return raw.replace(/\/mcp$/i, '');
}

function getDefaultTime() {
  return (process.env.VIVENTIUM_MORNING_BRIEFING_DEFAULT_TIME || DEFAULT_TIME).trim();
}

function getDefaultTimezone() {
  return (process.env.VIVENTIUM_DEFAULT_TIMEZONE || DEFAULT_TIMEZONE).trim();
}

/**
 * Ensure a default morning briefing schedule exists for a user.
 * Non-blocking, idempotent, fail-open.
 *
 * Channel strategy: defaults to ALL channels (null → scheduling cortex defaults to all).
 * Best-effort dispatch (dispatch.py) gracefully handles unlinked channels at runtime,
 * so future channels (Slack, WhatsApp) auto-activate when added to AVAILABLE_CHANNELS.
 *
 * @param {object} params
 * @param {string} params.userId - LibreChat user ID
 * @param {string} [params.clientTimezone] - User's browser-reported timezone
 * @param {string} [params.surface] - Entry surface (web, telegram, voice)
 */
async function ensureMorningBriefing({ userId, clientTimezone, surface }) {
  if (!isBootstrapEnabled()) {
    return;
  }

  if (!userId) {
    return;
  }

  if (bootstrappedUsers.has(userId)) {
    return;
  }
  bootstrappedUsers.add(userId);

  try {
    const baseUrl = getSchedulingBootstrapBaseUrl();
    const timezone = clientTimezone || getDefaultTimezone();
    const agentId = (process.env.VIVENTIUM_MAIN_AGENT_ID || '').trim();

    const payload = {
      user_id: userId,
      template_id: TEMPLATE_ID,
      agent_id: agentId,
      channels: null,
      timezone,
      time: getDefaultTime(),
      conversation_policy: 'same',
      prompt:
        'Morning orientation: review my memories, calendar, pending tasks, ' +
        'and any overnight signals. Prepare a concise morning briefing for the user.',
      metadata: {
        template_id: TEMPLATE_ID,
        bootstrap_source: 'morningBriefingBootstrap',
        bootstrap_surface: surface || 'unknown',
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${baseUrl}/internal/bootstrap-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const result = await response.json();

    if (result.status === 'created') {
      logger.info(
        `[VIVENTIUM][bootstrap] Morning briefing created: userId=${userId} taskId=${result.task_id} channels=all`,
      );
    } else if (result.status === 'exists') {
      logger.debug(
        `[VIVENTIUM][bootstrap] Morning briefing already exists: userId=${userId} taskId=${result.task_id}`,
      );
    } else {
      logger.warn(
        `[VIVENTIUM][bootstrap] Unexpected bootstrap response: userId=${userId}`,
        result,
      );
    }
  } catch (err) {
    logger.warn(
      `[VIVENTIUM][bootstrap] Morning briefing bootstrap failed (non-blocking): userId=${userId}`,
      err?.message,
    );
  }
}

module.exports = { ensureMorningBriefing, TEMPLATE_ID };
