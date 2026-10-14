/* === VIVENTIUM START ===
 * Feature: Main compaction scheduling after acceptance and bounded size repair.
 * Purpose: An external adapter (for example Telegram) accepts its Main turn later, through the
 * authenticated delivery acknowledgement, where the turn's own execution context is gone. The
 * finished turn registers its compaction schedule; acceptance runs it exactly as a server-committed
 * turn schedules compaction. A model repairs an oversized proposal gradually, so a whole-proposal
 * size overflow that keeps shrinking may be repaired again while the store-owned claim lease can
 * still hold that attempt and its fidelity review. Output limits are unchanged.
 * === VIVENTIUM END === */
import {
  MAIN_COMPACTION_SOURCE_TARGET_BYTES,
  boundedMainCompactionSourceTarget,
  mainCompactionProposalBytes,
  boundedMainCompactionLeaseRenewal,
} from './mainContinuity';
import type { MainCompactionStructuralIssue } from './mainContinuity';

type AcceptanceCommitResult = { readonly status?: unknown } | null | undefined;
type AcceptanceSchedule = (commitResult: AcceptanceCommitResult) => boolean;

/* === VIVENTIUM START ===
 * Use the one retained presentation callback for compaction and prepared memory admission.
 * Each callback captures its resources before request cleanup.
 */
export function retainExternalAcceptanceFollowUps(input: {
  userId: unknown;
  responseMessageId: unknown;
  scheduleCompaction: AcceptanceSchedule;
  admitMemory: (() => Promise<object | boolean | void>) | null;
  onMemoryError: (error: unknown) => void;
}): boolean {
  return retainExternalAcceptanceCompaction({
    userId: input.userId,
    responseMessageId: input.responseMessageId,
    schedule: (commitResult) => {
      const compacted = input.scheduleCompaction(commitResult);
      if (input.admitMemory) {
        void Promise.resolve().then(input.admitMemory).catch(input.onMemoryError);
      }
      return compacted || Boolean(input.admitMemory);
    },
  });
}

export async function startAcceptedMainMemory<T>(input: {
  awaitExternalAcceptance: boolean;
  prepare?: () => boolean;
  start?: () => T | Promise<T>;
  onPrepared: () => void;
}): Promise<T | boolean | undefined> {
  if (!input.awaitExternalAcceptance) return input.start?.();
  const prepared = input.prepare?.() === true;
  if (prepared) input.onPrepared();
  return prepared;
}
/* === VIVENTIUM END === */

export const mainCompactionAcceptanceRetention = Object.freeze({
  ttlMs: 10 * 60 * 1000,
  maxRetained: 32,
});

const retainedSchedules = new Map<string, { schedule: AcceptanceSchedule; expiresAt: number }>();

function retentionKey(userId: unknown, responseMessageId: unknown): string {
  const owner = String(userId ?? '').trim();
  const messageId = String(responseMessageId ?? '').trim();
  return owner && messageId ? `${owner}\n${messageId}` : '';
}

/** Register a finished externally delivered turn's own compaction schedule until it is accepted. */
export function retainExternalAcceptanceCompaction(input: {
  userId: unknown;
  responseMessageId: unknown;
  schedule: AcceptanceSchedule;
  now?: number;
}): boolean {
  const key = retentionKey(input.userId, input.responseMessageId);
  if (!key || typeof input.schedule !== 'function') return false;
  const now = input.now ?? Date.now();
  for (const [entryKey, entry] of retainedSchedules) {
    if (entry.expiresAt <= now) retainedSchedules.delete(entryKey);
  }
  retainedSchedules.delete(key);
  while (retainedSchedules.size >= mainCompactionAcceptanceRetention.maxRetained) {
    const oldest = retainedSchedules.keys().next().value;
    if (oldest === undefined) break;
    retainedSchedules.delete(oldest);
  }
  retainedSchedules.set(key, {
    schedule: input.schedule,
    expiresAt: now + mainCompactionAcceptanceRetention.ttlMs,
  });
  return true;
}

