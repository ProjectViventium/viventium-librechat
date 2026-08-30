/* === VIVENTIUM START ===
 * Feature: generation-fenced GlassHive terminal callback outbox.
 * Purpose: Commit scheduler intents with the central result CAS, then dispatch only the
 * still-current accepted operation.
 * === VIVENTIUM END === */

import crypto from 'crypto';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLAIM_MS = 30_000;
const RETRY_MS = 5_000;
const SCHEDULER_TERMINAL_CALLBACK_CONTRACT = 'glasshive_terminal_result_v1';

export interface GlassHiveTerminalCallbackEffectFence {
  resultKey?: unknown;
  acceptedOperationId?: unknown;
  callbackId?: unknown;
  resultDigest?: unknown;
  resultRevision?: unknown;
  acceptedOperationGeneration?: unknown;
  generation?: unknown;
}

export interface GlassHiveSchedulerCallbackBinding {
  ownerId?: unknown;
  scheduleOccurrenceKey?: unknown;
}

export interface GlassHiveSchedulerCallbackSummary {
  requiredTotal?: unknown;
  requiredTerminal?: unknown;
  requiredFailed?: unknown;
  allRequiredTerminal?: unknown;
  state?: unknown;
}

export interface GlassHiveTerminalCallbackReference {
  resultKey: string;
  acceptedOperationId: string;
  callbackId: string;
  resultDigest: string;
  resultRevision: number;
  generation: number;
}

export interface GlassHiveTerminalCallbackEffectLease {
  resultKey: string;
  acceptedOperationId: string;
  acceptedOperationGeneration: number;
  leaseId: string;
  generation: number;
  resultRevision: number;
  callbackId: string;
  resultDigest: string;
}

export interface GlassHiveSchedulerCallbackOutboxRow {
  outboxId: string;
  destination: string;
  ownerId: string;
  occurrenceKey: string;
  summary: {
    requiredTotal: number;
    requiredTerminal: number;
    requiredFailed: number;
    allRequiredTerminal: boolean;
    state: string;
  };
  terminalCallbackResultKey: string;
  terminalCallbackAcceptedOperationId: string;
  terminalCallbackId: string;
  terminalCallbackResultDigest: string;
  terminalCallbackResultRevision: number;
  terminalCallbackEffectGeneration: number;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date;
  createdAt?: Date;
  claimId?: string;
  claimExpiresAt?: Date | null;
  dispatchPermitId?: string;
  dispatchPermitGeneration?: number;
  dispatchPermitExpiresAt?: Date | null;
  sentAt?: Date | null;
  lastError?: string;
}

interface LeanQuery<T> {
  lean(): Promise<T>;
  session(session: unknown): LeanQuery<T>;
}

export interface GlassHiveCallbackEffectOutboxModel {
  exists(filter: object): PromiseLike<unknown>;
  findOne(filter: object): LeanQuery<GlassHiveSchedulerCallbackOutboxRow | null>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options?: object,
  ): LeanQuery<GlassHiveSchedulerCallbackOutboxRow | null>;
  updateOne(
    filter: object,
    update: object,
    options?: object,
  ): PromiseLike<{ matchedCount?: number }>;
}

export interface GlassHiveTerminalCallbackResultModel {
  exists(filter: object): PromiseLike<unknown>;
}

export interface GlassHiveTerminalCallbackOutboxLogger {
  warn(message: string, metadata: { code: string }): void;
}

export interface GlassHiveTerminalCallbackOutboxDependencies {
  ResultModel: GlassHiveTerminalCallbackResultModel;
  OutboxModel: GlassHiveCallbackEffectOutboxModel;
  fenceAcceptedOperation(input: {
    ResultModel: unknown;
    reference: GlassHiveTerminalCallbackReference;
    session: unknown;
  }): Promise<boolean>;
  acquireAcceptedOperationEffectLease(input: {
    ResultModel: unknown;
    reference: GlassHiveTerminalCallbackReference;
    now: Date;
    leaseDurationMs: number;
    session: unknown;
  }): Promise<GlassHiveTerminalCallbackEffectLease | null>;
  fenceEffectTransaction(input: {
    ResultModel: unknown;
    lease: GlassHiveTerminalCallbackEffectLease;
    session: unknown;
    now?: Date;
  }): Promise<boolean>;
  releaseEffectLease(input: {
    ResultModel: unknown;
    lease: GlassHiveTerminalCallbackEffectLease;
    session: unknown;
  }): Promise<boolean>;
  runTransaction<T>(operation: (session: unknown) => T | Promise<T>): Promise<T>;
  logger: GlassHiveTerminalCallbackOutboxLogger;
}

