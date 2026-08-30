/* === VIVENTIUM START ===
 * Feature: GlassHive host-worker callbacks
 * Purpose:
 * - Receive signed GlassHive worker lifecycle callbacks.
 * - Persist completion, blocker, and status reports back into the originating conversation.
 *
 * Endpoint:
 * - POST /api/viventium/glasshive/callback
 *
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  acquireGlassHiveTerminalCallbackResultEffectLease,
  fenceGlassHiveTerminalCallbackResultEffectTransaction,
  receiveGlassHiveTerminalCallbackResult,
  releaseGlassHiveTerminalCallbackResultEffectLease,
  renewGlassHiveTerminalCallbackResultEffectLease,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ContentTypes } = require('librechat-data-provider');
const { Conversation, Message, GlassHiveTerminalCallbackResult } = require('~/db/models');
const db = require('~/models');
const {
  GLASSHIVE_CALLBACK_TYPE,
} = require('~/server/services/viventium/GlassHiveCallbackMessageService');
const {
  enqueueGlassHiveCallbackDelivery,
} = require('~/server/services/viventium/GlassHiveCallbackDeliveryService');
const {
  confirmGlassHiveCallbackContext,
  notifySchedulerExternalWorkSummary,
  recordGlassHiveCallbackExternalState,
  recordGlassHiveSurfaceDeliveryOutcome,
  isGlassHiveWorkTerminalCallback,
  resolveGlassHiveCallbackContext,
} = require('~/server/services/viventium/GlassHiveCallbackBindingService');
const {
  enqueueGlassHiveMissionAdjudication,
} = require('~/server/services/viventium/GlassHiveMissionAdjudicationService');
const {
  enqueueGlassHiveSchedulerCallbackOutbox,
} = require('~/server/services/viventium/GlassHiveTerminalCallbackOutboxService');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('~/server/services/viventium/GlassHiveTerminalCallbackTransaction');
const {
  claimOrReplaceCallSessionConversationId,
  getCallSession,
} = require('~/server/services/viventium/CallSessionService');
const {
  registerGlassHiveVoiceTaskActionCapabilities,
} = require('~/server/services/viventium/GlassHiveVoiceTaskActionService');
const { resolveLatestLeafMessageId } = require('~/server/services/viventium/conversationThreading');
const {
  completeVoiceTask,
  confirmVoiceTaskOwnerCancellation,
  createVoiceTask,
  failVoiceTask,
  getVoiceTaskByStreamId,
  hydrateVoiceTasksForCall,
  hydrateVoiceTaskByStreamId,
  isVoiceTaskSuppressedDurably,
  observeGenerationEvent,
  runVoiceTaskTerminalCallbackMutation,
  setVoiceTaskOwnerCapabilities,
} = require('~/server/services/viventium/VoiceTaskService');

const router = express.Router();
const CALLBACK_SKEW_SEC = 5 * 60;
const MAX_CALLBACK_TEXT_LENGTH = 4000;
const MAX_CALLBACK_FULL_TEXT_LENGTH = 64000;
const MAX_CALLBACK_EVENTS = 20;
const USER_VISIBLE_CALLBACK_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'checkpoint.ready',
  'artifact.created',
  'takeover.requested',
  'run.needs_input',
  'run.blocked',
]);
const LOCAL_PATH_PATTERN =
  /(?:~\/|\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)[^`'"<>\n\r]*?(?=$|[`'"<>\n\r]|[)\],.;:!?](?:\s|$)|\s+(?:and|or|from|at|with|then|while|because|but|plus|to|in|on)\b)/gi;
const SAFE_GLASSHIVE_LINK_PATTERN = /\[[^\]\n]{1,160}\]\((https?:\/\/[^)\s]+)\)/g;
const NON_USER_ARTIFACT_DIRS = new Set([
  '.codex',
  '.git',
  '.glasshive',
  '.venv',
  '__pycache__',
  'glasshive-host-tools',
  'node_modules',
]);
const NON_USER_ARTIFACT_FILES = new Set([
  '.mcp.json',
  'agents.md',
  'claude.md',
  'codex.md',
  'harness-prompt.md',
  'project-definition.md',
  'work-log.md',
]);
const ACTIVE_WORKER_FAILURE_CODES = new Set([
  'active_worker_conflict',
  'active_worker_limit',
  'host_worker_already_active',
  'host_capacity',
]);
const GENERATION_PLACEHOLDER_TEXTS = new Set(['generation in progress.']);

function glassHiveVoiceTaskStreamId(runId) {
  const value = String(runId || '')
    .trim()
    .slice(0, 120);
  return value ? `glasshive:${value}` : '';
}

async function isGlassHiveVoiceTaskSuppressed(task) {
  if (!task?.taskId) return false;
  return isVoiceTaskSuppressedDurably(task.taskId, {
    callSessionId: task.callSessionId,
    userId: task.userId,
    streamId: task.streamId,
  });
}

async function ensureGlassHiveVoiceTask(body = {}, { createIfMissing = true } = {}) {
  if (
    String(body.surface || '')
      .trim()
      .toLowerCase() !== 'voice'
  ) {
    return { task: null, parentTask: null, mismatch: false };
  }
  const callSessionId = String(body.voice_call_session_id || '')
    .trim()
    .slice(0, 160);
  const runId = String(body.run_id || '')
    .trim()
    .slice(0, 120);
  const userId = String(body.user_id || '')
    .trim()
    .slice(0, 160);
  const conversationId = String(body.conversation_id || '')
    .trim()
    .slice(0, 160);
  const parentStreamId = String(body.stream_id || body.voice_request_id || '')
    .trim()
    .slice(0, 160);
  if (!callSessionId || !runId || !userId || !conversationId) {
    return { task: null, parentTask: null, mismatch: true };
  }
  const session = await getCallSession(callSessionId);
  if (!session || session.callSessionId !== callSessionId || session.userId !== userId) {
    return { task: null, parentTask: null, mismatch: true };
  }
  let boundSession = session;
  if (!session.conversationId || session.conversationId === 'new') {
    boundSession = await claimOrReplaceCallSessionConversationId(callSessionId, conversationId);
  }
  if (
    !boundSession ||
    boundSession.callSessionId !== callSessionId ||
    boundSession.userId !== userId ||
    boundSession.conversationId !== conversationId
  ) {
    return { task: null, parentTask: null, mismatch: true };
  }
  await hydrateVoiceTasksForCall({ callSessionId, userId });
  await hydrateVoiceTaskByStreamId(glassHiveVoiceTaskStreamId(runId), {
    callSessionId,
    userId,
  });
  if (parentStreamId) {
    await hydrateVoiceTaskByStreamId(parentStreamId, { callSessionId, userId });
  }
  const existingTask = getVoiceTaskByStreamId(glassHiveVoiceTaskStreamId(runId));
  if (existingTask) {
    const mismatch =
      existingTask.callSessionId !== callSessionId ||
      (existingTask.userId && existingTask.userId !== userId) ||
      (existingTask.conversationId && existingTask.conversationId !== conversationId);
    return { task: mismatch ? null : existingTask, parentTask: null, mismatch };
  }
  const parentTask = parentStreamId ? getVoiceTaskByStreamId(parentStreamId) : null;
  if (
    parentTask &&
    (parentTask.callSessionId !== callSessionId ||
      (parentTask.userId && parentTask.userId !== userId) ||
      (parentTask.conversationId && parentTask.conversationId !== conversationId))
  ) {
    return { task: null, parentTask, mismatch: true };
  }
  if (!createIfMissing) {
    return { task: null, parentTask, mismatch: false };
  }
  const task = createVoiceTask({
    callSessionId,
    userId,
    conversationId,
    turnId: runId,
    streamId: glassHiveVoiceTaskStreamId(runId),
    parentTaskId: parentTask?.taskId,
    owner: { kind: 'glasshive_run', id: runId },
  });
  setVoiceTaskOwnerCapabilities(task.taskId, {
    kind: 'glasshive_run',
    ownerId: runId,
    cancellationConfirmable: false,
  });
  if (parentTask && (await isGlassHiveVoiceTaskSuppressed(parentTask))) {
    await confirmVoiceTaskOwnerCancellation(
      task.taskId,
      'The originating voice task was already cancelled; worker output remains suppressed.',
    );
  }
  return { task, parentTask, mismatch: false };
}

async function applyGlassHiveVoiceTaskCallback(body = {}, task, { resultMessageId } = {}) {
  if (!task) {
    return null;
  }
  const callbackEventId = String(body.callback_id || '')
    .trim()
    .slice(0, 160);
  const event = String(body.event || '').trim();
  if (event === 'run.started') {
    return observeGenerationEvent(task.taskId, {
      event: 'on_agent_update',
      data: {
        eventId: callbackEventId,
        name: 'GlassHive worker',
        message: 'Worker started',
      },
    });
  }
  if (event === 'checkpoint.ready') {
    return failVoiceTask(task.taskId, {
      code: 'glasshive_checkpoint_unavailable',
      message:
        sanitizeCallbackMessage(body.message) ||
        'This worker stopped at a checkpoint that cannot currently accept call input.',
    });
  }
  if (event === 'artifact.created') {
    return observeGenerationEvent(task.taskId, {
      event: 'source',
      data: {
        eventId: callbackEventId,
        source: {
          id: String(body.run_id || '').trim(),
          title:
            sanitizeCallbackMetadataValue(body?.deliverable?.label, { maxLength: 120 }) ||
            'GlassHive artifact',
          provider: 'glasshive',
        },
      },
    });
  }
  if (event === 'run.completed') {
    const deliverable = callbackDeliverable(body);
    if (deliverable) {
      observeGenerationEvent(task.taskId, {
        event: 'source',
        data: {
          eventId: `${callbackEventId}:source`,
          source: {
            id: String(body.run_id || '').trim(),
            title: deliverable.label || 'GlassHive result',
            provider: 'glasshive',
          },
        },
      });
    }
    return completeVoiceTask(task.taskId, { resultMessageId });
  }
  if (event === 'run.failed') {
    return failVoiceTask(task.taskId, {
      code: String(body.failure_code || body.failure_class || 'glasshive_run_failed').slice(0, 80),
      message: sanitizeCallbackMessage(body.message) || 'The GlassHive run failed.',
    });
  }
  if (
    (event === 'run.cancelled' || event === 'run.interrupted') &&
    isGlassHiveWorkTerminalCallback(body)
  ) {
    return await confirmVoiceTaskOwnerCancellation(
      task.taskId,
      sanitizeCallbackMessage(body.message) || 'The GlassHive worker confirmed it stopped.',
    );
  }
  return null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function getCallbackSecret() {
  return process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET || '';
}

function deriveCallbackSecret(secret, body = {}) {
  const workerId = String(body.worker_id || '').trim();
  const runId = String(body.run_id || '').trim();
  const binding = `${workerId}:${runId}`;
  return crypto.createHmac('sha256', secret).update(binding).digest('hex');
}

function verifySignature(body, signatureHeader = '') {
  const secret = getCallbackSecret();
  if (!secret) {
    return false;
  }
  const incoming = String(signatureHeader || '')
    .replace(/^sha256=/, '')
    .trim();
  if (!/^[a-f0-9]{64}$/i.test(incoming)) {
    return false;
  }
  const encoded = Buffer.from(stableStringify(body), 'utf8');
  const perRunSecret = deriveCallbackSecret(secret, body);
  const expected = crypto.createHmac('sha256', perRunSecret).update(encoded).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(incoming, 'hex'), Buffer.from(expected, 'hex'));
}

function isFreshCallback(body = {}, nowMs = Date.now()) {
  const ts = Number(body.callback_ts);
  if (!Number.isFinite(ts)) {
    return false;
  }
  return Math.abs(nowMs / 1000 - ts) <= CALLBACK_SKEW_SEC;
}

function callbackReplayKey(body = {}) {
  const callbackId = String(body.callback_id || '').trim();
  if (callbackId) {
    return callbackId;
  }
  const stable = stableStringify({
    event: body.event,
    worker_id: body.worker_id,
    run_id: body.run_id,
    conversation_id: body.conversation_id,
    message: body.message,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function isSafeGlassHiveActionUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase();
    const isLocalHost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    const safeId = '[A-Za-z0-9_-]{1,128}';
    const isWatchLink =
      new RegExp(`^/watch/${safeId}$`).test(url.pathname) &&
      new RegExp(`^${safeId}$`).test(String(url.searchParams.get('project_id') || ''));
    const isSignedLink = new RegExp(`^/v1/signed-links/[A-Za-z0-9._-]{10,4096}$`).test(
      url.pathname,
    );
    const artifactPath = String(url.searchParams.get('path') || '').replace(/\\/g, '/');
    const artifactSegments = artifactPath.split('/').filter(Boolean);
    const artifactPathIsUserVisible =
      artifactSegments.length > 0 &&
      artifactSegments.every((segment) => !segment.startsWith('.')) &&
      !artifactSegments.some((segment) => NON_USER_ARTIFACT_DIRS.has(segment.toLowerCase())) &&
      !NON_USER_ARTIFACT_FILES.has(artifactSegments[artifactSegments.length - 1]?.toLowerCase());
    const artifactPathIsSafe =
      Boolean(artifactPath) &&
      artifactPath.length <= 1024 &&
      !artifactPath.startsWith('/') &&
      artifactSegments.length > 0 &&
      artifactSegments.every((segment) => segment !== '.' && segment !== '..') &&
      artifactPathIsUserVisible;
    const isLocalArtifactOpen =
      isLocalHost &&
      new RegExp(`^/v1/workers/${safeId}/artifacts/open$`).test(url.pathname) &&
      artifactPathIsSafe;
    const isLocalArtifactDownload =
      isLocalHost &&
      new RegExp(`^/v1/workers/${safeId}/artifacts/download$`).test(url.pathname) &&
      artifactPathIsSafe;
    if (isLocalHost) {
      return isWatchLink || isSignedLink || isLocalArtifactOpen || isLocalArtifactDownload;
    }
    return (isWatchLink && url.searchParams.has('gh_token')) || isSignedLink;
  } catch {
    return false;
  }
}

function protectSafeGlassHiveLinks(text = '') {
  const links = [];
  const protectedText = String(text || '').replace(SAFE_GLASSHIVE_LINK_PATTERN, (match, url) => {
    if (!isSafeGlassHiveActionUrl(url)) {
      return match;
    }
    const token = `__VIVENTIUM_SAFE_GLASSHIVE_LINK_${links.length}__`;
    links.push({ token, value: match });
    return token;
  });
  return { protectedText, links };
}

function restoreSafeGlassHiveLinks(text = '', links = []) {
  return links.reduce(
    (current, { token, value }) => current.replace(token, value),
    String(text || ''),
  );
}

function sanitizeCallbackMessage(value, { maxLength = MAX_CALLBACK_TEXT_LENGTH } = {}) {
  const { protectedText, links } = protectSafeGlassHiveLinks(String(value || '').trim());
  let text = protectedText;
  if (!text) {
    return '';
  }
  text = text
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s)`'"<>]*/gi, '[local worker link]')
    .replace(LOCAL_PATH_PATTERN, '[local path]')
    .replace(/\]\(\[local path\](?!\))/g, ']([local path])')
    .replace(/\bwrk[_-][A-Za-z0-9_-]+\b/g, '[worker id]')
    .replace(/\brun[_-][A-Za-z0-9_-]+\b/g, '[run id]')
    .replace(/\bprj[_-][A-Za-z0-9_-]+\b/g, '[project id]');
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? '';
      const body = line.slice(leadingWhitespace.length).replace(/[ \t]+/g, ' ');
      return `${leadingWhitespace}${body}`.trimEnd();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text = restoreSafeGlassHiveLinks(text, links);
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

