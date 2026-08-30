/* === VIVENTIUM START ===
 * Feature: Account-wide adaptive Parallel Work HTTP contract.
 * Purpose: Keep authority, validation, response truth, and safe diagnostics in typed package code.
 * === VIVENTIUM END === */

import { z } from 'zod';
import { safeErrorCode, safeErrorLogFields } from '../logging/safeError';

type ValueRecord = Record<string, unknown>;

interface HttpRequest {
  body?: unknown;
  hostname?: string;
  params?: ValueRecord;
  query?: ValueRecord;
  user?: { id?: unknown };
}

interface HttpResponse {
  json(body: unknown): unknown;
  set(field: string, value: string): unknown;
  status(statusCode: number): HttpResponse;
}

type Next = () => unknown;

interface ClaimState {
  available: boolean;
  label: string;
  blockers: unknown[];
}

interface UserRecord extends ValueRecord {
  personalization?: {
    orchestration_mode?: unknown;
    parallel_work_known?: unknown;
  };
}

interface WorkSnapshot extends ValueRecord {
  work?: unknown[];
}

interface ActionError extends ValueRecord {
  status?: unknown;
  userMessage?: unknown;
}

export interface OrchestrationHttpDependencies {
  logger: {
    error(message: string, details?: object): unknown;
    info(message: string, details?: object): unknown;
    warn(message: string, details?: object): unknown;
  };
  getUserById(ownerId: string, projection: string): Promise<UserRecord | null>;
  updateUserViventiumOrchestrationPreferences(
    ownerId: string,
    preferences: { mode: 'focused' | 'parallel' },
  ): Promise<UserRecord | null>;
  getActiveWorkPage(input: {
    ownerId: string;
    cursor: string;
    limit: number;
  }): Promise<WorkSnapshot>;
  getActiveWorkHistoryPage(input: {
    ownerId: string;
    cursor: string;
    limit: number;
  }): Promise<WorkSnapshot>;
  getActiveWorkInteractiveSnapshot(input: { ownerId: string }): Promise<WorkSnapshot>;
  executeGlassHiveWorkAction(input: ValueRecord): Promise<unknown>;
  effectiveOrchestrationMode(
    user: UserRecord,
    readiness: { available: boolean },
  ): 'focused' | 'parallel';
  parallelWorkClaimStateAsync(ownerId: string): Promise<ClaimState>;
  observeOrchestrationOwner(ownerId: string): unknown;
  refreshOrchestrationReadiness(input: { ownerId: string }): Promise<unknown>;
  providerBaseUrl(): string;
}

const preferenceSchema = z.object({ mode: z.enum(['focused', 'parallel']) }).strict();
const workRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const actionSchema = z
  .object({
    action: z.enum(['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss']),
    instruction: z.string().trim().min(1).max(8000).optional(),
    operationId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (['queue', 'message', 'steer'].includes(value.action) && !value.instruction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: `${value.action} requires an instruction`,
      });
    }
  });

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WORKER_VIEW_PATH = /^\/w\/ghr_[A-Za-z0-9_-]{8,160}$/;
const CURSOR = /^[A-Za-z0-9._~:@+-]+$/;

function record(value: unknown): ValueRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ValueRecord)
    : {};
}

function ownerIdFrom(req: HttpRequest): string {
  return String(req.user?.id || '').trim();
}