export interface EnqueueGlassHiveSchedulerCallbackOutboxInput {
  binding: GlassHiveSchedulerCallbackBinding;
  summary: GlassHiveSchedulerCallbackSummary | null | undefined;
  effectFence: GlassHiveTerminalCallbackEffectFence;
  effectSession?: unknown;
}

export interface DispatchGlassHiveSchedulerCallbackOutboxInput {
  outboxId?: string;
  fetchImpl?: typeof fetch;
  beforeAuthorize?: (row: GlassHiveSchedulerCallbackOutboxRow) => unknown | Promise<unknown>;
}

export interface ReconcileGlassHiveSchedulerCallbackOutboxInput {
  limit?: number;
  fetchImpl?: typeof fetch;
}

export type GlassHiveSchedulerCallbackDispatchResult =
  | { status: 'empty' }
  | { status: 'sent' | 'lost_claim' | 'superseded' | 'failed'; outboxId: string };

export interface GlassHiveSchedulerCallbackReconcileCounts {
  sent: number;
  superseded: number;
  failed: number;
  empty: number;
  lost_claim: number;
}

export interface GlassHiveTerminalCallbackOutboxService {
  claimCurrentSchedulerOutbox(input?: {
    outboxId?: string;
    now?: Date;
  }): Promise<GlassHiveSchedulerCallbackOutboxRow | null>;
  dispatchGlassHiveSchedulerCallbackOutbox(
    input?: DispatchGlassHiveSchedulerCallbackOutboxInput,
  ): Promise<GlassHiveSchedulerCallbackDispatchResult>;
  enqueueGlassHiveSchedulerCallbackOutbox(
    input: EnqueueGlassHiveSchedulerCallbackOutboxInput,
  ): Promise<GlassHiveSchedulerCallbackOutboxRow | null>;
  reconcileGlassHiveSchedulerCallbackOutbox(
    input?: ReconcileGlassHiveSchedulerCallbackOutboxInput,
  ): Promise<GlassHiveSchedulerCallbackReconcileCounts>;
}

class GlassHiveCallbackOutboxSupersededError extends Error {
  readonly code = 'glasshive_callback_outbox_superseded';

  constructor(readonly outboxId: string) {
    super('glasshive_callback_outbox_superseded');
  }
}

function text(value: unknown, max = 512): string {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return text(error.code, 120);
}

function reference(
  effectFence: GlassHiveTerminalCallbackEffectFence,
): GlassHiveTerminalCallbackReference {
  const value = {
    resultKey: text(effectFence?.resultKey, 80),
    acceptedOperationId: text(effectFence?.acceptedOperationId, 64),
    callbackId: text(effectFence?.callbackId, 80),
    resultDigest: text(effectFence?.resultDigest, 80),
    resultRevision: Number(effectFence?.resultRevision),
    generation: Number(effectFence?.acceptedOperationGeneration ?? effectFence?.generation),
  };
  if (
    !/^ghtr_[a-f0-9]{64}$/.test(value.resultKey) ||
    !/^[a-f0-9]{32}$/.test(value.acceptedOperationId) ||
    !/^cb_terminal_[a-f0-9]{64}$/.test(value.callbackId) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.resultDigest) ||
    !Number.isSafeInteger(value.resultRevision) ||
    value.resultRevision < 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    const error = new Error('glasshive_callback_effect_fence_invalid');
    Object.assign(error, { code: 'glasshive_callback_effect_fenced' });
    throw error;
  }
  return value;
}

function rowReference(
  row: GlassHiveSchedulerCallbackOutboxRow,
): GlassHiveTerminalCallbackReference {
  return reference({
    resultKey: row.terminalCallbackResultKey,
    acceptedOperationId: row.terminalCallbackAcceptedOperationId,
    callbackId: row.terminalCallbackId,
    resultDigest: row.terminalCallbackResultDigest,
    resultRevision: row.terminalCallbackResultRevision,
    generation: row.terminalCallbackEffectGeneration,
  });
}