function sanitizeCallbackMetadataValue(value, { maxLength = 120 } = {}) {
  const text = sanitizeCallbackMessage(value, { maxLength });
  return text || null;
}

function sanitizeCallbackErrorForLog(error) {
  const message = error?.message ? sanitizeCallbackMessage(error.message, { maxLength: 160 }) : '';
  return {
    name: error?.name || null,
    code: error?.code || null,
    status: Number.isFinite(error?.status) ? error.status : null,
    message: message || null,
  };
}

function isActiveWorkerFailure({ failureCode = '', message = '' } = {}) {
  void message;
  return ACTIVE_WORKER_FAILURE_CODES.has(
    String(failureCode || '')
      .trim()
      .toLowerCase(),
  );
}

function hasCallbackDeliverable(body = {}) {
  const deliverable = body?.deliverable;
  if (!deliverable || typeof deliverable !== 'object' || Array.isArray(deliverable)) {
    return false;
  }
  return Boolean(
    String(deliverable.workspace_path || deliverable.workspacePath || '').trim() ||
    String(deliverable.open_url || deliverable.openUrl || '').trim() ||
    String(deliverable.download_url || deliverable.downloadUrl || '').trim() ||
    String(deliverable.label || '').trim(),
  );
}

function isEvidenceGateFailure({ failureCode = '', message = '' } = {}) {
  void message;
  const code = String(failureCode || '')
    .trim()
    .toLowerCase();
  return code === 'glasshive_evidence_check_failed';
}

