/* === VIVENTIUM START ===
 * Feature: Shared owner-scoped GlassHive work action executor.
 * Purpose: Keep every conversational surface on one trusted action, refresh, receipt, and trace
 * path while database and host adapters remain outside the package core.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import { safeErrorCode } from '../logging/safeError';

type UnknownRecord = Record<string, unknown>;

export interface DurableActionEffectContext {
  streamId?: unknown;
  sourceEventId?: unknown;
  sourceRevision?: unknown;
  sourceSurface?: unknown;
  responseMessageId?: unknown;
}

export interface GlassHiveWorkActionInput {
  ownerId?: unknown;
  workRef?: unknown;
  action?: unknown;
  instruction?: unknown;
  operationId?: unknown;
  sourceSurface?: unknown;
  durableEffectContext?: DurableActionEffectContext;
}

interface GenerationJobManagerAdapter {
  markDurableEffectReceipt(input: UnknownRecord): Promise<unknown>;
  getJob(streamId: string): Promise<unknown>;
}

interface LoggerAdapter {
  warn(message: string, fields: UnknownRecord): void;
}

export interface GlassHiveWorkActionDependencies {
  GenerationJobManager: GenerationJobManagerAdapter;
  logger: LoggerAdapter;
  buildTrustedActionIdempotencyKey(input: UnknownRecord): string;
  getActiveWorkSnapshot(input: UnknownRecord): Promise<unknown>;
  invalidateActiveWorkSnapshot(input: UnknownRecord): unknown;
  requestAccountApi(input: UnknownRecord): Promise<unknown>;
  reauthorizeCapabilityAuthorization(input: UnknownRecord): Promise<unknown>;
  dismissCoreOnlyPreDispatchAttention(input: UnknownRecord): Promise<unknown>;
  getCoreWorkDelivery(input: UnknownRecord): Promise<unknown>;
  getCoreWorkOriginRef(input: UnknownRecord): Promise<unknown>;
  recordVoiceOrchestrationTraceBestEffort(input: UnknownRecord): Promise<unknown>;
}

const REAUTH_ACTIONS = new Set(['resume']);
const REAUTH_FAILURE_CODES = new Set(['capability_authorization_horizon_expired']);
const DISMISS_SAFE_DELIVERY_STATES = new Set(['delivered', 'acknowledged', 'silent']);
const RUN_PRODUCING_ACTIONS = new Set(['queue', 'message', 'steer', 'retry']);
const ACTION_SOURCE_SURFACES = new Set([
  'web',
  'chat',
  'desktop',
  'telegram',
  'voice',
  'workbench',
  'scheduler',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function normalizedText(value: unknown): string {
  return String(value || '').trim();
}

function actionSourceRef(prefix: string, values: unknown[]): string {
  return `${prefix}_${crypto
    .createHash('sha256')
    .update(values.map((value) => String(value || '')).join('\0'), 'utf8')
    .digest('hex')}`;
}

export function needsCapabilityReauthorization(detail: unknown = {}): boolean {
  const row = recordFrom(detail);
  const attention = recordFrom(row.attention);
  const failure = recordFrom(row.failure);
  const code = String(attention.code || row.failureCode || row.failureClass || failure.code || '')
    .trim()
    .toLowerCase();
  return REAUTH_FAILURE_CODES.has(code);
}

export function createGlassHiveWorkActionService(deps: GlassHiveWorkActionDependencies) {
  async function trustedActionSourceContext({
    ownerId,
    workRef,
    action,
    operationId,
    sourceSurface,
    durableEffectContext,
  }: GlassHiveWorkActionInput): Promise<UnknownRecord | null> {
    const actionName = normalizedText(action).toLowerCase();
    if (!RUN_PRODUCING_ACTIONS.has(actionName)) return null;
    const originRef = normalizedText(await deps.getCoreWorkOriginRef({ ownerId, workRef }));
    if (!originRef) {
      throw Object.assign(new Error('glasshive_action_origin_unavailable'), {
        code: 'glasshive_action_origin_unavailable',
        status: 409,
      });
    }
    let surface: string;
    let sourceAnchor = '';
    let sourceRevision = 1;
    if (durableEffectContext) {
      surface = normalizedText(durableEffectContext.sourceSurface).toLowerCase();
      sourceAnchor = normalizedText(durableEffectContext.sourceEventId);
      sourceRevision = Number(durableEffectContext.sourceRevision);
      if (
        !ACTION_SOURCE_SURFACES.has(surface) ||
        !sourceAnchor ||
        !Number.isSafeInteger(sourceRevision) ||
        sourceRevision < 1
      ) {
        throw Object.assign(new Error('glasshive_action_source_context_unavailable'), {
          code: 'glasshive_action_source_context_unavailable',
          status: 409,
        });
      }
    } else {
      const requestedSurface = normalizedText(sourceSurface).toLowerCase();
      surface = ACTION_SOURCE_SURFACES.has(requestedSurface) ? requestedSurface : 'web';
    }
    const identity = [ownerId, workRef, actionName, operationId, surface];
    return {
      version: 1,
      originRef,
      sourceEventId: actionSourceRef('work_action_event', [...identity, sourceAnchor]),
      sourceRevision,
      surface,
      outputContract: { mode: 'inherit' },
    };
  }

  async function bindDurableActionReceipt({
    ownerId,
    workRef,
    action,
    operationId,
    durableEffectContext,
  }: GlassHiveWorkActionInput): Promise<{ effectRef: string; marked: boolean } | null> {
    if (!durableEffectContext) return null;
    const effectRef = `work_action_${crypto
      .createHash('sha256')
      .update(
        `${String(workRef || '')}\0${String(action || '')}\0${String(operationId || '')}`,
        'utf8',
      )
      .digest('hex')}`;
    const marked = Boolean(
      await deps.GenerationJobManager.markDurableEffectReceipt({
        streamId: normalizedText(durableEffectContext.streamId),
        userId: normalizedText(ownerId),
        sourceEventId: normalizedText(durableEffectContext.sourceEventId),
        responseMessageId: normalizedText(durableEffectContext.responseMessageId),
        effectKind: 'durable_work_action_accepted',
        effectRef,
      }).catch(() => false),
    );
    if (!marked) {
      deps.logger.warn(
        '[VIVENTIUM][parallel-work] Existing-work action succeeded but its exact presentation receipt could not be bound',
        { code: 'action_receipt_binding_failed', stage: 'action_receipt_binding' },
      );
    }
    return { effectRef, marked };
  }

  async function traceAcceptedVoiceAction({
    ownerId,
    workRef,
    action,
    operationId,
    durableEffectContext,
    receipt,
  }: GlassHiveWorkActionInput & {
    receipt: { effectRef: string; marked: boolean } | null;
  }): Promise<void> {
    const streamId = normalizedText(durableEffectContext?.streamId);
    if (!streamId || !receipt?.effectRef) return;
    try {
      const job = recordFrom(await deps.GenerationJobManager.getJob(streamId));
      const metadata = recordFrom(job.metadata);
      const interaction = recordFrom(metadata.interactionContext);
      const callSessionId = normalizedText(metadata.viventiumCallSessionId);
      const turnId = normalizedText(interaction.logical_turn_id);
      const taskId = normalizedText(metadata.viventiumVoiceTaskId);
      if (
        normalizedText(metadata.userId) !== normalizedText(ownerId) ||
        interaction.surface !== 'voice' ||
        !callSessionId ||
        !turnId
      ) {
        return;
      }
      const facts: UnknownRecord = {
        workRef,
        streamRef: streamId,
        ...(taskId ? { taskRef: taskId } : {}),
        actionRef: operationId,
        receiptRef: receipt.effectRef,
        action,
        effectCount: receipt.marked ? 1 : 0,
      };
      await deps.recordVoiceOrchestrationTraceBestEffort({
        ownerId,
        callSessionId,
        turnId,
        eventRef: operationId,
        stage: 'action.accepted',
        facts,
      });
      if (receipt.marked) {
        await deps.recordVoiceOrchestrationTraceBestEffort({
          ownerId,
          callSessionId,
          turnId,
          eventRef: receipt.effectRef,
          stage: 'control.completed',
          facts,
        });
      }
    } catch (error) {
      deps.logger.warn('[VIVENTIUM][voice-trace] accepted_action_context_unavailable', {
        code: safeErrorCode(error, 'context_unavailable'),
      });
    }
  }

  async function trustedCapabilityRefresh({
    ownerId,
    workRef,
    action,
  }: GlassHiveWorkActionInput): Promise<UnknownRecord | null> {
    if (!REAUTH_ACTIONS.has(normalizedText(action).toLowerCase())) return null;
    const detail = await deps.requestAccountApi({
      ownerId,
      path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}`,
    });
    if (!needsCapabilityReauthorization(detail)) return null;
    const refreshed = recordFrom(
      await deps.reauthorizeCapabilityAuthorization({ ownerId, workRef }),
    );
    return {
      version: 1,
      authorizationRef: refreshed.authorizationRef,
      maxExpiresAt: refreshed.maxExpiresAt,
      scopeFingerprint: refreshed.scopeFingerprint,
    };
  }

  async function executeGlassHiveWorkAction(
    input: GlassHiveWorkActionInput = {},
  ): Promise<unknown> {
    const { ownerId, workRef, instruction, operationId, sourceSurface, durableEffectContext } =
      input;
    const action = normalizedText(input.action).toLowerCase();
    if (action === 'dismiss') {
      const coreOnlyReceipt = await deps.dismissCoreOnlyPreDispatchAttention({
        ownerId,
        originRef: workRef,
        operationId,
      });
      if (coreOnlyReceipt) {
        deps.invalidateActiveWorkSnapshot({ ownerId });
        await deps.getActiveWorkSnapshot({ ownerId, forceRefresh: true });
        const receipt = await bindDurableActionReceipt(input);
        await traceAcceptedVoiceAction({ ...input, action, receipt });
        return coreOnlyReceipt;
      }
      const delivery = recordFrom(await deps.getCoreWorkDelivery({ ownerId, workRef }));
      const deliveryState = normalizedText(delivery.state).toLowerCase();
      if (!DISMISS_SAFE_DELIVERY_STATES.has(deliveryState)) {
        throw Object.assign(new Error('glasshive_dismiss_delivery_not_settled'), {
          code: 'glasshive_dismiss_delivery_not_settled',
          status: 409,
        });
      }
    }
    const capabilityReauthorization = await trustedCapabilityRefresh({ ownerId, workRef, action });
    const idempotencyKey = deps.buildTrustedActionIdempotencyKey({
      ownerId,
      workRef,
      action,
      operationId,
    });
    const sourceContext = await trustedActionSourceContext({
      ownerId,
      workRef,
      action,
      operationId,
      sourceSurface,
      durableEffectContext,
    });
    const result = await deps.requestAccountApi({
      ownerId,
      path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}/actions`,
      method: 'POST',
      body: {
        action,
        ...(instruction ? { instruction } : {}),
        idempotencyKey,
        ...(capabilityReauthorization ? { capabilityReauthorization } : {}),
        ...(sourceContext ? { sourceContext } : {}),
      },
    });
    deps.invalidateActiveWorkSnapshot({ ownerId });
    if (action === 'dismiss') {
      await deps.getActiveWorkSnapshot({ ownerId, forceRefresh: true });
    }
    const receipt = await bindDurableActionReceipt({ ...input, action });
    await traceAcceptedVoiceAction({ ...input, action, receipt });
    return result;
  }

  return { executeGlassHiveWorkAction, needsCapabilityReauthorization };
}