/** Run the retained schedule once the adapter's acknowledgement has committed acceptance. */
export function scheduleExternallyAcceptedMainCompaction(
  presentation:
    { readonly userId?: unknown; readonly responseMessageId?: unknown } | null | undefined,
  commitResult: AcceptanceCommitResult,
  now: number = Date.now(),
): boolean {
  if (!['committed', 'already_committed'].includes(String(commitResult?.status ?? ''))) {
    return false;
  }
  const key = retentionKey(presentation?.userId, presentation?.responseMessageId);
  const entry = key ? retainedSchedules.get(key) : undefined;
  if (!entry) return false;
  retainedSchedules.delete(key);
  if (entry.expiresAt <= now) return false;
  return entry.schedule(commitResult) === true;
}

export const MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS = 4;

export interface MainCompactionSizeRepairState {
  readonly proposalBytes: number | null;
  readonly converging: boolean;
}

/**
 * A byte-size rejection (whole proposal, summary or item) converges while the whole proposal keeps
 * shrinking on every repair. Any other rejection ends convergence.
 */
export function recordMainCompactionRejection(
  state: MainCompactionSizeRepairState | null,
  issue: MainCompactionStructuralIssue | undefined,
  attempt: number,
  proposal: unknown,
): MainCompactionSizeRepairState {
  const bytes = issue?.constraint === 'max_bytes' ? mainCompactionProposalBytes(proposal) : 0;
  const proposalBytes = bytes > 0 ? bytes : null;
  const previous = state?.proposalBytes ?? null;
  const converging =
    proposalBytes !== null &&
    (attempt === 1 ||
      (state?.converging === true && previous !== null && proposalBytes < previous));
  return { proposalBytes, converging };
}

/** Milliseconds left on the store-owned claim lease, never negative. */
export function mainCompactionLeaseRemainingMs(leaseExpiresAt: unknown, now: number): number {
  const expiresAt = new Date(leaseExpiresAt as string | number | Date).getTime();
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
}

/** Reserve review and the waiting Main turn inside the enclosing authoring deadline. */
export function mainCompactionStageBudget(input: {
  leaseExpiresAt: unknown;
  deadlineAt?: unknown;
  completionReserveMs?: number;
  now: number;
  slowestCallMs: number;
  slowestCompactionCallMs?: number;
  slowestReviewCallMs?: number;
  maxCallMs: number;
  stage: 'compaction' | 'review';
}): { allowed: boolean; timeoutMs: number } {
  const leaseRemaining = mainCompactionLeaseRemainingMs(input.leaseExpiresAt, input.now);
  const deadline = new Date(input.deadlineAt as string | number | Date).getTime();
  if (!Number.isFinite(deadline))
    return {
      allowed: leaseRemaining > 0,
      timeoutMs: Math.min(input.maxCallMs, leaseRemaining),
    };
  const remaining = Math.min(
    leaseRemaining,
    Math.max(0, deadline - input.now - Math.max(0, input.completionReserveMs || 0)),
  );
  // An unobserved stage has no measured estimate. A different stage's duration is not evidence
  // for it; the live lease, enclosing Main reserve and existing per-call ceiling still bound it.
  const compactionEstimate = Math.max(0, input.slowestCompactionCallMs ?? 0);
  const reviewEstimate = Math.max(0, input.slowestReviewCallMs ?? 0);
  const estimate = input.stage === 'compaction' ? compactionEstimate : reviewEstimate;
  const reserve = input.stage === 'compaction' ? reviewEstimate : 0;
  const timeoutMs = Math.min(input.maxCallMs, Math.max(0, remaining - reserve));
  return { allowed: timeoutMs > 0 && timeoutMs >= estimate, timeoutMs };
}