function callbackText(body = {}) {
  const event = String(body.event || '').trim();
  if (event === 'run.completed' && isGlassHiveWorkTerminalCallback(body)) {
    return 'Mission completed.';
  }
  if (event === 'run.failed' && isGlassHiveWorkTerminalCallback(body)) {
    const failureCode = String(
      body.failure_code || body.failure_class || body.error_code || body?.error?.code || '',
    )
      .trim()
      .toLowerCase();
    if (isActiveWorkerFailure({ failureCode })) {
      return 'Mission is waiting for worker capacity.';
    }
    if (hasCallbackDeliverable(body) && isEvidenceGateFailure({ failureCode })) {
      return 'Mission output needs verification.';
    }
    return 'Mission needs attention.';
  }
  if (event === 'checkpoint.ready') {
    return 'Mission needs approval.';
  }
  if (
    (event === 'run.cancelled' || event === 'run.interrupted') &&
    isGlassHiveWorkTerminalCallback(body)
  ) {
    return 'Mission stopped.';
  }
  if (event === 'takeover.requested') {
    return 'Mission needs user input.';
  }
  if (event === 'run.needs_input') {
    return 'Mission needs user input.';
  }
  if (event === 'run.blocked') {
    return 'Mission needs attention.';
  }
  if (event === 'artifact.created') {
    return 'Mission produced an artifact.';
  }
  return '';
}

function callbackStatus(body = {}) {
  const event = String(body.event || '').trim();
  const failureCode = String(
    body.failure_code || body.failure_class || body.error_code || body?.error?.code || '',
  )
    .trim()
    .toLowerCase();
  if (event === 'run.completed' && isGlassHiveWorkTerminalCallback(body)) {
    return { kind: 'mission_status', state: 'completed', attention: null };
  }
  if (event === 'run.failed' && isGlassHiveWorkTerminalCallback(body)) {
    if (isActiveWorkerFailure({ failureCode })) {
      return { kind: 'mission_status', state: 'queued', attention: 'capacity' };
    }
    if (isEvidenceGateFailure({ failureCode, message: body.message })) {
      return { kind: 'mission_status', state: 'failed', attention: 'verification' };
    }
    return { kind: 'mission_status', state: 'failed', attention: 'error' };
  }
  if (event === 'checkpoint.ready') {
    return { kind: 'mission_status', state: 'needs_input', attention: 'approval' };
  }
  if (event === 'takeover.requested') {
    return { kind: 'mission_status', state: 'needs_input', attention: 'takeover' };
  }
  if (event === 'run.needs_input') {
    return { kind: 'mission_status', state: 'needs_input', attention: 'input' };
  }
  if (event === 'run.blocked') {
    return { kind: 'mission_status', state: 'needs_input', attention: 'blocked' };
  }
  if (event === 'run.cancelled' || event === 'run.interrupted') {
    return { kind: 'mission_status', state: 'cancelled', attention: null };
  }
  if (event === 'artifact.created') {
    return { kind: 'mission_status', state: 'artifact_ready', attention: null };
  }
  return { kind: 'mission_status', state: 'unknown', attention: null };
}

function callbackFullText(body = {}, preview = '') {
  void body;
  void preview;
  // Raw worker evidence is persisted for Main/Phase-B adjudication, never attached to the
  // neutral status card or direct surface-delivery payload.
  return '';
}

function callbackSurface(body = {}) {
  return String(body.surface || '')
    .trim()
    .toLowerCase();
}

function effectiveCallbackBody(body = {}, deliveryContext = {}) {
  const destinations = Array.isArray(deliveryContext.destinations)
    ? deliveryContext.destinations
    : [];
  const voice = destinations.find(
    (destination) => destination?.surface === 'voice' && !destination?.unresolvedReason,
  );
  const telegram = destinations.find(
    (destination) => destination?.surface === 'telegram' && !destination?.unresolvedReason,
  );
  // An unresolved destination is durable fan-out truth, not a valid request identity. Never let
  // it become the callback's primary surface and trigger a false voice/Telegram ownership check.
  const primary = voice || telegram || { surface: 'librechat' };
  return {
    ...body,
    user_id: deliveryContext.ownerId,
    conversation_id: deliveryContext.conversationId,
    parent_message_id: deliveryContext.requestedParentMessageId,
    message_id: deliveryContext.anchorMessageId,
    surface: primary.surface || 'librechat',
    telegram_chat_id: telegram?.telegramChatId || '',
    telegram_user_id: telegram?.telegramUserId || '',
    telegram_message_id: telegram?.telegramMessageId || '',
    voice_call_session_id: voice?.voiceCallSessionId || '',
    voice_request_id: voice?.voiceRequestId || '',
  };
}

