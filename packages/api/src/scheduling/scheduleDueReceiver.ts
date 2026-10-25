/* === VIVENTIUM START === Application-owned scheduled Main admission. === */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { ScheduledTaskSource } from './scheduledTaskSource';
import { scheduleDueUnknownRecovery } from './scheduleDueRecovery';

export interface ScheduledDestination {
  surface: 'librechat' | 'telegram' | 'voice';
  voiceCallSessionId?: string;
  voiceRequestId?: string;
  telegramChatId?: string;
  telegramUserId?: string;
  telegramMessageThreadId?: string;
}

export interface ScheduledConversationBinding {
  _id: string;
  kind: 'schedule_binding';
  ownerId: string;
  tenantId: string;
  conversationId: string;
  conversationPolicy?: 'same' | 'new';
  sourceConversationId?: string;
  taskText?: string;
  taskSource?: ScheduledTaskSource;
  destinations: ScheduledDestination[];
  sourceEventId: string;
  active: boolean;
  createdAt: Date;
}

export interface ScheduleDueEnvelope {
  type: 'schedule.due';
  instruction?: string;
  schedule_id: string;
  schedule_version: number;
  occurrence_id: string;
  scheduled_at: string;
  expires_at: string;
  principal: { tenant_id: string; owner_id: string };
  request_data: { request_ref: string };
}

export interface ScheduleDueAdmission {
  _id: string;
  kind: 'schedule_due';
  userId: string;
  idempotencyKey: string;
  streamId: string;
  conversationId: string;
  conversationPolicy?: 'same' | 'new';
  status: 'reserved' | 'accepted';
  dueState:
    | 'admitted'
    | 'dispatching'
    | 'running'
    | 'delivery_queued'
    | 'silent'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  eventId: string;
  requestDigest: string;
  envelope: ScheduleDueEnvelope;
  bindingRef: string;
  admittedAt: Date;
  updatedAt: Date;
  leaseUntil?: Date;
  claimToken?: string;
  failureCode?: string;
  resultMessageId?: string;
  nextAttemptAt?: Date;
  resultRecoveryAttempts?: number;
  resultRecoveryExhaustedAt?: Date;
  resultRecoveryDiagnostic?: string;
}

export interface ScheduleDueStore {
  readBinding(ref: string): Promise<ScheduledConversationBinding | null>;
  saveBinding(binding: ScheduledConversationBinding): Promise<ScheduledConversationBinding>;
  readAdmission(id: string): Promise<ScheduleDueAdmission | null>;
  insertAdmission(admission: ScheduleDueAdmission): Promise<ScheduleDueAdmission>;
}

export class ScheduleDueError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = 'ScheduleDueError';
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const boundedId = (value: string) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f\x7f]/.test(value);

export function parseScheduleDueEnvelope(raw: Buffer): ScheduleDueEnvelope {
  let body: ScheduleDueEnvelope;
  try {
    body = JSON.parse(raw.toString('utf8')) as ScheduleDueEnvelope;
  } catch {
    throw new ScheduleDueError('schedule_due_body_invalid', 400);
  }
  const scheduled = Date.parse(body?.scheduled_at);
  const expires = Date.parse(body?.expires_at);
  if (
    body?.type !== 'schedule.due' ||
    !boundedId(body.schedule_id) ||
    !boundedId(body.occurrence_id) ||
    !Number.isSafeInteger(body.schedule_version) ||
    body.schedule_version < 1 ||
    (body.instruction != null &&
      (typeof body.instruction !== 'string' || body.instruction.length > 200_000)) ||
    !Number.isFinite(scheduled) ||
    !Number.isFinite(expires) ||
    expires < scheduled ||
    !boundedId(body.principal?.tenant_id) ||
    !boundedId(body.principal?.owner_id) ||
    !boundedId(body.request_data?.request_ref) ||
    Object.keys(body.request_data).some((key) => key !== 'request_ref')
  ) {
    throw new ScheduleDueError('schedule_due_body_invalid', 400);
  }
  return body;
}