/** Renew only when the live lease blocks a stage that still fits its enclosing budget. */
export function mainCompactionStageLeaseRenewal(
  input: Parameters<typeof mainCompactionStageBudget>[0],
): Date | null {
  const deadline = new Date(input.deadlineAt as string | number | Date).getTime();
  if (!Number.isFinite(deadline) || mainCompactionStageBudget(input).allowed) return null;
  const expiresAt = boundedMainCompactionLeaseRenewal({
    leaseExpiresAt: input.leaseExpiresAt,
    requestedExpiresAt: deadline - Math.max(0, input.completionReserveMs || 0),
    now: input.now,
  });
  return expiresAt && mainCompactionStageBudget({ ...input, leaseExpiresAt: expiresAt }).allowed
    ? expiresAt
    : null;
}

/** Compose the exact child's native release with the existing intentional generation Stop ACK. */
export function retainMainCompactionCancellationDelivery(input: {
  signal?: AbortSignal;
  settled: Promise<unknown>;
  capacityReleased: () => boolean;
}): () => void {
  const signal = input.signal;
  if (!signal) return () => {};
  const key = '_viventiumHarnessCancellationDelivery';
  const previous = Object.getOwnPropertyDescriptor(signal, key);
  if (previous && !previous.configurable)
    throw new Error('main_compaction_cancellation_owner_conflict');
  const getter = () => {
    const parentDelivery = previous?.get?.call(signal) ?? previous?.value;
    return Promise.all([parentDelivery, input.settled]).then(([parent]) => {
      const delivered =
        input.capacityReleased() &&
        (parentDelivery == null ||
          (parent as { delivered?: unknown } | undefined)?.delivered === true);
      if (!delivered) throw new Error('main_compaction_native_release_unconfirmed');
      return { delivered: true };
    });
  };
  Object.defineProperty(signal, key, { configurable: true, get: getter });
  return () => {
    if (Object.getOwnPropertyDescriptor(signal, key)?.get !== getter) return;
    if (previous) Object.defineProperty(signal, key, previous);
    else Reflect.deleteProperty(signal, key);
  };
}

/**
 * Another size repair may start only while the proposal keeps shrinking and the claim lease still
 * holds the repair plus its observed fidelity review. Stage-aware callers reuse the same admission
 * owner; the existing slowest-call-only export remains compatible for older callers.
 */
export function mainCompactionSizeRepairBudget(input: {
  state: MainCompactionSizeRepairState | null;
  attempts: number;
  leaseExpiresAt: unknown;
  now: number;
  slowestCallMs: number;
  slowestCompactionCallMs?: number;
  slowestReviewCallMs?: number;
  maxCallMs: number;
}): { allowed: boolean; timeoutMs: number } {
  if (input.slowestCompactionCallMs !== undefined || input.slowestReviewCallMs !== undefined) {
    if (
      input.state?.converging !== true ||
      input.attempts >= MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS
    ) {
      return { allowed: false, timeoutMs: 0 };
    }
    // This caller already clamps the lease to its enclosing deadline minus Main's reserve.
    return mainCompactionStageBudget({
      ...input,
      deadlineAt: input.leaseExpiresAt,
      stage: 'compaction',
    });
  }
  const remaining = mainCompactionLeaseRemainingMs(input.leaseExpiresAt, input.now);
  const reviewReserve = Math.max(0, input.slowestCallMs);
  if (
    input.state?.converging !== true ||
    input.attempts >= MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS ||
    reviewReserve <= 0 ||
    remaining < 2 * reviewReserve
  ) {
    return { allowed: false, timeoutMs: 0 };
  }
  return { allowed: true, timeoutMs: Math.min(input.maxCallMs, remaining - reviewReserve) };
}

/* === VIVENTIUM START ===
 * Fix: an identical compaction claim that already exhausted its repairs on a structural contract
 * failure is not repeated with the same source, contract and compactor. The failure stays visible;
 * a changed source, contract or compactor, or a process reload, lets compaction try again.
 * === VIVENTIUM END === */
const failedCompactions = new Map<
  string,
  { readonly sourceDigest: string; readonly contractKey: string; readonly reason: string }
>();