function deliveryOutcome(summary = {}) {
  if (summary?.deferredToMain === true) return 'main_adjudication_pending';
  const configured = Number(summary?.configured) || 0;
  const enqueued = Number(summary?.enqueued) || 0;
  const unresolved = Number(summary?.unresolved) || 0;
  if (unresolved > 0 && enqueued > 0) return 'partially_enqueued';
  if (unresolved > 0) return 'unresolved';
  if (enqueued > 0) return 'enqueued';
  if (configured > 0) return 'unresolved';
  return 'not_applicable';
}

async function recordWebOnlyCallbackDelivery({
  deliveryContext,
  deliverySummary,
  body,
  effectFence,
  effectSession,
}) {
  effectSession ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session || null;
  const hasLocalDestination = (deliveryContext?.destinations || []).some((destination) =>
    ['librechat', 'workbench'].includes(
      String(destination?.surface || '')
        .trim()
        .toLowerCase(),
    ),
  );
  if (!hasLocalDestination || Number(deliverySummary?.configured) > 0) return;
  // HTTP acceptance and callback persistence are mutable projection truth, not a Main surface receipt.
  await recordGlassHiveSurfaceDeliveryOutcome({
    originRef: String(deliveryContext?.originRef || '').trim(),
    state: 'sent',
    ...(effectFence ? { body, effectFence, effectSession } : {}),
  });
}

function callbackContent(text) {
  return [
    {
      type: ContentTypes.TEXT,
      text,
      [ContentTypes.TEXT]: text,
    },
  ];
}

function sameGlassHiveRun(message, body = {}) {
  const originRef = String(body.origin_ref || '').trim();
  const workRef = String(body.work_ref || '').trim();
  const workerId = String(body.worker_id || '').trim();
  const runId = String(body.run_id || '').trim();
  const metadata = message?.metadata?.viventium;
  if (!metadata || metadata.type !== GLASSHIVE_CALLBACK_TYPE) {
    return false;
  }
  if (!workerId) {
    return false;
  }
  const metadataWorkerId = String(metadata.workerId || '').trim();
  const metadataRunId = String(metadata.runId || '').trim();
  const metadataOriginRef = String(metadata.originRef || '').trim();
  const metadataWorkRef = String(metadata.workRef || '').trim();
  return (
    metadataWorkerId === workerId &&
    (!runId || metadataRunId === runId) &&
    (!originRef || metadataOriginRef === originRef) &&
    (!workRef || metadataWorkRef === workRef)
  );
}

function messageVisibleText(message) {
  const text = String(message?.text || '').trim();
  if (text) {
    return text;
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const item of content) {
    const itemText = String(item?.text || item?.[ContentTypes.TEXT] || '').trim();
    if (itemText) {
      return itemText;
    }
  }
  return '';
}

function isGenerationPlaceholderMessage(message) {
  if (!message || message.isCreatedByUser === true || message.unfinished !== true) {
    return false;
  }
  return GENERATION_PLACEHOLDER_TEXTS.has(messageVisibleText(message).toLowerCase());
}

function latestLeafMessage(messages) {
  const leafId = resolveLatestLeafMessageId(messages);
  return {
    messageId: leafId,
    message: messageById(messages, leafId),
  };
}

function resolveCallbackTreeParentMessageId({
  messages,
  requestedParentMessageId,
  anchorMessageId,
  priorStatusMessage,
  body,
}) {
  const currentLeaf = latestLeafMessage(messages);
  const currentLeafId = currentLeaf.messageId;
  if (priorStatusMessage && String(priorStatusMessage.messageId || '') === currentLeafId) {
    return {
      parentMessageId:
        priorStatusMessage.parentMessageId || anchorMessageId || requestedParentMessageId,
      currentLeaf,
      updateMessage: priorStatusMessage,
    };
  }
  const blankAnchor = blankAssistantAnchorMessage(messages, anchorMessageId);
  if (blankAnchor && currentLeafId === anchorMessageId) {
    return {
      parentMessageId: requestedParentMessageId || blankAnchor.parentMessageId || '',
      currentLeaf,
      updateMessage: blankAnchor,
    };
  }
  if (isGenerationPlaceholderMessage(currentLeaf.message)) {
    return {
      parentMessageId: currentLeafId || anchorMessageId || requestedParentMessageId,
      currentLeaf,
      updateMessage: null,
      blockedByActivePlaceholder: true,
    };
  }
  return {
    parentMessageId: currentLeafId || anchorMessageId || requestedParentMessageId,
    currentLeaf,
    updateMessage: null,
  };
}

function latestPriorGlassHiveStatusMessage(messages, body = {}) {
  const matches = (Array.isArray(messages) ? messages : [])
    .filter((message) => sameGlassHiveRun(message, body))
    .filter((message) => typeof message?.text === 'string' && message.text.trim())
    .sort((a, b) => {
      const aTime = Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0;
      const bTime = Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0;
      return aTime - bTime;
    });
  return matches.length ? matches[matches.length - 1] : null;
}

function blankAssistantAnchorMessage(messages, anchorMessageId) {
  const id = String(anchorMessageId || '').trim();
  if (!id) {
    return null;
  }
  return (
    (Array.isArray(messages) ? messages : []).find((message) => {
      if (String(message?.messageId || '') !== id) {
        return false;
      }
      if (message?.isCreatedByUser === true) {
        return false;
      }
      return typeof message?.text === 'string' && !message.text.trim();
    }) || null
  );
}

function messageById(messages, messageId) {
  const id = String(messageId || '').trim();
  if (!id) {
    return null;
  }
  return (
    (Array.isArray(messages) ? messages : []).find(
      (message) => String(message?.messageId || '') === id,
    ) || null
  );
}

function persistedCallbackMessage(messages, body = {}) {
  const replayKey = callbackReplayKey(body);
  const callbackId = String(body.callback_id || '').trim();
  return (
    (Array.isArray(messages) ? messages : []).find((message) => {
      const metadata = message?.metadata?.viventium;
      if (!metadata || metadata.type !== GLASSHIVE_CALLBACK_TYPE) {
        return false;
      }
      if (callbackId && String(metadata.callbackId || '').trim() === callbackId) {
        return true;
      }
      if (replayKey && String(metadata.callbackKey || '').trim() === replayKey) {
        return true;
      }
      const events = Array.isArray(metadata.events) ? metadata.events : [];
      return events.some((event) => {
        if (callbackId && String(event?.callbackId || '').trim() === callbackId) {
          return true;
        }
        return replayKey && String(event?.callbackKey || '').trim() === replayKey;
      });
    }) || null
  );
}