function dispatchLease(
  row: GlassHiveSchedulerCallbackOutboxRow,
): GlassHiveTerminalCallbackEffectLease | null {
  const current = rowReference(row);
  const leaseId = text(row.dispatchPermitId, 64);
  const generation = Number(row.dispatchPermitGeneration);
  if (!/^[a-f0-9]{32}$/.test(leaseId) || !Number.isSafeInteger(generation) || generation < 1) {
    return null;
  }
  return {
    resultKey: current.resultKey,
    acceptedOperationId: current.acceptedOperationId,
    acceptedOperationGeneration: current.generation,
    leaseId,
    generation,
    resultRevision: current.resultRevision,
    callbackId: current.callbackId,
    resultDigest: current.resultDigest,
  };
}

function outboxIdFor(input: {
  occurrenceKey: string;
  effectFence: GlassHiveTerminalCallbackEffectFence;
}): string {
  const current = reference(input.effectFence);
  const digest = crypto
    .createHash('sha256')
    .update(
      [current.resultKey, current.acceptedOperationId, input.occurrenceKey, 'scheduler'].join('\0'),
    )
    .digest('hex');
  return `ghco_${digest}`;
}

export function createGlassHiveTerminalCallbackOutboxService(
  dependencies: GlassHiveTerminalCallbackOutboxDependencies,
): GlassHiveTerminalCallbackOutboxService {
  const {
    ResultModel,
    OutboxModel,
    fenceAcceptedOperation,
    acquireAcceptedOperationEffectLease,
    fenceEffectTransaction,
    releaseEffectLease,
    runTransaction,
    logger,
  } = dependencies;

  async function acceptedOperationStillCurrent(
    row: GlassHiveSchedulerCallbackOutboxRow,
  ): Promise<boolean> {
    const current = rowReference(row);
    return Boolean(
      await ResultModelExists({
        _id: current.resultKey,
        acceptedOperationId: current.acceptedOperationId,
        acceptedOperationGeneration: current.generation,
        callbackId: current.callbackId,
        resultRevision: current.resultRevision,
        resultDigest: current.resultDigest,
      }),
    );
  }

  async function ResultModelExists(filter: object): Promise<unknown> {
    if (
      !ResultModel ||
      (typeof ResultModel !== 'object' && typeof ResultModel !== 'function') ||
      typeof ResultModel.exists !== 'function'
    ) {
      throw new Error('glasshive_callback_result_model_unavailable');
    }
    return ResultModel.exists(filter);
  }

  async function enqueueGlassHiveSchedulerCallbackOutbox({
    binding,
    summary,
    effectFence,
    effectSession,
  }: EnqueueGlassHiveSchedulerCallbackOutboxInput): Promise<GlassHiveSchedulerCallbackOutboxRow | null> {
    const occurrenceKey = text(binding?.scheduleOccurrenceKey, 512);
    const ownerId = text(binding?.ownerId, 512);
    if (!occurrenceKey || !ownerId || !summary || Number(summary.requiredTotal) < 1) return null;
    const current = reference(effectFence);
    const outboxId = outboxIdFor({ occurrenceKey, effectFence });
    const now = new Date();
    return OutboxModel.findOneAndUpdate(
      { outboxId },
      {
        $setOnInsert: {
          outboxId,
          destination: 'scheduler',
          ownerId,
          occurrenceKey,
          summary: {
            requiredTotal: Number(summary.requiredTotal) || 0,
            requiredTerminal: Number(summary.requiredTerminal) || 0,
            requiredFailed: Number(summary.requiredFailed) || 0,
            allRequiredTerminal: summary.allRequiredTerminal === true,
            state: text(summary.state, 64),
          },
          terminalCallbackResultKey: current.resultKey,
          terminalCallbackAcceptedOperationId: current.acceptedOperationId,
          terminalCallbackId: current.callbackId,
          terminalCallbackResultDigest: current.resultDigest,
          terminalCallbackResultRevision: current.resultRevision,
          terminalCallbackEffectGeneration: current.generation,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        ...(effectSession ? { session: effectSession } : {}),
      },
    ).lean();
  }

  async function fencedOutboxTransaction(
    operation: (session: unknown) => Promise<GlassHiveSchedulerCallbackOutboxRow | null>,
  ): Promise<GlassHiveSchedulerCallbackOutboxRow | null> {
    let row: GlassHiveSchedulerCallbackOutboxRow | null = null;
    await runTransaction(async (session) => {
      row = await operation(session);
      if (!row) return;
      const current = await fenceAcceptedOperation({
        ResultModel,
        reference: rowReference(row),
        session,
      });
      if (!current) throw new GlassHiveCallbackOutboxSupersededError(row.outboxId);
    });
    return row;
  }

  async function supersedeOutbox(outboxId: string): Promise<void> {
    if (!outboxId) return;
    await OutboxModel.updateOne(
      { outboxId, status: { $in: ['pending', 'failed', 'claimed'] } },
      {
        $set: {
          status: 'superseded',
          claimId: '',
          claimExpiresAt: null,
          dispatchPermitId: '',
          dispatchPermitGeneration: 0,
          dispatchPermitExpiresAt: null,
          nextAttemptAt: null,
          lastError: 'terminal_callback_revision_superseded',
        },
      },
    );
  }

  async function claimCurrentSchedulerOutbox({
    outboxId = '',
    now = new Date(),
  }: { outboxId?: string; now?: Date } = {}): Promise<GlassHiveSchedulerCallbackOutboxRow | null> {
    const filter = {
      destination: 'scheduler',
      ...(outboxId ? { outboxId: text(outboxId, 80) } : {}),
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'failed', nextAttemptAt: { $lte: now } },
        { status: 'claimed', claimExpiresAt: { $lte: now } },
      ],
    };
    if (!(await OutboxModel.exists(filter))) return null;
    const claimId = `ghcoc_${crypto.randomBytes(16).toString('hex')}`;
    try {
      return await fencedOutboxTransaction(() =>
        OutboxModel.findOneAndUpdate(
          filter,
          {
            $set: {
              status: 'claimed',
              claimId,
              claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
              lastError: '',
            },
            $inc: { attempts: 1 },
          },
          { sort: { createdAt: 1 }, new: true },
        ).lean(),
      );
    } catch (error: unknown) {
      if (!(error instanceof GlassHiveCallbackOutboxSupersededError)) throw error;
      await supersedeOutbox(error.outboxId);
      return null;
    }
  }

  function schedulerUrl(): string {
    const explicit = text(process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL, 2048);
    if (explicit) return explicit;
    const base = text(process.env.SCHEDULING_MCP_URL, 2048);
    return base
      ? `${base.replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/internal/scheduled-prompts/external-work-callback`
      : '';
  }

  async function authorizeClaim(
    row: GlassHiveSchedulerCallbackOutboxRow,
  ): Promise<GlassHiveSchedulerCallbackOutboxRow | null> {
    const now = new Date();
    try {
      let authorized: GlassHiveSchedulerCallbackOutboxRow | null = null;
      await runTransaction(async (session) => {
        const constraint = {
          outboxId: row.outboxId,
          status: 'claimed',
          claimId: row.claimId,
          claimExpiresAt: { $gt: now },
        };
        const current = await OutboxModel.findOne(constraint).session(session).lean();
        if (!current) throw new Error('glasshive_callback_outbox_claim_missing');

        const currentPermitExpiresAt = current.dispatchPermitExpiresAt
          ? new Date(current.dispatchPermitExpiresAt)
          : null;
        const currentLease = dispatchLease(current);
        if (currentLease && currentPermitExpiresAt && currentPermitExpiresAt > now) {
          const stillAuthorized = await fenceEffectTransaction({
            ResultModel,
            lease: currentLease,
            session,
            now,
          });
          if (!stillAuthorized) throw new Error('glasshive_callback_outbox_dispatch_fenced');
          authorized = current;
          return;
        }

        const lease = await acquireAcceptedOperationEffectLease({
          ResultModel,
          reference: rowReference(current),
          now,
          leaseDurationMs: CLAIM_MS,
          session,
        });
        if (!lease) throw new Error('glasshive_callback_outbox_dispatch_fenced');
        authorized = await OutboxModel.findOneAndUpdate(
          constraint,
          {
            $set: {
              claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
              dispatchPermitId: lease.leaseId,
              dispatchPermitGeneration: lease.generation,
              dispatchPermitExpiresAt: new Date(now.getTime() + CLAIM_MS),
            },
          },
          { new: true, session },
        ).lean();
        if (!authorized) throw new Error('glasshive_callback_outbox_claim_missing');
      });
      return authorized;
    } catch (error: unknown) {
      if (
        ![
          'glasshive_callback_outbox_dispatch_fenced',
          'glasshive_callback_outbox_claim_missing',
        ].includes(errorMessage(error))
      ) {
        throw error;
      }
      const stillCurrent = await acceptedOperationStillCurrent(row);
      if (!stillCurrent) await supersedeOutbox(row.outboxId);
      return null;
    }
  }

  async function releaseClaimPermit(
    row: GlassHiveSchedulerCallbackOutboxRow,
    { failed = false, error = '' }: { failed?: boolean; error?: string } = {},
  ): Promise<boolean> {
    const lease = dispatchLease(row);
    if (!lease) return false;
    let released = false;
    await runTransaction(async (session) => {
      const current = await OutboxModel.findOne({
        outboxId: row.outboxId,
        status: 'claimed',
        claimId: row.claimId,
        dispatchPermitId: lease.leaseId,
        dispatchPermitGeneration: lease.generation,
      })
        .session(session)
        .lean();
      if (!current) return;
      released = await releaseEffectLease({ ResultModel, lease, session });
      if (!released) return;
      const cleared = await OutboxModel.updateOne(
        {
          outboxId: row.outboxId,
          status: 'claimed',
          claimId: row.claimId,
          dispatchPermitId: lease.leaseId,
          dispatchPermitGeneration: lease.generation,
        },
        {
          $set: {
            status: failed ? 'failed' : 'claimed',
            claimId: failed ? '' : row.claimId,
            claimExpiresAt: failed ? null : row.claimExpiresAt,
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
            nextAttemptAt: failed ? new Date(Date.now() + RETRY_MS) : row.nextAttemptAt,
            lastError: failed ? text(error, 2000) : '',
          },
        },
        { session },
      );
      if (cleared.matchedCount !== 1) {
        throw new Error('glasshive_callback_outbox_claim_changed');
      }
    });
    return released;
  }

  async function settleSentClaim(
    row: GlassHiveSchedulerCallbackOutboxRow,
  ): Promise<GlassHiveSchedulerCallbackOutboxRow | null> {
    const lease = dispatchLease(row);
    if (!lease) return null;
    let sent: GlassHiveSchedulerCallbackOutboxRow | null = null;
    await runTransaction(async (session) => {
      sent = await OutboxModel.findOneAndUpdate(
        {
          outboxId: row.outboxId,
          status: 'claimed',
          claimId: row.claimId,
          dispatchPermitId: lease.leaseId,
          dispatchPermitGeneration: lease.generation,
          dispatchPermitExpiresAt: { $gt: new Date() },
        },
        {
          $set: {
            status: 'sent',
            sentAt: new Date(),
            claimExpiresAt: null,
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
            nextAttemptAt: null,
            lastError: '',
          },
        },
        { new: true, session },
      ).lean();
      if (!sent) throw new Error('glasshive_callback_outbox_claim_missing');
      const current = await fenceEffectTransaction({ ResultModel, lease, session });
      if (!current) throw new Error('glasshive_callback_outbox_dispatch_fenced');
      const released = await releaseEffectLease({ ResultModel, lease, session });
      if (!released) throw new Error('glasshive_callback_outbox_dispatch_fenced');
    });
    return sent;
  }

  async function dispatchGlassHiveSchedulerCallbackOutbox({
    outboxId = '',
    fetchImpl = globalThis.fetch,
    beforeAuthorize,
  }: DispatchGlassHiveSchedulerCallbackOutboxInput = {}): Promise<GlassHiveSchedulerCallbackDispatchResult> {
    const claimed = await claimCurrentSchedulerOutbox({ outboxId });
    if (!claimed) return { status: 'empty' };
    await beforeAuthorize?.(claimed);
    const authorized = await authorizeClaim(claimed);
    if (!authorized) return { status: 'superseded', outboxId: claimed.outboxId };
    const url = schedulerUrl();
    const secret = text(
      process.env.VIVENTIUM_SCHEDULER_SECRET || process.env.SCHEDULER_LIBRECHAT_SECRET,
      4096,
    );
    if (!url || !secret || typeof fetchImpl !== 'function') {
      await releaseClaimPermit(authorized, {
        failed: true,
        error: 'scheduler_external_work_callback_unavailable',
      });
      throw new Error('scheduler_external_work_callback_unavailable');
    }
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-SCHEDULER-SECRET': secret,
          'X-Viventium-Callback-Contract': SCHEDULER_TERMINAL_CALLBACK_CONTRACT,
          'X-Viventium-Callback-Id': authorized.terminalCallbackId,
          'X-Viventium-Result-Revision': String(authorized.terminalCallbackResultRevision),
          'X-Viventium-Result-Digest': authorized.terminalCallbackResultDigest,
        },
        body: JSON.stringify({
          callback_contract: SCHEDULER_TERMINAL_CALLBACK_CONTRACT,
          source: 'glasshive',
          event: 'run.completed',
          occurrence_key: authorized.occurrenceKey,
          user_id: authorized.ownerId,
          required_total: authorized.summary.requiredTotal,
          required_terminal: authorized.summary.requiredTerminal,
          required_failed: authorized.summary.requiredFailed,
          all_required_terminal: authorized.summary.allRequiredTerminal,
          state: authorized.summary.state,
          callback_id: authorized.terminalCallbackId,
          result_revision: authorized.terminalCallbackResultRevision,
          result_digest: authorized.terminalCallbackResultDigest,
        }),
      });
      if (!response.ok) {
        throw new Error(`scheduler_external_work_callback_http_${response.status}`);
      }
    } catch (error: unknown) {
      await releaseClaimPermit(authorized, { failed: true, error: errorMessage(error) });
      throw error;
    }

    const settlementPermit = await authorizeClaim(authorized);
    if (!settlementPermit) return { status: 'superseded', outboxId: authorized.outboxId };
    try {
      const sent = await settleSentClaim(settlementPermit);
      return { status: sent ? 'sent' : 'lost_claim', outboxId: authorized.outboxId };
    } catch (error: unknown) {
      if (
        ![
          'glasshive_callback_outbox_dispatch_fenced',
          'glasshive_callback_outbox_claim_missing',
        ].includes(errorMessage(error))
      ) {
        throw error;
      }
      const stillCurrent = await acceptedOperationStillCurrent(settlementPermit);
      if (!stillCurrent) {
        await supersedeOutbox(settlementPermit.outboxId);
        return { status: 'superseded', outboxId: authorized.outboxId };
      }
      await releaseClaimPermit(settlementPermit, {
        failed: true,
        error: 'scheduler_external_work_callback_settlement_retry',
      });
      return { status: 'failed', outboxId: authorized.outboxId };
    }
  }

  async function reconcileGlassHiveSchedulerCallbackOutbox({
    limit = 25,
    fetchImpl,
  }: ReconcileGlassHiveSchedulerCallbackOutboxInput = {}): Promise<GlassHiveSchedulerCallbackReconcileCounts> {
    const bounded = Math.max(1, Math.min(Number(limit) || 25, 100));
    const counts: GlassHiveSchedulerCallbackReconcileCounts = {
      sent: 0,
      superseded: 0,
      failed: 0,
      empty: 0,
      lost_claim: 0,
    };
    for (let index = 0; index < bounded; index += 1) {
      try {
        const result = await dispatchGlassHiveSchedulerCallbackOutbox({ fetchImpl });
        counts[result.status] += 1;
        if (result.status === 'empty') break;
      } catch (error: unknown) {
        counts.failed += 1;
        logger.warn('[VIVENTIUM][glasshive-callback-outbox] Scheduler dispatch failed', {
          code: text(errorCode(error) || errorMessage(error) || 'unknown_error', 120),
        });
        break;
      }
    }
    return counts;
  }

  return {
    claimCurrentSchedulerOutbox,
    dispatchGlassHiveSchedulerCallbackOutbox,
    enqueueGlassHiveSchedulerCallbackOutbox,
    reconcileGlassHiveSchedulerCallbackOutbox,
  };
}