export function verifyScheduleDueSignature({
  rawBody,
  eventId,
  timestamp,
  signature,
  secrets,
  nowMs = Date.now(),
}: {
  rawBody: Buffer;
  eventId: string;
  timestamp: string;
  signature: string;
  secrets: readonly string[];
  nowMs?: number;
}): void {
  if (!secrets.length) throw new ScheduleDueError('schedule_due_not_configured', 503);
  if (rawBody.length > 64 * 1024) throw new ScheduleDueError('schedule_due_body_too_large', 413);
  const seconds = Number(timestamp);
  if (
    !boundedId(eventId) ||
    !/^\d{1,12}$/.test(timestamp) ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(nowMs / 1000 - seconds) > 300
  ) {
    throw new ScheduleDueError('schedule_due_signature_invalid', 401);
  }
  const signatures = signature
    .split(' ')
    .slice(0, 8)
    .filter((value) => value.startsWith('v1,'));
  const matches = secrets.some((secret) => {
    const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const key = Buffer.from(encoded, 'base64');
    if (key.length < 24) return false;
    const expected = createHmac('sha256', key)
      .update(`${eventId}.${timestamp}.`)
      .update(rawBody)
      .digest();
    return signatures.some((value) => {
      const supplied = Buffer.from(value.slice(3), 'base64');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
  });
  if (!matches) throw new ScheduleDueError('schedule_due_signature_invalid', 401);
}

export function scheduleDueDispatchIdentity(envelope: ScheduleDueEnvelope) {
  const idempotencyKey = `xperfect-due:${hash(
    JSON.stringify([
      envelope.principal.tenant_id,
      envelope.principal.owner_id,
      envelope.occurrence_id,
    ]),
  )}`;
  const documentId = hash(`${envelope.principal.owner_id}\0${idempotencyKey}`);
  return {
    documentId,
    idempotencyKey,
    streamId: `scheduler-${hash(documentId).slice(0, 32)}`,
  };
}

export function createScheduleDueReceiver({
  store,
  tenantId,
  authorizeBinding,
  now = () => new Date(),
}: {
  store: ScheduleDueStore;
  tenantId: string;
  authorizeBinding(binding: ScheduledConversationBinding): Promise<boolean>;
  now?: () => Date;
}) {
  async function admit(rawBody: Buffer, eventId: string) {
    const envelope = parseScheduleDueEnvelope(rawBody);
    if (envelope.principal.tenant_id !== tenantId) {
      throw new ScheduleDueError('schedule_due_owner_mismatch', 403);
    }
    const identity = scheduleDueDispatchIdentity(envelope);
    const digest = hash(rawBody.toString('base64'));
    const prior = await store.readAdmission(identity.documentId);
    if (prior) {
      if (prior.requestDigest !== digest || prior.eventId !== eventId) {
        throw new ScheduleDueError('schedule_due_identity_conflict', 409);
      }
      return { admission: prior, duplicate: true };
    }
    const current = now();
    if (Date.parse(envelope.scheduled_at) > current.getTime() + 5_000) {
      throw new ScheduleDueError('schedule_due_not_yet_due', 425);
    }
    if (Date.parse(envelope.expires_at) <= current.getTime()) {
      throw new ScheduleDueError('schedule_due_expired', 410);
    }
    const binding = await store.readBinding(envelope.request_data.request_ref);
    if (
      !binding ||
      !binding.active ||
      binding.kind !== 'schedule_binding' ||
      binding.ownerId !== envelope.principal.owner_id ||
      binding.tenantId !== tenantId ||
      !(await authorizeBinding(binding))
    ) {
      throw new ScheduleDueError('schedule_due_binding_unavailable', 403);
    }
    const candidate: ScheduleDueAdmission = {
      _id: identity.documentId,
      kind: 'schedule_due',
      userId: binding.ownerId,
      idempotencyKey: identity.idempotencyKey,
      streamId: identity.streamId,
      conversationId: binding.conversationPolicy === 'new' ? 'new' : binding.conversationId,
      conversationPolicy: binding.conversationPolicy || 'same',
      status: 'reserved',
      dueState: 'admitted',
      eventId,
      requestDigest: digest,
      envelope,
      bindingRef: binding._id,
      admittedAt: current,
      updatedAt: current,
    };
    const admission = await store.insertAdmission(candidate);
    if (admission.requestDigest !== digest || admission.eventId !== eventId) {
      throw new ScheduleDueError('schedule_due_identity_conflict', 409);
    }
    return { admission, duplicate: admission.admittedAt.getTime() !== current.getTime() };
  }
  return { admit };
}

export async function ensureScheduledConversationBinding({
  store,
  tenantId,
  ownerId,
  conversationId,
  conversationPolicy = 'same',
  sourceConversationId = conversationId,
  taskText,
  taskSource,
  sourceEventId,
  destinations,
}: {
  store: ScheduleDueStore;
  tenantId: string;
  ownerId: string;
  conversationId: string;
  conversationPolicy?: 'same' | 'new';
  sourceConversationId?: string;
  taskText: string;
  taskSource?: ScheduledTaskSource;
  sourceEventId: string;
  destinations: ScheduledDestination[];
}): Promise<ScheduledConversationBinding> {
  if (
    ![tenantId, ownerId, conversationId, sourceConversationId, sourceEventId].every(boundedId) ||
    conversationId === 'new' ||
    !['same', 'new'].includes(conversationPolicy) ||
    typeof taskText !== 'string' ||
    !taskText.trim() ||
    (!taskSource && taskText.length > 100_000) ||
    (taskSource &&
      (!Array.isArray(taskSource.messageIds) ||
        !taskSource.messageIds.length ||
        taskSource.messageIds.length > 32 ||
        !taskSource.messageIds.every(boundedId) ||
        new Set(taskSource.messageIds).size !== taskSource.messageIds.length ||
        !/^[a-f0-9]{64}$/.test(taskSource.sha256))) ||
    !destinations.length ||
    destinations.some((item) => !['librechat', 'telegram'].includes(item.surface))
  ) {
    throw new ScheduleDueError('schedule_binding_invalid', 400);
  }
  const identity = JSON.stringify([
    tenantId,
    ownerId,
    conversationId,
    conversationPolicy,
    sourceConversationId,
    taskSource ? taskSource.messageIds : sourceEventId,
    destinations,
  ]);
  return store.saveBinding({
    _id: `vsch_${hash(identity)}`,
    kind: 'schedule_binding',
    tenantId,
    ownerId,
    conversationId,
    conversationPolicy,
    sourceConversationId,
    ...(taskSource ? { taskSource } : { taskText }),
    sourceEventId,
    destinations,
    active: true,
    createdAt: new Date(),
  });
}
/* === VIVENTIUM END === */

export function createScheduleDueDispatcher({
  claim,
  readBinding,
  authorizeBinding,
  dispatch,
  readResult,
  present,
  update,
  release,
}: {
  claim(): Promise<ScheduleDueAdmission | null>;
  readBinding(ref: string): Promise<ScheduledConversationBinding | null>;
  authorizeBinding(binding: ScheduledConversationBinding): Promise<boolean>;
  dispatch(
    admission: ScheduleDueAdmission,
    binding: ScheduledConversationBinding,
  ): Promise<{
    streamId: string;
    conversationId: string;
    deferred?: boolean;
  }>;
  readResult(admission: ScheduleDueAdmission): Promise<{
    state: 'pending' | 'complete' | 'failed' | 'unknown';
    messageId?: string;
    failureCode?: string;
  }>;
  present(
    admission: ScheduleDueAdmission,
    binding: ScheduledConversationBinding,
    messageId: string,
  ): Promise<{ silent?: boolean }>;
  update(admission: ScheduleDueAdmission, patch: Partial<ScheduleDueAdmission>): Promise<void>;
  release(admission: ScheduleDueAdmission): Promise<void>;
}) {
  async function processOne(): Promise<boolean> {
    const admission = await claim();
    if (!admission) return false;
    try {
      const binding = await readBinding(admission.bindingRef);
      if (
        !binding ||
        !binding.active ||
        binding.ownerId !== admission.userId ||
        binding.tenantId !== admission.envelope.principal.tenant_id ||
        !(await authorizeBinding(binding))
      ) {
        await update(admission, {
          dueState: 'cancelled',
          failureCode: 'schedule_due_binding_revoked',
        });
        return true;
      }
      if (admission.status !== 'accepted') {
        const receipt = await dispatch(admission, binding);
        if (receipt.deferred) return true;
        admission.status = 'accepted';
        admission.streamId = receipt.streamId;
        admission.conversationId = receipt.conversationId;
        await update(admission, {
          status: 'accepted',
          dueState: 'running',
          streamId: receipt.streamId,
          conversationId: receipt.conversationId,
        });
      }
      const result = await readResult(admission);
      if (result.state === 'pending') return true;
      if (result.state !== 'complete') {
        await update(admission, {
          dueState: result.state === 'unknown' ? 'unknown' : 'failed',
          failureCode: result.failureCode || 'scheduled_execution_failed',
          ...(result.state === 'unknown' ? scheduleDueUnknownRecovery(admission) : {}),
        });
        return true;
      }
      if (admission.dueState === 'unknown' && result.messageId) {
        // A canonical saved result resolves the former transient unknown state.
        // Restore its normal presentation state before the existing proof rechecks it.
        admission.dueState = 'running';
        await update(admission, { dueState: 'running' });
      }
      const presentation = result.messageId
        ? await present(admission, binding, result.messageId)
        : null;
      await update(admission, {
        dueState: presentation?.silent ? 'silent' : 'delivery_queued',
        resultMessageId: result.messageId,
        failureCode: '',
      });
      return true;
    } catch (error) {
      if (
        error instanceof ScheduleDueError &&
        error.status === 409 &&
        error.code === 'schedule_task_source_unavailable'
      ) {
        await update(admission, { dueState: 'failed', failureCode: error.code });
      }
      throw error;
    } finally {
      await release(admission);
    }
  }
  let running = false;
  async function reconcile(limit = 16): Promise<void> {
    if (running) return;
    running = true;
    try {
      let failure: Error | undefined;
      for (let count = 0; count < limit; count += 4) {
        const results = await Promise.allSettled(
          Array.from({ length: Math.min(4, limit - count) }, processOne),
        );
        for (const result of results) {
          if (result.status === 'rejected' && !failure) {
            failure =
              result.reason instanceof Error
                ? result.reason
                : new Error('schedule_due_recovery_unavailable');
          }
        }
        if (!results.some((result) => result.status === 'fulfilled' && result.value)) break;
      }
      if (failure) throw failure;
    } finally {
      running = false;
    }
  }
  return { reconcile, processOne };
}