function hasPersistedCallback(messages, body = {}) {
  return Boolean(persistedCallbackMessage(messages, body));
}

async function enqueueSurfaceDeliveryOrThrow({
  body,
  message,
  text,
  fullText,
  deliveryContext,
  effectFence,
  effectSession,
}) {
  const hasExternalDestination = (deliveryContext?.destinations || []).some((destination) =>
    ['telegram', 'voice'].includes(
      String(destination?.surface || '')
        .trim()
        .toLowerCase(),
    ),
  );
  if (!hasExternalDestination) {
    return { configured: 0, enqueued: 0, deliveries: [] };
  }
  return enqueueGlassHiveCallbackDelivery({
    body,
    message,
    text,
    fullText,
    deliveryContext,
    effectFence,
    effectSession,
  });
}

async function repairDuplicateSurfaceDelivery({
  body,
  messages,
  text,
  fullText,
  deliveryContext,
  effectFence,
  effectSession,
}) {
  const hasExternalDestination = (deliveryContext?.destinations || []).some((destination) =>
    ['telegram', 'voice'].includes(
      String(destination?.surface || '')
        .trim()
        .toLowerCase(),
    ),
  );
  if (!hasExternalDestination) {
    return { configured: 0, enqueued: 0, deliveries: [] };
  }
  const persistedMessage = persistedCallbackMessage(messages, body);
  if (!persistedMessage) {
    return { configured: 0, enqueued: 0, deliveries: [] };
  }
  return enqueueGlassHiveCallbackDelivery({
    body,
    message: persistedMessage,
    text: String(persistedMessage.text || text || '').trim(),
    fullText,
    deliveryContext,
    effectFence,
    effectSession,
  });
}

function callbackEventEntry(body = {}) {
  return {
    callbackId: body.callback_id || null,
    callbackKey: callbackReplayKey(body),
    event: body.event || null,
    workerId: body.worker_id || null,
    runId: body.run_id || null,
    runState: body.run_state || null,
    callbackTs: body.callback_ts || null,
  };
}

function callbackDeliverable(body = {}) {
  const deliverable = body?.deliverable;
  if (!deliverable || typeof deliverable !== 'object' || Array.isArray(deliverable)) {
    return null;
  }
  return {
    kind: sanitizeCallbackMetadataValue(deliverable.kind, { maxLength: 48 }),
    state: sanitizeCallbackMetadataValue(deliverable.state, { maxLength: 48 }),
    source: sanitizeCallbackMetadataValue(deliverable.source, { maxLength: 80 }),
    label: sanitizeCallbackMetadataValue(deliverable.label, { maxLength: 120 }),
    preferredSurface: sanitizeCallbackMetadataValue(
      deliverable.preferred_surface || deliverable.preferredSurface,
      { maxLength: 48 },
    ),
  };
}

function buildCallbackMetadata({
  body,
  parentMessageId,
  treeParentMessageId,
  requestedParentMessageId,
  anchorMessageId,
  previousMetadata,
  hasFullText,
  deliveryContext,
}) {
  const previousViventium =
    previousMetadata && typeof previousMetadata === 'object' && previousMetadata.viventium
      ? previousMetadata.viventium
      : {};
  const previousEvents = Array.isArray(previousViventium.events) ? previousViventium.events : [];
  const eventEntry = callbackEventEntry(body);
  return {
    ...(previousMetadata && typeof previousMetadata === 'object' ? previousMetadata : {}),
    viventium: {
      ...previousViventium,
      type: GLASSHIVE_CALLBACK_TYPE,
      parentMessageId: requestedParentMessageId || parentMessageId,
      treeParentMessageId,
      requestedParentMessageId,
      anchorMessageId,
      workerId: body?.worker_id,
      runId: body?.run_id,
      event: body?.event,
      surface: body?.surface,
      status: callbackStatus(body || {}),
      callbackBindingId: deliveryContext?.bindingId || null,
      originRef: deliveryContext?.originRef || null,
      workRef: deliveryContext?.workRef || null,
      configuredDestinations: (deliveryContext?.destinations || []).map((destination) => ({
        surface: destination?.surface || null,
        resolved: !destination?.unresolvedReason,
      })),
      streamId: body?.stream_id,
      voiceCallSessionId: body?.voice_call_session_id,
      voiceRequestId: body?.voice_request_id,
      logicalTurnId: sanitizeCallbackMetadataValue(body?.logical_turn_id, { maxLength: 160 }),
      logicalTurnRevision:
        Number.isInteger(Number(body?.logical_turn_revision)) &&
        Number(body?.logical_turn_revision) >= 1
          ? Number(body.logical_turn_revision)
          : null,
      callbackId: body?.callback_id || null,
      callbackKey: callbackReplayKey(body || {}),
      deliverable: callbackDeliverable(body || {}),
      hasFullText: Boolean(hasFullText),
      events: [...previousEvents, eventEntry].slice(-MAX_CALLBACK_EVENTS),
    },
  };
}

async function rollbackSuppressedVoiceCallback({
  priorStatusMessage,
  followUpMessage,
  userId,
  conversationId,
}) {
  if (priorStatusMessage && typeof db.updateMessage === 'function') {
    await db.updateMessage({ user: { id: userId } }, priorStatusMessage, {
      context: 'viventium/routes/glasshive.callback.cancel_rollback',
      overrideTimestamp: true,
    });
    return;
  }
  if (typeof db.deleteMessages === 'function') {
    await db.deleteMessages({ user: userId, messageId: followUpMessage.messageId });
  } else {
    await Message.deleteOne({ user: userId, messageId: followUpMessage.messageId });
  }
  await Conversation.updateOne(
    { user: userId, conversationId },
    { $pull: { messages: followUpMessage.messageId } },
  );
}

function callbackMessageTimestamps({ messages, requestedParentMessageId, priorStatusMessage }) {
  const now = new Date();
  const requestedParent = messageById(messages, requestedParentMessageId);
  const requestedParentTime = Date.parse(String(requestedParent?.createdAt || ''));
  const priorTime = Date.parse(String(priorStatusMessage?.createdAt || ''));
  let createdAt = now;
  if (Number.isFinite(priorTime) && priorTime > 0) {
    createdAt = new Date(priorTime);
  }
  if (
    Number.isFinite(requestedParentTime) &&
    requestedParentTime > 0 &&
    createdAt.getTime() <= requestedParentTime
  ) {
    createdAt = now;
  }
  return {
    createdAt,
    updatedAt: now,
  };
}

async function touchCallbackConversation({ userId, conversationId, updatedAt }) {
  if (!Conversation?.findOneAndUpdate || typeof db.getMessages !== 'function') {
    return;
  }
  const messages = (await db.getMessages({ user: userId, conversationId }, '_id')) ?? [];
  await Conversation.findOneAndUpdate(
    { user: userId, conversationId },
    {
      $set: {
        messages,
        updatedAt: updatedAt || new Date(),
      },
    },
    {
      new: false,
      upsert: false,
      timestamps: false,
    },
  );
}