export function rememberFailedMainCompaction(input: {
  domainEpochKey: unknown;
  sourceDigest: unknown;
  contractKey: unknown;
  reason: unknown;
}): boolean {
  const domainEpochKey = String(input.domainEpochKey ?? '').trim();
  const sourceDigest = String(input.sourceDigest ?? '').trim();
  const contractKey = String(input.contractKey ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  if (!domainEpochKey || !sourceDigest || !contractKey || !reason) return false;
  failedCompactions.set(domainEpochKey, { sourceDigest, contractKey, reason });
  return true;
}

/** The recorded reason when this exact source, contract and compactor already failed, else null. */
export function repeatedFailedMainCompaction(input: {
  domainEpochKey: unknown;
  sourceDigest: unknown;
  contractKey: unknown;
}): string | null {
  const failed = failedCompactions.get(String(input.domainEpochKey ?? '').trim());
  if (!failed) return null;
  return failed.sourceDigest === String(input.sourceDigest ?? '').trim() &&
    failed.contractKey === String(input.contractKey ?? '').trim()
    ? failed.reason
    : null;
}

export function forgetFailedMainCompaction(domainEpochKey: unknown): void {
  failedCompactions.delete(String(domainEpochKey ?? '').trim());
}

/* === VIVENTIUM START ===
 * Fix: the model's compaction grows with the source it summarizes, while the reviewed envelope is
 * fixed. When a claim's model-owned proposal is not accepted within its bounded attempts, the next
 * claim for that epoch takes half as much whole-turn source (at least one whole turn). A promoted
 * claim restores the default. Source is deferred to later claims, never dropped or clipped.
 * === VIVENTIUM END === */
const sourceTargets = new Map<string, number>();

function epochKey(value: unknown): string {
  return String(value ?? '').trim();
}

/** The source target for the next claim of this epoch. */
export function mainCompactionSourceTargetBytes(key: unknown): number {
  return sourceTargets.get(epochKey(key)) ?? MAIN_COMPACTION_SOURCE_TARGET_BYTES;
}

/** Record a claim whose proposal was not accepted: the next claim takes half of its source. */
export function recordUnacceptedMainCompactionClaim(input: {
  key: unknown;
  sourceBytes: unknown;
}): number {
  const key = epochKey(input.key);
  const claimed = Math.floor(Number(input.sourceBytes));
  if (!key || !Number.isFinite(claimed) || claimed <= 0)
    return mainCompactionSourceTargetBytes(key);
  const next = boundedMainCompactionSourceTarget(Math.max(1, Math.floor(claimed / 2)));
  sourceTargets.set(key, next);
  return next;
}

/** A promoted claim restores the default source target. */
export function recordAcceptedMainCompactionClaim(key: unknown): void {
  sourceTargets.delete(epochKey(key));
}

/** Test isolation: clear process-local compaction scheduling state. */
export function resetMainCompactionSchedulingForTests(): void {
  retainedSchedules.clear();
  failedCompactions.clear();
  sourceTargets.clear();
}

/** Later legal reference growth uses the existing runner once, with the full stored source. */
export async function recoverMainContinuityCarrierForAdmission<
  T extends { readonly status?: string },
>(input: {
  request?: { _viventiumAcceptedMainCarrierRecovery?: Set<string> };
  identityKey: string;
  load: () => Promise<T>;
  ensure: () => Promise<object | void>;
}): Promise<T> {
  let context = await input.load();
  if (context.status !== 'context_budget') return context;
  const attempts = input.request
    ? (input.request._viventiumAcceptedMainCarrierRecovery ||= new Set<string>())
    : new Set<string>();
  if (!attempts.has(input.identityKey)) {
    attempts.add(input.identityKey);
    await input.ensure();
    context = await input.load();
  }
  if (context.status !== 'available')
    throw Object.assign(new Error('Prior accepted Main history cannot be carried intact.'), {
      code: 'source_context_unavailable',
      status: 413,
    });
  return context;
}
