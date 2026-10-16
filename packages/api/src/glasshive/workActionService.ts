/* === VIVENTIUM START ===
 * Feature: Shared owner-scoped GlassHive work action executor.
 * Purpose: Keep every conversational surface on one trusted action, refresh, receipt, and trace
 * path while database and host adapters remain outside the package core.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import { currentNativeHumanInputSource } from './sourceAuthor';
import { createAccountApiRoute } from './accountClient';
import type { VoiceWorkAuthorityBinding } from '../voice/engagementAuthority';
import type { NativeWorkInputResponse } from 'librechat-data-provider';
import { safeErrorCode } from '../logging/safeError';
import { nativeQuestionForm, nativeQuestionContent, nativeWorkInputQuestionText, nativeWorkInputResponseSchema } from './nativeWorkInput';

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
  fileIds?: string[];
  requestBody?: UnknownRecord;
  serverReq?: unknown;
  nativeInput?: NativeWorkInputResponse;
  ownerInputControl?: boolean;
  operationId?: unknown;
  sourceSurface?: unknown;
  durableEffectContext?: DurableActionEffectContext;
  voiceAuthorityContext?: { callSessionId?: unknown; binding?: VoiceWorkAuthorityBinding };
}

interface GenerationJobManagerAdapter {
  getJob(streamId: string): Promise<unknown>;
}

interface LoggerAdapter {
  warn(message: string, fields: UnknownRecord): void;
}

export interface GlassHiveWorkActionDependencies {
  GenerationJobManager: GenerationJobManagerAdapter;
  getSourceAuthorJob?: Parameters<typeof currentNativeHumanInputSource>[0]['getJob'];
  getOriginalInputReceipt?: Parameters<typeof currentNativeHumanInputSource>[0]['getOriginalInputReceipt'];
  assertVoiceWorkAuthority(
    binding: VoiceWorkAuthorityBinding | undefined,
    ownerId: string,
  ): Promise<void>;
  logger: LoggerAdapter;
  buildTrustedActionIdempotencyKey(input: UnknownRecord): string;
  getActiveWorkSnapshot(input: UnknownRecord): Promise<unknown>;
  invalidateActiveWorkSnapshot(input: UnknownRecord): unknown;
  requestAccountApi(input: UnknownRecord): Promise<unknown>;
  getActionFileSources?(input: GlassHiveWorkActionInput): Promise<ActionFileSource[]>;
  fetchImpl?: typeof globalThis.fetch;
  reauthorizeCapabilityAuthorization(input: UnknownRecord): Promise<unknown>;
  readCapabilityReauthorizationReceiptCandidate?(input: UnknownRecord): Promise<unknown>;
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

export interface ActionFileSource {
  fileId: string;
  filename: string;
  sizeBytes: number;
  inputKind: 'original' | 'extracted_text';
  mediaGroupIndex?: number;
  openStream(): Promise<AsyncIterable<Uint8Array>>;
}

export function createGlassHiveWorkActionService(deps: GlassHiveWorkActionDependencies) {
  async function prepareFileInputs(input: GlassHiveWorkActionInput, idempotencyKey: string) {
    if (!input.fileIds?.length) return [];
    if (!['steer', 'queue', 'message'].includes(String(input.action)) || new Set(input.fileIds).size !== input.fileIds.length || !deps.getActionFileSources) {
      throw new Error('active_work_file_selection_invalid');
    }
    const detail = recordFrom(await deps.requestAccountApi({ownerId: input.ownerId,
      path: `/v1/work/${encodeURIComponent(normalizedText(input.workRef))}?projection=actions`}));
    if (!Array.isArray(detail.actions) || !detail.actions.includes(String(input.action))) {
      throw new Error('active_work_action_not_available');
    }
    const sources = await deps.getActionFileSources(input);
    if (sources.length !== input.fileIds.length || sources.some((file, index) => file.fileId !== input.fileIds?.[index])) {
      throw new Error('active_work_file_selection_invalid');
    }
    const result: UnknownRecord[] = [];
    for (const file of sources) {
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of await file.openStream()) { hash.update(chunk); size += chunk.byteLength; }
      if (size !== file.sizeBytes) throw new Error('active_work_file_source_changed');
      const sha256 = hash.digest('hex');
      const uploadKey = crypto.createHash('sha256').update(JSON.stringify([idempotencyKey, file.fileId, file.filename, size, sha256, file.inputKind])).digest('hex');
      let ready = recordFrom(await deps.requestAccountApi({ownerId: input.ownerId,
        path: '/v1/file-uploads', method: 'POST', body: {
          draft_id: `action-${crypto.createHash('sha256').update(idempotencyKey).digest('hex')}`,
          name: file.filename, size_bytes: size, idempotency_key: uploadKey,
        }}));
      const uploadId = normalizedText(ready.upload_id);
      if (!/^fil_[A-Za-z0-9]+$/.test(uploadId)) throw new Error('active_work_upload_receipt_invalid');
      if (ready.state !== 'ready') {
        const iterator = (await file.openStream())[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close(); else controller.enqueue(next.value);
          },
          async cancel() { await iterator.return?.(); },
        });
        const route = createAccountApiRoute({ ownerId: input.ownerId });
        const response = await (deps.fetchImpl || globalThis.fetch)(`${route.baseURL}file-uploads/${uploadId}/content`, {
          method: 'PUT', redirect: 'error', headers: {...route.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size)},
          body, signal: AbortSignal.timeout(15000), ...{duplex: 'half'},
        });
        if (!response.ok) throw new Error('active_work_upload_rejected');
        ready = recordFrom(await response.json());
      }
      if (ready.state !== 'ready' || ready.upload_id !== uploadId || ready.sha256 !== sha256 ||
          ready.size_bytes !== size || ready.name !== file.filename || !normalizedText(ready.revision)) {
        throw new Error('active_work_upload_content_unconfirmed');
      }
      result.push({ uploadId, revision: ready.revision, sha256, sizeBytes: size, filename: file.filename,
        sourceFileId: file.fileId, inputKind: file.inputKind, ...(file.mediaGroupIndex === undefined ? {} : {mediaGroupIndex: file.mediaGroupIndex}) });
    }
    return result;
  }

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

  async function traceAcceptedVoiceAction({
    ownerId,
    workRef,
    action,
    operationId,
    durableEffectContext,
  }: GlassHiveWorkActionInput, receipt?: unknown): Promise<void> {
    const streamId = normalizedText(durableEffectContext?.streamId);
    if (!streamId || !normalizedText(operationId)) return;
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
      const confirmationPending = recordFrom(receipt).confirmationPending === true;
      const facts: UnknownRecord = {
        ...(confirmationPending ? { confirmationPending: true } : {}),
        workRef,
        streamRef: streamId,
        ...(taskId ? { taskRef: taskId } : {}),
        actionRef: operationId,
        receiptRef: operationId,
        action,
        effectCount: 1,
      };
      await deps.recordVoiceOrchestrationTraceBestEffort({
        ownerId,
        callSessionId,
        turnId,
        eventRef: operationId,
        stage: 'action.accepted',
        facts,
      });
      if (!confirmationPending) {
        await deps.recordVoiceOrchestrationTraceBestEffort({
          ownerId,
          callSessionId,
          turnId,
          eventRef: operationId,
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

  async function trustedCapabilityRefresh(
    { ownerId, workRef, action, ownerInputControl, requestBody }: GlassHiveWorkActionInput,
    currentDetail?: unknown,
  ): Promise<UnknownRecord | null> {
    if (!REAUTH_ACTIONS.has(normalizedText(action).toLowerCase())) return null;
    const detail =
      currentDetail ??
      (await deps.requestAccountApi({
        ownerId,
        path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}`,
      }));
    if (!needsCapabilityReauthorization(detail)) return null;
    if (ownerInputControl !== true) {
      try {
        if (!deps.getSourceAuthorJob) throw new Error('owner_input_unavailable');
        await currentNativeHumanInputSource({
          userId: normalizedText(ownerId),
          requestBody: requestBody || {},
          getJob: deps.getSourceAuthorJob,
          getOriginalInputReceipt: deps.getOriginalInputReceipt,
        });
      } catch {
        throw Object.assign(new Error('capability_authorization_horizon_expired'), {
          code: 'capability_authorization_horizon_expired',
          status: 409,
          needsInput: true,
          userMessage:
            'This work needs your authorization to renew connected capabilities. Use Resume in Active Work.',
        });
      }
    }
    const refreshed = recordFrom(await deps.reauthorizeCapabilityAuthorization({ ownerId, workRef }));
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
    const assertCurrentVoiceAuthority = async () => {
      const context = input.voiceAuthorityContext;
      if (!context?.callSessionId) return;
      if (context.binding?.callSessionId !== context.callSessionId) {
        throw Object.assign(new Error('voice_work_authority_stale'), {
          code: 'voice_work_authority_stale',
          status: 409,
          retryable: false,
        });
      }
      await deps.assertVoiceWorkAuthority(context.binding, normalizedText(ownerId));
    };
    await assertCurrentVoiceAuthority();
    let nativeDetail: unknown;
    let nativeHumanInput: Awaited<ReturnType<typeof currentNativeHumanInputSource>> | undefined;
    if (input.nativeInput && (action !== 'resume' || input.ownerInputControl !== true)) {
      const reply = nativeWorkInputResponseSchema.safeParse(input.nativeInput);
      const denied = () => Object.assign(new Error('native_input_owner_control_required'), {
        code: 'native_input_owner_control_required', status: 403 });
      if (normalizedText(instruction) || action !== 'resume' || !reply.success || reply.data.action !== 'accept' ||
          !reply.data.content) throw denied();
      nativeDetail = await deps.requestAccountApi({ ownerId,
        path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}` });
      const detail = recordFrom(nativeDetail);
      const pending = recordFrom(detail.pendingNativeInput);
      if (detail.workRef !== workRef || pending.requestId !== reply.data.requestId ||
          pending.requestFingerprint !== reply.data.requestFingerprint) throw denied();
      if (pending.kind === 'question') {
        const form = nativeQuestionForm(pending);
        if (!form || !nativeWorkInputQuestionText(pending, pending) ||
            !nativeQuestionContent(reply.data.content, form)) throw denied();
      } else if (pending.kind === 'permission') {
        const content = recordFrom(reply.data.content);
        const option = recordFrom(recordFrom(recordFrom(pending.requestedSchema).properties).optionId);
        const values = Array.isArray(option.enum) ? option.enum : [];
        const kinds = Array.isArray(option.enumKinds) ? option.enumKinds : [];
        const index = values.indexOf(content.optionId);
        if (Object.keys(content).length !== 1 || typeof content.optionId !== 'string' || index < 0 ||
            values.length !== kinds.length || !['allow_once', 'reject_once'].includes(String(kinds[index])) ||
            !deps.getSourceAuthorJob) throw denied();
        nativeHumanInput = await currentNativeHumanInputSource({userId: normalizedText(ownerId),
          requestBody: input.requestBody || {}, getJob: deps.getSourceAuthorJob,
          getOriginalInputReceipt:deps.getOriginalInputReceipt});
      } else throw denied();
      // The native owner revalidates the same current request before its existing mailbox ACK.
      input = { ...input, nativeInput: reply.data };
    }
    if (action === 'dismiss') {
      const coreOnlyReceipt = await deps.dismissCoreOnlyPreDispatchAttention({
        ownerId,
        originRef: workRef,
        operationId,
      });
      if (coreOnlyReceipt) {
        deps.invalidateActiveWorkSnapshot({
          ownerId,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        await deps.getActiveWorkSnapshot({ ownerId, forceRefresh: true });
        await traceAcceptedVoiceAction({ ...input, action });
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
    const capabilityReauthorization = await trustedCapabilityRefresh({
      ownerId, workRef, action, ownerInputControl: input.ownerInputControl, requestBody: input.requestBody,
    }, nativeDetail);
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
    await assertCurrentVoiceAuthority();
    const fileInputs = await prepareFileInputs(input, idempotencyKey);
    await assertCurrentVoiceAuthority();
    const actionBody = {
        action,
        ...(instruction ? { instruction } : {}),
        idempotencyKey,
        ...(input.nativeInput ? { nativeInput: input.nativeInput } : {}),
        ...(nativeHumanInput ? { nativeHumanInput } : {}),
        ...(capabilityReauthorization ? { capabilityReauthorization } : {}),
        ...(sourceContext ? { sourceContext } : {}),
        ...(fileInputs.length ? { fileInputs } : {}),
      };
    let result: unknown;
    try {
      result = await deps.requestAccountApi({ ownerId,
        path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}/actions`, method: 'POST',
        ...(input.nativeInput ? { ownerNativeInput: input.nativeInput } : {}), body: actionBody });
    } catch (error) {
      if (safeErrorCode(error) === 'glasshive_account_request_timeout') {
        await assertCurrentVoiceAuthority();
        // Read the exact immutable body/key receipt. A timeout never proves rejection,
        // and this lookup cannot reserve, retry or execute another control.
        try {
          result = await deps.requestAccountApi({ ownerId,
            path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}/actions/receipt`, method: 'POST',
            ...(input.nativeInput ? { ownerNativeInput: input.nativeInput } : {}), body: actionBody });
        } catch (receiptError) {
          if (recordFrom(receiptError).actionReceipt === 'immutable_failure') {
            throw receiptError;
          }
          throw Object.assign(new Error('work_action_outcome_unconfirmed'), {
            code: 'work_action_outcome_unconfirmed', status: 503, retryable: false, outcomeUnknown: true,
          });
        }
      } else {
        if (action !== 'resume' || Number(recordFrom(error).status) !== 409 ||
            safeErrorCode(error) !== 'active_work_idempotency_conflict' || capabilityReauthorization ||
            !deps.readCapabilityReauthorizationReceiptCandidate) throw error;
        const candidate = await deps.readCapabilityReauthorizationReceiptCandidate({ ownerId, workRef });
        if (!candidate) throw error;
        await assertCurrentVoiceAuthority();
        // Receipt lookup is read-only. The native immutable owner/work/key/body digest
        // must match; it cannot reserve, take over or execute an action.
        result = await deps.requestAccountApi({ ownerId,
          path: `/v1/work/${encodeURIComponent(normalizedText(workRef))}/actions/receipt`, method: 'POST',
          ...(input.nativeInput ? { ownerNativeInput: input.nativeInput } : {}),
          body: { ...actionBody, capabilityReauthorization: candidate } });
      }
    }
    deps.invalidateActiveWorkSnapshot({
      ownerId,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (action === 'dismiss') {
      await deps.getActiveWorkSnapshot({ ownerId, forceRefresh: true });
    }
    await traceAcceptedVoiceAction({ ...input, action }, result);
    return result;
  }

  return { executeGlassHiveWorkAction, needsCapabilityReauthorization };
}