async function reconcileCallbackExternalWork({
  deliveryContext,
  body,
  effectFence,
  effectSession,
}) {
  effectSession ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session || null;
  const summary = await recordGlassHiveCallbackExternalState({
    binding: deliveryContext,
    body,
    ...(effectFence ? { effectFence, effectSession } : {}),
  });
  if (summary) {
    if (effectFence) {
      await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: deliveryContext,
        summary,
        effectFence,
        effectSession,
      });
    } else {
      await notifySchedulerExternalWorkSummary({ binding: deliveryContext, summary });
    }
  }
  // A callback event describes one run, while adjudication authors the result for the durable
  // WorkRef. Queue/Message/Steer may leave a sibling alive after this run ends, so only the
  // authoritative work-terminal contract may enter Main's terminal evidence pipeline.
  if (isGlassHiveWorkTerminalCallback(body)) {
    await enqueueGlassHiveMissionAdjudication({
      binding: deliveryContext,
      body,
      ...(effectFence ? { effectFence, effectSession } : {}),
    });
  }
  return summary;
}

function httpAcceptedPayload({
  messageId = null,
  updated = false,
  duplicate = false,
  callbackPersisted = true,
  deliverySummary = null,
} = {}) {
  return {
    status: 'http_accepted',
    callbackPersisted,
    duplicate,
    messageId,
    updated,
    surfaceDelivery: deliveryOutcome(deliverySummary),
    targetRowsEnqueued: Number(deliverySummary?.enqueued) || 0,
    targetRowsUnresolved: Number(deliverySummary?.unresolved) || 0,
  };
}

function withTerminalResultReceipt(payload, receipt) {
  return receipt ? { ...payload, ...receipt } : payload;
}

class TerminalCallbackEffectFenceError extends Error {
  constructor(gate) {
    super('glasshive_terminal_callback_effect_fence_lost');
    this.gate = gate;
  }
}

