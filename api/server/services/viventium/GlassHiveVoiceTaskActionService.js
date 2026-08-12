/* === VIVENTIUM START ===
 * Feature: capability-scoped GlassHive voice task actions
 * Purpose: Bind signed, exact-run retry/cancel capabilities to the authoritative voice task
 * without persisting, logging, or relaying the opaque capability token.
 * === VIVENTIUM END === */

const { registerVoiceTaskOwnerAdapter } = require('./VoiceTaskService');

const ACTION_PATH = '/v1/run-actions';
const ACTION_TIMEOUT_MS = 5000;
const MAX_ACTION_RESPONSE_BYTES = 16 * 1024;
const MAX_CAPABILITIES = 4;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function safeId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_ID_PATTERN.test(text) ? text : '';
}

function safeCapabilityToken(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const hasControlCharacter = Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return text && text.length <= 4096 && !hasControlCharacter ? text : '';
}

function configuredActionUrl() {
  const configured = String(process.env.GLASSHIVE_PROVIDER_BASE_URL || '').trim();
  if (!configured || configured.includes('${')) {
    return '';
  }
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return new URL(ACTION_PATH, parsed.origin).toString();
  } catch {
    return '';
  }
}

function validateCapability(input, body, expectedAction) {
  if (!input || typeof input !== 'object' || input.version !== 1) {
    return null;
  }
  const action = String(input.action || '').trim();
  const operation = String(input.operation || '').trim();
  const expectedOperation = expectedAction === 'retry' ? 'workspace_continue' : 'cancel';
  const capabilityId = safeId(input.capabilityId);
  const projectId = safeId(input.projectId);
  const workerId = safeId(input.workerId);
  const runId = safeId(input.runId);
  const token = safeCapabilityToken(input.capability);
  const expiresAtMs = Date.parse(String(input.expiresAt || ''));
  if (
    action !== expectedAction ||
    operation !== expectedOperation ||
    String(input.endpoint || '').trim() !== ACTION_PATH ||
    !capabilityId ||
    !projectId ||
    !workerId ||
    !runId ||
    workerId !== safeId(body.worker_id) ||
    runId !== safeId(body.run_id) ||
    !token ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    return null;
  }
  return {
    capabilityId,
    action,
    projectId,
    workerId,
    runId,
    expiresAtMs,
    token,
  };
}

async function invokeCapability({ capability, operationId, fetchImpl, actionUrl }) {
  if (capability.expiresAtMs <= Date.now()) {
    throw new Error('action_capability_expired');
  }
  const response = await fetchImpl(actionUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-Viventium-Action-Capability': capability.token,
    },
    body: JSON.stringify({
      version: 1,
      capabilityId: capability.capabilityId,
      action: capability.action,
      projectId: capability.projectId,
      workerId: capability.workerId,
      runId: capability.runId,
      idempotencyKey: operationId,
    }),
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) }
      : {}),
  });
  const responseStatus = Number(response?.status);
  if (responseStatus !== 202 && responseStatus !== 409) {
    throw new Error('glasshive_action_rejected');
  }
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (
    !contentType.startsWith('application/json') ||
    (Number.isFinite(contentLength) && contentLength > MAX_ACTION_RESPONSE_BYTES)
  ) {
    throw new Error('glasshive_action_response_invalid');
  }
  const rawResult = await response.text();
  if (Buffer.byteLength(rawResult, 'utf8') > MAX_ACTION_RESPONSE_BYTES) {
    throw new Error('glasshive_action_response_oversized');
  }
  let result;
  try {
    result = JSON.parse(rawResult);
  } catch {
    throw new Error('glasshive_action_response_invalid');
  }
  if (
    !result ||
    result.version !== 1 ||
    result.action !== capability.action ||
    result.projectId !== capability.projectId ||
    result.workerId !== capability.workerId ||
    result.sourceRunId !== capability.runId
  ) {
    throw new Error('glasshive_action_response_mismatch');
  }
  if (
    responseStatus === 409 &&
    capability.action === 'cancel' &&
    result.status === 'already_completed' &&
    result.state === 'completed'
  ) {
    return { accepted: false, alreadyCompleted: true, phase: 'already_completed' };
  }
  if (responseStatus !== 202) {
    throw new Error('glasshive_action_rejected');
  }
  if (capability.action === 'cancel') {
    if (
      !['accepted', 'pending'].includes(result.status) ||
      result.confirmationPending !== true ||
      result.newRun != null
    ) {
      throw new Error('glasshive_cancel_not_accepted');
    }
    return { accepted: true, phase: 'cancelling' };
  }
  const newRunProjectId = safeId(result?.newRun?.projectId);
  const newRunWorkerId = safeId(result?.newRun?.workerId);
  const newRunId = safeId(result?.newRun?.runId);
  if (
    result.status !== 'queued' ||
    newRunProjectId !== capability.projectId ||
    newRunWorkerId !== capability.workerId ||
    !newRunId
  ) {
    throw new Error('glasshive_retry_not_queued');
  }
  return {
    accepted: true,
    phase: 'starting',
    streamId: `glasshive:${newRunId}`,
    ownerId: newRunId,
  };
}

function registerGlassHiveVoiceTaskActionCapabilities({
  body = {},
  task,
  fetchImpl = globalThis.fetch,
}) {
  if (!task?.taskId || task.owner?.kind !== 'glasshive_run' || typeof fetchImpl !== 'function') {
    return { cancel: false, retry: false };
  }
  const event = String(body.event || '').trim();
  if (event !== 'run.started' && event !== 'run.failed') {
    return { cancel: false, retry: false };
  }
  const actionUrl = configuredActionUrl();
  const capabilities = Array.isArray(body.actionCapabilities)
    ? body.actionCapabilities.slice(0, MAX_CAPABILITIES)
    : [];
  const cancelCapability =
    event === 'run.started'
      ? capabilities.map((item) => validateCapability(item, body, 'cancel')).find(Boolean) || null
      : null;
  const retryCapability =
    event === 'run.failed' && body.failure_retryable === true
      ? capabilities.map((item) => validateCapability(item, body, 'retry')).find(Boolean) || null
      : null;
  const usableCancel = actionUrl && cancelCapability ? cancelCapability : null;
  const usableRetry = actionUrl && retryCapability ? retryCapability : null;
  const expiryValues = [usableCancel?.expiresAtMs, usableRetry?.expiresAtMs].filter(
    Number.isFinite,
  );

  registerVoiceTaskOwnerAdapter(task.taskId, {
    kind: 'glasshive_run',
    ...(usableCancel
      ? {
          cancel: ({ operationId }) =>
            invokeCapability({
              capability: usableCancel,
              operationId,
              fetchImpl,
              actionUrl,
            }),
        }
      : {}),
    ...(usableRetry
      ? {
          retry: ({ operationId }) =>
            invokeCapability({
              capability: usableRetry,
              operationId,
              fetchImpl,
              actionUrl,
            }),
        }
      : {}),
    cancellationConfirmable: Boolean(usableCancel),
    ...(expiryValues.length > 0 ? { expiresAtMs: Math.min(...expiryValues) } : {}),
  });

  return { cancel: Boolean(usableCancel), retry: Boolean(usableRetry) };
}

module.exports = {
  registerGlassHiveVoiceTaskActionCapabilities,
};