function pageInput(req: HttpRequest): { cursor: string; limit: number } | null {
  const cursor = String(req.query?.cursor || '').trim();
  const limit = Number(req.query?.limit || 50);
  if (
    (cursor && (cursor.length > 2048 || !CURSOR.test(cursor))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return null;
  }
  return { cursor, limit };
}

export function clientReachableWorkSnapshot(
  snapshot: WorkSnapshot,
  hostname: string,
  configuredBaseUrl: string,
): WorkSnapshot {
  if (!Array.isArray(snapshot?.work) || !LOOPBACK_HOSTS.has(hostname)) {
    return snapshot;
  }
  let runtimeBase: string;
  try {
    const configured = new URL(configuredBaseUrl);
    if (!['http:', 'https:'].includes(configured.protocol) || !LOOPBACK_HOSTS.has(configured.hostname)) {
      return snapshot;
    }
    configured.pathname = configured.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    configured.search = '';
    configured.hash = '';
    runtimeBase = configured.toString().replace(/\/$/, '');
  } catch {
    return snapshot;
  }
  return {
    ...snapshot,
    work: snapshot.work.map((rawItem) => {
      const item = record(rawItem);
      try {
        const view = new URL(String(item.viewRef || ''));
        if (!['http:', 'https:'].includes(view.protocol) || !WORKER_VIEW_PATH.test(view.pathname)) {
          return rawItem;
        }
        return { ...item, viewRef: `${runtimeBase}${view.pathname}` };
      } catch {
        return rawItem;
      }
    }),
  };
}

export function createOrchestrationHttpHandlers(dependencies: OrchestrationHttpDependencies) {
  async function responseBody(
    user: UserRecord,
    ownerId: string,
    admittedClaimState?: ClaimState | null,
  ): Promise<ValueRecord> {
    const claimState = admittedClaimState || (await dependencies.parallelWorkClaimStateAsync(ownerId));
    return {
      available: claimState.available,
      mode: dependencies.effectiveOrchestrationMode(user, { available: claimState.available }),
      hasKnownWork: user.personalization?.parallel_work_known === true,
      ...(claimState.label === 'READY'
        ? {}
        : { releaseGate: { label: claimState.label, blockers: claimState.blockers } }),
    };
  }

  function noStore(_req: HttpRequest, res: HttpResponse, next: Next): unknown {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    return next();
  }

  async function getPreference(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const ownerId = ownerIdFrom(req);
    try {
      dependencies.observeOrchestrationOwner(ownerId);
      const user = await dependencies.getUserById(
        ownerId,
        'personalization.orchestration_mode personalization.parallel_work_known',
      );
      if (!user) {
        return res
          .status(404)
          .json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
      }
      return res.json(await responseBody(user, ownerId));
    } catch (error) {
      dependencies.logger.error(
        '[VIVENTIUM][orchestration] Failed to read account preference',
        safeErrorLogFields(error, 'orchestration_read_failed'),
      );
      return res.status(500).json({
        error: { code: 'ORCHESTRATION_READ_FAILED', message: 'Unable to read Parallel work.' },
      });
    }
  }

  async function patchPreference(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const ownerId = ownerIdFrom(req);
    dependencies.observeOrchestrationOwner(ownerId);
    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ORCHESTRATION_PREFERENCE',
          message: 'Mode must be focused or parallel.',
        },
      });
    }
    let claimState =
      parsed.data.mode === 'parallel'
        ? await dependencies.parallelWorkClaimStateAsync(ownerId)
        : null;
    if (parsed.data.mode === 'parallel' && claimState?.available !== true) {
      await dependencies.refreshOrchestrationReadiness({ ownerId });
      claimState = await dependencies.parallelWorkClaimStateAsync(ownerId);
    }
    if (parsed.data.mode === 'parallel' && claimState?.available !== true) {
      return res.status(409).json({
        error: {
          code: 'PARALLEL_WORK_UNAVAILABLE',
          message: 'Parallel work is not available in this runtime yet.',
          label: claimState?.label,
          blockers: claimState?.blockers,
        },
      });
    }

    try {
      const user = await dependencies.updateUserViventiumOrchestrationPreferences(
        ownerId,
        parsed.data,
      );
      if (!user) {
        return res
          .status(404)
          .json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
      }
      dependencies.logger.info('[VIVENTIUM][orchestration] Account preference updated', {
        mode: parsed.data.mode,
      });
      return res.json(await responseBody(user, ownerId, claimState));
    } catch (error) {
      dependencies.logger.error(
        '[VIVENTIUM][orchestration] Failed to update account preference',
        safeErrorLogFields(error, 'orchestration_update_failed'),
      );
      return res.status(500).json({
        error: { code: 'ORCHESTRATION_UPDATE_FAILED', message: 'Unable to update Parallel work.' },
      });
    }
  }

  async function getWork(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const page = pageInput(req);
    if (!page) {
      return res.status(400).json({
        error: { code: 'INVALID_ACTIVE_WORK_CURSOR', message: 'The Active work page is invalid.' },
      });
    }
    try {
      const ownerId = ownerIdFrom(req);
      const snapshot = page.cursor
        ? await dependencies.getActiveWorkPage({ ownerId, ...page })
        : await dependencies.getActiveWorkInteractiveSnapshot({ ownerId });
      return res.json(
        clientReachableWorkSnapshot(
          snapshot,
          String(req.hostname || ''),
          dependencies.providerBaseUrl(),
        ),
      );
    } catch (error) {
      dependencies.logger.error(
        '[VIVENTIUM][orchestration] Failed to read active work',
        safeErrorLogFields(error, 'active_work_read_failed'),
      );
      return res.status(500).json({
        error: { code: 'ACTIVE_WORK_READ_FAILED', message: 'Unable to read Active work.' },
      });
    }
  }

  async function getWorkHistory(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const page = pageInput(req);
    if (!page) {
      return res.status(400).json({
        error: { code: 'INVALID_ACTIVE_WORK_CURSOR', message: 'The Active work page is invalid.' },
      });
    }
    try {
      const snapshot = await dependencies.getActiveWorkHistoryPage({
        ownerId: ownerIdFrom(req),
        ...page,
      });
      return res.json(
        clientReachableWorkSnapshot(
          snapshot,
          String(req.hostname || ''),
          dependencies.providerBaseUrl(),
        ),
      );
    } catch (error) {
      dependencies.logger.error(
        '[VIVENTIUM][orchestration] Failed to read active work history',
        safeErrorLogFields(error, 'active_work_history_read_failed'),
      );
      return res.status(500).json({
        error: { code: 'ACTIVE_WORK_HISTORY_READ_FAILED', message: 'Unable to read work history.' },
      });
    }
  }

  async function postWorkAction(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const workRef = workRefSchema.safeParse(req.params?.workRef);
    const action = actionSchema.safeParse(req.body);
    if (!workRef.success || !action.success) {
      return res.status(400).json({
        error: { code: 'INVALID_WORK_ACTION', message: 'The Active work action is invalid.' },
      });
    }

    const { operationId, ...safeAction } = action.data;
    try {
      const result = await dependencies.executeGlassHiveWorkAction({
        ownerId: ownerIdFrom(req),
        workRef: workRef.data,
        operationId,
        ...safeAction,
      });
      return res.status(202).json(result);
    } catch (error) {
      const value = record(error) as ActionError;
      const status = Number(value.status);
      const responseStatus =
        Number.isInteger(status) && status >= 400 && status < 600 ? status : 502;
      const code = safeErrorCode(error, 'ACTIVE_WORK_ACTION_FAILED');
      dependencies.logger.warn('[VIVENTIUM][orchestration] Active work action rejected', {
        action: action.data.action,
        status: responseStatus,
        code,
      });
      const userMessage =
        typeof value.userMessage === 'string' && value.userMessage.length <= 240
          ? value.userMessage
          : 'Unable to apply the Active work action.';
      return res.status(responseStatus).json({ error: { code, message: userMessage } });
    }
  }

  return { noStore, getPreference, patchPreference, getWork, getWorkHistory, postWorkAction };
}