async function handleGlassHiveCallback(req, res) {
  let terminalEffectScope = null;
  let terminalEffectLease = null;
  res.locals.releaseGlassHiveTerminalEffectLease = async () => {
    const lease = terminalEffectLease;
    terminalEffectLease = null;
    if (!lease) return;
    await releaseGlassHiveTerminalCallbackResultEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease,
    });
  };
  const ensureCurrentTerminalEffectLease = async () => {
    if (!terminalEffectLease) return;
    const stillCurrent = await renewGlassHiveTerminalCallbackResultEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: terminalEffectLease,
    });
    if (stillCurrent) return;
    const reacquired = await acquireGlassHiveTerminalCallbackResultEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      effectScope: terminalEffectScope,
    });
    if (!reacquired.acquired) {
      throw new TerminalCallbackEffectFenceError(reacquired);
    }
    terminalEffectLease = reacquired.lease;
  };
  const runTerminalEffect = async (effect) => {
    let result;
    let effectSession = null;
    const afterCommit = [];
    const stageAfterCommit = (operation) => {
      if (typeof operation !== 'function') {
        throw new Error('glasshive_callback_after_commit_operation_invalid');
      }
      afterCommit.push(operation);
      return null;
    };
    try {
      if (!terminalEffectLease) {
        result = await effect(null, null, (operation) => operation());
      } else {
        await runGlassHiveTerminalCallbackTransaction(async (session) => {
          effectSession = session;
          result = await effect(terminalEffectLease, effectSession, stageAfterCommit);
          const stillCurrent = await fenceGlassHiveTerminalCallbackResultEffectTransaction({
            ResultModel: GlassHiveTerminalCallbackResult,
            lease: terminalEffectLease,
            session: effectSession,
          });
          if (!stillCurrent) {
            throw Object.assign(new Error('glasshive_callback_effect_fenced'), {
              code: 'glasshive_callback_effect_fenced',
            });
          }
        });
        for (const operation of afterCommit) {
          await ensureCurrentTerminalEffectLease();
          result = await operation();
        }
      }
    } catch (err) {
      const transactionConflict =
        [112, 244, 251].includes(Number(err?.code)) ||
        err?.hasErrorLabel?.('TransientTransactionError') === true;
      if (err?.code === 'glasshive_callback_effect_fenced' || transactionConflict) {
        await ensureCurrentTerminalEffectLease();
      }
      throw err;
    }
    return result;
  };

  if (!verifySignature(req.body || {}, req.get('x-glasshive-signature'))) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  if (!isFreshCallback(req.body || {})) {
    return res.status(401).json({ error: 'stale_callback' });
  }

  const rawBody = req.body || {};
  let deliveryContext;
  try {
    deliveryContext = await resolveGlassHiveCallbackContext(rawBody, { deferConfirmation: true });
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Callback delivery binding lookup unavailable:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(503).json({ error: 'callback_delivery_binding_unavailable' });
  }
  if (!deliveryContext) {
    return res.status(425).json({ error: 'callback_delivery_binding_not_ready' });
  }
  const callbackBody = effectiveCallbackBody(rawBody, deliveryContext);
  const userId = String(deliveryContext.ownerId || '').trim();
  const conversationId = String(deliveryContext.conversationId || '').trim();
  const requestedParentMessageId = String(deliveryContext.requestedParentMessageId || '').trim();
  const anchorMessageId = String(deliveryContext.anchorMessageId || '').trim();
  const event = String(callbackBody.event || '').trim();
  if (!userId || !conversationId || !requestedParentMessageId || !anchorMessageId) {
    return res.status(425).json({ error: 'callback_delivery_binding_not_ready' });
  }
  let terminalResultReceipt = null;
  try {
    const terminalResultGate = await receiveGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      body: rawBody,
      headers: {
        callbackId: req.get('x-glasshive-callback-id'),
        resultRevision: req.get('x-glasshive-result-revision'),
        resultDigest: req.get('x-glasshive-result-digest'),
      },
      trustedScope: {
        ownerId: deliveryContext.ownerId,
        originRef: deliveryContext.originRef,
        workRef: deliveryContext.workRef,
      },
    });
    if (terminalResultGate.applies && 'error' in terminalResultGate) {
      return res.status(terminalResultGate.httpStatus).json({ error: terminalResultGate.error });
    }
    if (terminalResultGate.applies) {
      terminalResultReceipt = terminalResultGate.receipt;
      if (!terminalResultGate.accepted) {
        return res.status(terminalResultGate.httpStatus).json(terminalResultGate.receipt);
      }
      terminalEffectScope = terminalResultGate.effectScope;
      const effectGate = await acquireGlassHiveTerminalCallbackResultEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        effectScope: terminalEffectScope,
      });
      if (!effectGate.acquired) {
        if ('receipt' in effectGate) {
          return res.status(effectGate.httpStatus).json(effectGate.receipt);
        }
        return res.status(effectGate.httpStatus).json({ error: effectGate.error });
      }
      terminalEffectLease = effectGate.lease;
    }
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Terminal callback result CAS unavailable:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(503).json({ error: 'callback_result_cas_unavailable' });
  }
  try {
    await runTerminalEffect((effectFence, effectSession) =>
      confirmGlassHiveCallbackContext({
        binding: deliveryContext,
        body: rawBody,
        effectFence,
        effectSession,
      }),
    );
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError) throw err;
    logger.warn(
      '[VIVENTIUM][glasshive] Callback delivery binding confirmation unavailable:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(503).json({ error: 'callback_delivery_binding_unavailable' });
  }
  if (typeof db.getConvo !== 'function') {
    logger.warn('[VIVENTIUM][glasshive] Callback receiver missing getConvo ownership check.');
    return res.status(500).json({ error: 'ownership_check_unavailable' });
  }
  const conversation = await db.getConvo(
    String(deliveryContext.ownerId || '').trim(),
    String(deliveryContext.conversationId || '').trim(),
  );
  if (!conversation) {
    // A valid owner-scoped association remains authoritative after the origin conversation is
    // deleted. Persist work truth/evidence and let Main create an account-level continuation;
    // never resurrect the deleted conversation merely to host a neutral worker card.
    try {
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
    } catch (err) {
      if (err instanceof TerminalCallbackEffectFenceError) throw err;
      logger.warn(
        '[VIVENTIUM][glasshive] Deleted-origin callback reconciliation failed:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(503).json({ error: 'callback_reconciliation_failed' });
    }
    return res.status(202).json(
      withTerminalResultReceipt(
        {
          ...httpAcceptedPayload({ callbackPersisted: true }),
          reason: 'origin_conversation_deleted',
        },
        terminalResultReceipt,
      ),
    );
  }
  const taskOnlyEvent = event === 'run.started' && callbackSurface(callbackBody) === 'voice';
  if (!USER_VISIBLE_CALLBACK_EVENTS.has(event) && !taskOnlyEvent) {
    // Lifecycle-only events still drive the authoritative active-work projection. HTTP acceptance
    // means Core durably accounted for them; it must not mean "filtered before reconciliation."
    try {
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
    } catch (err) {
      if (err instanceof TerminalCallbackEffectFenceError) throw err;
      logger.warn(
        '[VIVENTIUM][glasshive] Lifecycle callback reconciliation failed:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(503).json({ error: 'callback_reconciliation_failed' });
    }
    return res.status(202).json(
      withTerminalResultReceipt(
        {
          ...httpAcceptedPayload({ callbackPersisted: true }),
          reason: 'lifecycle_reconciled',
        },
        terminalResultReceipt,
      ),
    );
  }
  const text = callbackText(callbackBody);
  if (!text && !taskOnlyEvent) {
    try {
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
    } catch (err) {
      if (err instanceof TerminalCallbackEffectFenceError) throw err;
      logger.warn(
        '[VIVENTIUM][glasshive] Textless callback reconciliation failed:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(503).json({ error: 'callback_reconciliation_failed' });
    }
    return res.status(202).json(
      withTerminalResultReceipt(
        {
          ...httpAcceptedPayload({ callbackPersisted: true }),
          reason: 'missing_context_or_text',
        },
        terminalResultReceipt,
      ),
    );
  }
  const fullText = callbackFullText(callbackBody, text);
  let voiceTaskResolution;
  try {
    voiceTaskResolution = await runTerminalEffect((effectFence) =>
      ensureGlassHiveVoiceTask(callbackBody, { createIfMissing: !effectFence }),
    );
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError) throw err;
    logger.warn(
      '[VIVENTIUM][glasshive] Voice task session binding unavailable:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(503).json({ error: 'voice_task_binding_unavailable' });
  }
  if (voiceTaskResolution.mismatch) {
    return res.status(409).json({ error: 'voice_task_session_mismatch' });
  }
  const voiceTask = voiceTaskResolution.task;
  if (voiceTask && (await isGlassHiveVoiceTaskSuppressed(voiceTask))) {
    if (event === 'run.cancelled' || event === 'run.interrupted') {
      await runTerminalEffect(() =>
        runVoiceTaskTerminalCallbackMutation(voiceTask.taskId, () =>
          applyGlassHiveVoiceTaskCallback(callbackBody, voiceTask),
        ),
      );
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
      return res.status(202).json(
        withTerminalResultReceipt(
          {
            ...httpAcceptedPayload({ callbackPersisted: false }),
            reason: 'cancellation_confirmed',
          },
          terminalResultReceipt,
        ),
      );
    }
    return res
      .status(202)
      .json(
        withTerminalResultReceipt(
          { status: 'suppressed', reason: 'voice_task_cancelled' },
          terminalResultReceipt,
        ),
      );
  }
  if (voiceTask) {
    await runTerminalEffect(() =>
      runVoiceTaskTerminalCallbackMutation(voiceTask.taskId, () =>
        registerGlassHiveVoiceTaskActionCapabilities({ body: callbackBody, task: voiceTask }),
      ),
    );
  }
  if (taskOnlyEvent) {
    await runTerminalEffect(() =>
      runVoiceTaskTerminalCallbackMutation(voiceTask.taskId, () =>
        applyGlassHiveVoiceTaskCallback(callbackBody, voiceTask),
      ),
    );
    await runTerminalEffect((effectFence) =>
      reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
    );
    return res.status(202).json(
      withTerminalResultReceipt(
        {
          ...httpAcceptedPayload({ callbackPersisted: false }),
          reason: 'voice_task_updated',
        },
        terminalResultReceipt,
      ),
    );
  }

  let messages = [];
  try {
    if (typeof db.getMessages === 'function') {
      messages =
        (await db.getMessages(
          { user: userId, conversationId },
          'messageId parentMessageId text content unfinished error isCreatedByUser createdAt updatedAt metadata',
        )) ?? [];
    }
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Failed loading prior callback messages:',
      sanitizeCallbackErrorForLog(err),
    );
  }

  if (hasPersistedCallback(messages, callbackBody)) {
    const persistedMessage = persistedCallbackMessage(messages, callbackBody);
    let deliverySummary;
    try {
      deliverySummary = await runTerminalEffect((effectFence, effectSession) =>
        repairDuplicateSurfaceDelivery({
          body: callbackBody,
          messages,
          text,
          fullText,
          deliveryContext,
          effectFence,
          effectSession,
        }),
      );
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
      await runTerminalEffect(() =>
        touchCallbackConversation({
          userId,
          conversationId,
          updatedAt: persistedMessage?.updatedAt || persistedMessage?.createdAt || new Date(),
        }),
      );
      await runTerminalEffect((effectFence) =>
        recordWebOnlyCallbackDelivery({
          deliveryContext,
          deliverySummary,
          body: callbackBody,
          effectFence,
        }),
      );
    } catch (err) {
      if (err instanceof TerminalCallbackEffectFenceError) throw err;
      logger.warn(
        '[VIVENTIUM][glasshive] Failed to repair duplicate callback delivery:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(500).json({ error: 'delivery_enqueue_failed' });
    }
    return res.json(
      withTerminalResultReceipt(
        httpAcceptedPayload({
          messageId: persistedMessage?.messageId || null,
          updated: true,
          duplicate: true,
          deliverySummary,
        }),
        terminalResultReceipt,
      ),
    );
  }
  if (!messageById(messages, anchorMessageId)) {
    return res.status(425).json({ error: 'callback_anchor_not_ready' });
  }

  const priorStatusCandidate = latestPriorGlassHiveStatusMessage(messages, callbackBody);
  const parentResolution = resolveCallbackTreeParentMessageId({
    messages,
    requestedParentMessageId,
    anchorMessageId,
    priorStatusMessage: priorStatusCandidate,
    body: callbackBody,
  });
  const currentLeafMessage = parentResolution.currentLeaf?.message;
  const currentLeafId = String(parentResolution.currentLeaf?.messageId || '');
  if (parentResolution.blockedByActivePlaceholder) {
    return res.status(425).json({ error: 'callback_conversation_tip_not_ready' });
  }
  if (
    currentLeafMessage?.isCreatedByUser === true &&
    currentLeafId !== requestedParentMessageId &&
    currentLeafId !== anchorMessageId
  ) {
    // The conversation has genuinely moved on. Replaying 425 can never repair that state and
    // strands terminal evidence forever. Account for the callback now; Main/Phase-B decides
    // whether to author a separate continuation against the new leaf or stay silent.
    try {
      await runTerminalEffect((effectFence) =>
        reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
      );
    } catch (err) {
      if (err instanceof TerminalCallbackEffectFenceError) throw err;
      logger.warn(
        '[VIVENTIUM][glasshive] Moved-on callback reconciliation failed:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(503).json({ error: 'callback_reconciliation_failed' });
    }
    return res.status(202).json(
      withTerminalResultReceipt(
        {
          ...httpAcceptedPayload({ callbackPersisted: true }),
          reason: 'conversation_moved_on',
        },
        terminalResultReceipt,
      ),
    );
  }
  const priorStatusMessage = parentResolution.updateMessage;
  const parentMessageId = parentResolution.parentMessageId;
  const messageId = priorStatusMessage?.messageId || crypto.randomUUID();
  const metadata = buildCallbackMetadata({
    body: callbackBody,
    parentMessageId: requestedParentMessageId,
    treeParentMessageId: parentMessageId,
    requestedParentMessageId,
    anchorMessageId,
    previousMetadata: priorStatusMessage?.metadata,
    hasFullText: Boolean(fullText),
    deliveryContext,
  });
  if (voiceTask) {
    metadata.viventium = {
      ...metadata.viventium,
      callSessionId: voiceTask.callSessionId,
      voiceTaskId: voiceTask.taskId,
      memoryDeferredPostCall: true,
      memoryEligible: false,
    };
  }
  const timestamps = callbackMessageTimestamps({
    messages,
    requestedParentMessageId,
    priorStatusMessage,
  });
  const followUpMessage = {
    messageId,
    conversationId,
    parentMessageId,
    sender: 'AI',
    endpoint: 'agents',
    model: String(callbackBody.agent_id || ''),
    agent_id: String(callbackBody.agent_id || ''),
    text,
    content: callbackContent(text),
    isCreatedByUser: false,
    unfinished: false,
    error: false,
    metadata,
    ...timestamps,
  };

  if (voiceTask && (await isGlassHiveVoiceTaskSuppressed(voiceTask))) {
    return res
      .status(202)
      .json(
        withTerminalResultReceipt(
          { status: 'suppressed', reason: 'voice_task_cancelled' },
          terminalResultReceipt,
        ),
      );
  }
  try {
    if (priorStatusMessage && typeof db.updateMessage === 'function') {
      await runTerminalEffect(() =>
        db.updateMessage({ user: { id: userId } }, followUpMessage, {
          context: 'viventium/routes/glasshive.callback.update',
          overrideTimestamp: true,
        }),
      );
    } else {
      await runTerminalEffect(() =>
        db.saveMessage({ user: { id: userId } }, followUpMessage, {
          context: 'viventium/routes/glasshive.callback',
        }),
      );
    }
    await runTerminalEffect(() =>
      touchCallbackConversation({
        userId,
        conversationId,
        updatedAt: timestamps.updatedAt,
      }),
    );
    if (voiceTask && (await isGlassHiveVoiceTaskSuppressed(voiceTask))) {
      await runTerminalEffect(() =>
        rollbackSuppressedVoiceCallback({
          priorStatusMessage,
          followUpMessage,
          userId,
          conversationId,
        }),
      );
      return res
        .status(202)
        .json(
          withTerminalResultReceipt(
            { status: 'suppressed', reason: 'voice_task_cancelled' },
            terminalResultReceipt,
          ),
        );
    }
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError) throw err;
    logger.warn(
      '[VIVENTIUM][glasshive] Failed to persist callback message:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(500).json({ error: 'persist_failed' });
  }

  if (voiceTask && (await isGlassHiveVoiceTaskSuppressed(voiceTask))) {
    return res
      .status(202)
      .json(
        withTerminalResultReceipt(
          { status: 'suppressed', reason: 'voice_task_cancelled' },
          terminalResultReceipt,
        ),
      );
  }
  await runTerminalEffect(() =>
    runVoiceTaskTerminalCallbackMutation(voiceTask?.taskId, () =>
      applyGlassHiveVoiceTaskCallback(callbackBody, voiceTask, {
        resultMessageId: messageId,
      }),
    ),
  );

  let deliverySummary;
  try {
    if (voiceTask && (await isGlassHiveVoiceTaskSuppressed(voiceTask))) {
      return res
        .status(202)
        .json(
          withTerminalResultReceipt(
            { status: 'suppressed', reason: 'voice_task_cancelled' },
            terminalResultReceipt,
          ),
        );
    }
    deliverySummary = await runTerminalEffect((effectFence, effectSession) =>
      enqueueSurfaceDeliveryOrThrow({
        body: callbackBody,
        message: followUpMessage,
        text,
        fullText,
        deliveryContext,
        effectFence,
        effectSession,
      }),
    );
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError) throw err;
    logger.warn(
      '[VIVENTIUM][glasshive] Failed to enqueue callback delivery:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(500).json({ error: 'delivery_enqueue_failed' });
  }

  try {
    await runTerminalEffect((effectFence) =>
      reconcileCallbackExternalWork({ deliveryContext, body: callbackBody, effectFence }),
    );
    await runTerminalEffect((effectFence) =>
      recordWebOnlyCallbackDelivery({
        deliveryContext,
        deliverySummary,
        body: callbackBody,
        effectFence,
      }),
    );
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError) throw err;
    logger.warn(
      '[VIVENTIUM][glasshive] Failed to reconcile scheduled external work:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(503).json({ error: 'callback_reconciliation_failed' });
  }

  return res.json(
    withTerminalResultReceipt(
      httpAcceptedPayload({
        messageId,
        updated: Boolean(priorStatusMessage),
        deliverySummary,
      }),
      terminalResultReceipt,
    ),
  );
}

router.post('/callback', async (req, res, next) => {
  try {
    return await handleGlassHiveCallback(req, res);
  } catch (err) {
    if (err instanceof TerminalCallbackEffectFenceError && !res.headersSent) {
      if ('receipt' in err.gate) {
        return res.status(err.gate.httpStatus).json(err.gate.receipt);
      }
      return res.status(err.gate.httpStatus).json({ error: err.gate.error });
    }
    return next(err);
  } finally {
    try {
      await res.locals.releaseGlassHiveTerminalEffectLease?.();
    } catch (err) {
      logger.warn(
        '[VIVENTIUM][glasshive] Terminal callback effect lease release unavailable:',
        sanitizeCallbackErrorForLog(err),
      );
    }
  }
});

module.exports = router;
