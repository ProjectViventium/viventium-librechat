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
  MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
  compatibleMainCompactionSizeContract,
  MAIN_COMPACTION_LEASE_MS,
  boundedMainCompactionSourceTarget,
  mainCompactionProposalBytes,
  boundedMainCompactionLeaseRenewal,
} from './mainContinuity';
import type { MainCompactionStructuralIssue } from './mainContinuity';

type CompactionRouteAgent = { id?: unknown; [key: string]: unknown };
type CompactionRouteRequest = { user?: { id?: unknown } };
const retainedMainCompactionRoutes = new WeakMap<object, {
  ownerId: string; agentId: string; route: Record<string, unknown>;
}>();
const mainCompactionRouteFields = [
  'provider', 'endpoint', 'model', 'model_parameters',
  'fallback_llm_provider', 'fallback_llm_model', 'fallback_llm_model_parameters',
  'viventiumFallbackLlmAssignment',
] as const;

/** Preserve the authorized Main tuple before a request-local surface override mutates it. */
export function retainMainCompactionRoute(
  req: CompactionRouteRequest | null | undefined,
  agent: CompactionRouteAgent,
): boolean {
  const ownerId = String(req?.user?.id || '').trim();
  const agentId = String(agent?.id || '').trim();
  if (!req || !ownerId || !agentId) return false;
  const retained = retainedMainCompactionRoutes.get(req);
  if (retained) {
    if (retained.ownerId !== ownerId || retained.agentId !== agentId)
      throw new Error('main_compaction_route_owner_mismatch');
    return true;
  }
  const route: Record<string, unknown> = {};
  for (const field of mainCompactionRouteFields) {
    const value = agent[field];
    if (field === 'model_parameters' || field === 'fallback_llm_model_parameters') {
      const parameters: Record<string, unknown> = {
        ...(value && typeof value === 'object' ? value as Record<string, unknown> : {}),
      };
      delete parameters.configuration;
      route[field] = structuredClone(parameters);
    } else route[field] = structuredClone(value);
  }
  route.endpoint = agent.endpoint || agent.provider;
  retainedMainCompactionRoutes.set(req, { ownerId, agentId, route });
  return true;
}

/** A background actor uses its request's Main selection, never the Voice surface selection. */
export function resolveMainCompactionAgent<T extends CompactionRouteAgent>(
  req: CompactionRouteRequest | null | undefined,
  agent: T,
): T {
  const retained = req && retainedMainCompactionRoutes.get(req);
  if (!retained) return agent;
  if (retained.ownerId !== String(req?.user?.id || '').trim() ||
      retained.agentId !== String(agent?.id || '').trim())
    throw new Error('main_compaction_route_owner_mismatch');
  return { ...agent, ...structuredClone(retained.route),
    viventiumFallbackLlm: undefined, viventiumFallbackLlmInitializationError: undefined };
}

/** Keep one admitted private stage's exact store lease live; a dead holder still expires normally. */
export function createMainCompactionStageLease(input: {
  signal: AbortSignal;
  graceMs: number;
  leaseExpiresAt: () => unknown;
  renew: (expiresAt: Date) => Promise<{ status?: unknown }>;
  onLost: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  let lost = false;
  let accepted = false;
  let contention = false;
  let requestedExpiry = 0;
  let admitted: { requestId: string; deadlineMs: number } | undefined;
  const expiryMs = () => new Date(input.leaseExpiresAt() as string | number | Date).getTime();
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const lose = () => { lost = true; stop(); if (!input.signal.aborted) input.onLost(); };
  const schedule = () => {
    stop();
    if (closed || lost || !accepted || input.signal.aborted) return;
    const remaining = expiryMs() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { lose(); return; }
    timer = setTimeout(tick, Math.min(MAIN_COMPACTION_LEASE_MS / 2, remaining));
    timer.unref?.();
  };
  const tick = () => {
    timer = undefined;
    if (closed || !admitted || input.signal.aborted) return;
    const now = Date.now();
    const expiry = expiryMs();
    if (!Number.isFinite(expiry) || expiry <= now) { lose(); return; }
    if (pending) { schedule(); return; }
    const target = Math.min(admitted.deadlineMs + input.graceMs, now + MAIN_COMPACTION_LEASE_MS);
    if (target <= now) return;
    if (expiry >= target) { schedule(); return; }
    contention = false;
    requestedExpiry = target;
    pending = Promise.resolve().then(() => input.renew(new Date(target))).then(
      (outcome) => {
        if (outcome.status === 'busy') contention = true;
        else if (outcome.status !== 'renewed') lose();
      },
      () => lose(),
    ).finally(() => { pending = undefined; schedule(); });
    schedule();
  };
  const awaitPending = async () => {
    const operation = pending;
    if (!operation || input.signal.aborted) return;
    await new Promise<void>(resolve => {
      let done = false;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (expiryTimer && timer === expiryTimer) stop();
        input.signal.removeEventListener('abort', finish);
        resolve();
      };
      input.signal.addEventListener('abort', finish, { once: true });
      if (!timer) {
        const remaining = expiryMs() - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) { lose(); finish(); return; }
        expiryTimer = timer = setTimeout(() => { lose(); finish(); }, remaining);
        expiryTimer.unref?.();
      }
      void operation.then(finish, finish);
    });
  };
  return {
    async admit(receipt: { requestId: string; responseDeadlineAt: string }): Promise<boolean> {
      const deadlineMs = Date.parse(receipt.responseDeadlineAt);
      if (closed || input.signal.aborted || !receipt.requestId ||
          !Number.isFinite(deadlineMs) || deadlineMs <= Date.now() ||
          deadlineMs + input.graceMs - Date.now() > 2_147_483_647) return false;
      if (admitted) {
        await awaitPending();
        return accepted && !closed && !lost && !input.signal.aborted &&
          admitted.requestId === receipt.requestId && admitted.deadlineMs === deadlineMs;
      }
      admitted = { requestId: receipt.requestId, deadlineMs };
      tick();
      await awaitPending();
      if (closed || lost || input.signal.aborted || (contention && expiryMs() < requestedExpiry)) {
        admitted = undefined;
        return false;
      }
      accepted = true;
      schedule();
      input.signal.addEventListener('abort', stop, { once: true });
      return true;
    },
    async settle(): Promise<void> {
      closed = true;
      stop();
      input.signal.removeEventListener('abort', stop);
      await awaitPending();
      stop();
    },
  };
}

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

type CompactionCall = {
  readonly callSessionId?: unknown;
  readonly userId?: unknown;
  readonly status?: unknown;
  readonly expiresAtMs?: unknown;
};
const deferredCallCompactions = new Map<string, {
  ownerId: string; callSessionId: string; expiresAt: number; schedule: () => Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
}>();
const endedCompactionCalls = new Map<string, number>();

function pruneCallCompactionSchedules(now: number): void {
  for (const [key, value] of deferredCallCompactions)
    if (value.expiresAt <= now) discardDeferredMainCompaction(key);
  for (const [key, expiresAt] of endedCompactionCalls)
    if (expiresAt <= now) endedCompactionCalls.delete(key);
  while (deferredCallCompactions.size > mainCompactionAcceptanceRetention.maxRetained)
    discardDeferredMainCompaction(deferredCallCompactions.keys().next().value as string);
  while (endedCompactionCalls.size > mainCompactionAcceptanceRetention.maxRetained)
    endedCompactionCalls.delete(endedCompactionCalls.keys().next().value as string);
}

/** Only opportunistic maintenance waits for a verified live Call; source debt stays in its store. */
export function deferAcceptedMainCompactionForCall(input: {
  ownerId: string; domainKey: string; call?: CompactionCall | null;
  schedule: () => Promise<unknown>; now?: number;
}): boolean {
  const now = input.now ?? Date.now(), call = input.call;
  pruneCallCompactionSchedules(now);
  const callSessionId = String(call?.callSessionId ?? '').trim();
  const expiresAt = Number(call?.expiresAtMs);
  if (!input.ownerId || !input.domainKey || !callSessionId ||
      String(call?.userId ?? '') !== input.ownerId || !(expiresAt > now) ||
      !['created', 'connecting', 'listening', 'speaking', 'working', 'needs_input', 'degraded'].includes(String(call?.status)) ||
      endedCompactionCalls.has(`${input.ownerId}\n${callSessionId}`)) return false;
  discardDeferredMainCompaction(input.domainKey);
  deferredCallCompactions.set(input.domainKey, {
    ownerId: input.ownerId, callSessionId, expiresAt, schedule: input.schedule,
  });
  pruneCallCompactionSchedules(now);
  return true;
}

/** Foreground pressure recovery replaces an opportunistic schedule for this same exact domain. */
export function discardDeferredMainCompaction(domainKey: string): void {
  const entry = deferredCallCompactions.get(domainKey);
  if (entry?.timer) clearTimeout(entry.timer);
  deferredCallCompactions.delete(domainKey);
}

/** Re-arm reviewed legacy progress in the existing per-domain deferral scheduler. */
export function deferAcceptedMainCompactionForIdle(input: {
  ownerId: string; domainKey: string; schedule: () => Promise<unknown>;
  shouldYield: () => boolean; onError: (error: unknown) => void; signal?: AbortSignal;
}): boolean {
  if (!input.ownerId || !input.domainKey || input.signal?.aborted) return false;
  const delayMs = 30000;
  pruneCallCompactionSchedules(Date.now());
  discardDeferredMainCompaction(input.domainKey);
  const entry = { ownerId: input.ownerId, callSessionId: '',
    expiresAt: Date.now() + mainCompactionAcceptanceRetention.ttlMs,
    schedule: input.schedule, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  const tick = () => {
    if (deferredCallCompactions.get(input.domainKey) !== entry) return;
    if (input.signal?.aborted) { discardDeferredMainCompaction(input.domainKey); return; }
    if (input.shouldYield()) {
      entry.expiresAt = Date.now() + mainCompactionAcceptanceRetention.ttlMs;
      arm(); return;
    }
    if (entry.expiresAt <= Date.now()) { discardDeferredMainCompaction(input.domainKey); return; }
    discardDeferredMainCompaction(input.domainKey);
    void Promise.resolve().then(entry.schedule).catch(input.onError);
  };
  const arm = () => { entry.timer = setTimeout(tick, delayMs); entry.timer.unref?.(); };
  deferredCallCompactions.set(input.domainKey, entry);
  arm();
  pruneCallCompactionSchedules(Date.now());
  return true;
}

/** The existing terminal Call transition releases each retained domain once, including late acceptance. */
export async function flushEndedCallMainCompactions(call: CompactionCall, now = Date.now()): Promise<number> {
  pruneCallCompactionSchedules(now);
  const ownerId = String(call.userId ?? '').trim(), callSessionId = String(call.callSessionId ?? '').trim();
  if (!ownerId || !callSessionId || call.status !== 'ended') return 0;
  const expiresAt = Number(call.expiresAtMs);
  endedCompactionCalls.set(`${ownerId}\n${callSessionId}`,
    Math.max(Number.isFinite(expiresAt) ? expiresAt : now, now + mainCompactionAcceptanceRetention.ttlMs));
  const schedules: Array<() => Promise<unknown>> = [];
  for (const [key, entry] of deferredCallCompactions) {
    if (entry.ownerId !== ownerId || entry.callSessionId !== callSessionId) continue;
    deferredCallCompactions.delete(key);
    schedules.push(entry.schedule);
  }
  pruneCallCompactionSchedules(now);
  await Promise.all(schedules.map((schedule) => schedule()));
  return schedules.length;
}


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

export { MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS } from './mainContinuity';

export interface MainCompactionSizeRepairState {
  readonly proposalBytes: number | null;
  readonly converging: boolean;
  readonly previousProposalBytes?: number;
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
  return { proposalBytes, converging, ...(previous !== null ? { previousProposalBytes: previous } : {}) };
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
  /** Only the existing Native receipt owner may extend the initial short guard. */
  nativeDeadlineAdmission?: boolean;
  nativeAdmittedWindowMs?: number;
}): { allowed: boolean; timeoutMs: number } {
  const leaseRemaining = mainCompactionLeaseRemainingMs(input.leaseExpiresAt, input.now);
  const deadline = new Date(input.deadlineAt as string | number | Date).getTime();
  if (!Number.isFinite(deadline)) return {
    allowed: leaseRemaining > 0, timeoutMs: Math.min(input.maxCallMs, leaseRemaining),
  };
  const remaining = Math.min(leaseRemaining,
    Math.max(0, deadline - input.now - Math.max(0, input.completionReserveMs || 0)));
  // An unobserved stage has no measured estimate. A different stage's duration is not evidence
  // for it; the live lease, enclosing Main reserve and existing per-call ceiling still bound it.
  const compactionEstimate = Math.max(0, input.slowestCompactionCallMs ?? 0);
  const reviewEstimate = Math.max(0, input.slowestReviewCallMs ?? 0);
  const estimate = input.stage === 'compaction' ? compactionEstimate : reviewEstimate;
  const reserve = input.stage === 'compaction' ? reviewEstimate : 0;
  if (input.nativeDeadlineAdmission === true) {
    const enclosingRemaining = Math.max(0,
      deadline - input.now - Math.max(0, input.completionReserveMs || 0));
    // A measured long Native stage needs its previously accepted receipt window to fit too.
    // The returned guard still ends inside the live lease until a new receipt is accepted.
    const plannedStageMs = estimate > input.maxCallMs
      ? Math.max(estimate, input.nativeAdmittedWindowMs || 0) : estimate;
    const timeoutMs = Math.min(input.maxCallMs, leaseRemaining,
      Math.max(0, enclosingRemaining - reserve));
    return { allowed: timeoutMs > 0 && enclosingRemaining >= plannedStageMs + reserve, timeoutMs };
  }
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
    ? expiresAt : null;
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
  if (previous && !previous.configurable) throw new Error('main_compaction_cancellation_owner_conflict');
  const getter = () => {
    const parentDelivery = previous?.get?.call(signal) ?? previous?.value;
    return Promise.all([parentDelivery, input.settled]).then(([parent]) => {
      const delivered = input.capacityReleased() &&
        (parentDelivery == null || (parent as { delivered?: unknown } | undefined)?.delivered === true);
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
    if (input.state?.converging !== true ||
        input.attempts >= MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS) {
      return { allowed: false, timeoutMs: 0 };
    }
    // This caller already clamps the lease to its enclosing deadline minus Main's reserve.
    return mainCompactionStageBudget({ ...input, deadlineAt: input.leaseExpiresAt,
      stage: 'compaction' });
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
  { readonly sourceDigest: string; readonly contractKey: string; readonly reason: string;
    readonly sizeExhausted?: boolean }
>();

export function rememberFailedMainCompaction(input: {
  domainEpochKey: unknown;
  sourceDigest: unknown;
  contractKey: unknown;
  reason: unknown;
  sizeExhausted?: boolean;
}): boolean {
  const domainEpochKey = String(input.domainEpochKey ?? '').trim();
  const sourceDigest = String(input.sourceDigest ?? '').trim();
  const contractKey = String(input.contractKey ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  if (!domainEpochKey || !sourceDigest || !contractKey || !reason) return false;
  failedCompactions.set(domainEpochKey, { sourceDigest, contractKey, reason,
    ...(input.sizeExhausted === true ? { sizeExhausted: true } : {}) });
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
    (failed.contractKey === String(input.contractKey ?? '').trim() ||
      (failed.sizeExhausted === true && compatibleMainCompactionSizeContract(failed.contractKey, input.contractKey)))
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
  for (const key of deferredCallCompactions.keys()) discardDeferredMainCompaction(key);
  endedCompactionCalls.clear();
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
  signal?: AbortSignal;
  getActiveCompactions?: () => readonly Promise<void>[];
}): Promise<T> {
  const checkStopped = () => {
    if (input.signal?.aborted)
      throw Object.assign(new Error('Main context admission cancelled.'), { name: 'AbortError' });
  };
  let context = await input.load();
  if (context.status !== 'context_budget') return context;
  const joinActive = async (current: T): Promise<{ context: T; waited: boolean }> => {
    let waited = false;
    while (current.status === 'context_budget') {
      checkStopped();
      const active = input.getActiveCompactions?.() || [];
      if (!active.length) return { context: current, waited };
      waited = true;
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          input.signal?.removeEventListener('abort', stop);
          reject(
            Object.assign(new Error('Main context admission cancelled.'), { name: 'AbortError' }),
          );
        };
        input.signal?.addEventListener('abort', stop, { once: true });
        Promise.all(active).then(
          () => {
            input.signal?.removeEventListener('abort', stop);
            resolve();
          },
          (error) => {
            input.signal?.removeEventListener('abort', stop);
            reject(error);
          },
        );
        if (input.signal?.aborted) stop();
      });
      // The existing finite idle batch may admit its next claim at this same boundary.
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkStopped();
      current = await input.load();
      checkStopped();
    }
    return { context: current, waited };
  };
  context = (await joinActive(context)).context;
  if (context.status === 'available') return context;
  checkStopped();
  const attempts = input.request
    ? (input.request._viventiumAcceptedMainCarrierRecovery ||= new Set<string>())
    : new Set<string>();
  if (!attempts.has(input.identityKey)) {
    let retryUnclaimedBusy: boolean;
    do {
      checkStopped();
      attempts.add(input.identityKey);
      const outcome = await input.ensure();
      context = await input.load();
      const joined = await joinActive(context);
      context = joined.context;
      // A pre-claim race did not spend a producer attempt; completed CAS contention did.
      retryUnclaimedBusy =
        context.status === 'context_budget' &&
        joined.waited &&
        !!outcome &&
        'status' in outcome &&
        outcome.status === 'busy' &&
        !('attempts' in outcome);
      if (retryUnclaimedBusy) attempts.delete(input.identityKey);
    } while (retryUnclaimedBusy);
  }
  if (context.status !== 'available')
    throw Object.assign(new Error('Prior accepted Main history cannot be carried intact.'), {
      code: 'source_context_unavailable',
      status: 413,
    });
  return context;
}


type MainCompactionIdleResult = {
  status: string;
  continuationPending?: boolean;
  reason?: string;
  canReduceSource?: boolean;
  sourceDigest?: string;
  sourceBytes?: number;
  domainEpochKey?: string;
  nextSourceTargetBytes?: number;
};

type MainCompactionPreviousSourceClaim = {
  sourceDigest: string;
  sourceBytes: number;
  domainEpochKey: string;
  nextSourceTargetBytes: number;
};

/** Continue reviewed progress or a proven smaller source; never extend the finite batch. */
export async function runMainCompactionIdleBatch<Result extends MainCompactionIdleResult>(input: {
  run: (deadlineAt: string, previousSourceClaim?: MainCompactionPreviousSourceClaim) => Promise<Result>;
  shouldYield: () => boolean;
  now?: () => number;
  yieldIdle?: () => Promise<void>;
  deadlineAt?: string;
}): Promise<Result | MainCompactionIdleResult> {
  const now = input.now || Date.now;
  const inheritedDeadline = input.deadlineAt ? new Date(input.deadlineAt).getTime() : Infinity;
  const deadline = Math.min(now() + 20 * 60 * 1000,
    Number.isFinite(inheritedDeadline) ? inheritedDeadline : Infinity);
  const yieldIdle = input.yieldIdle || (() => new Promise<void>(resolve => setImmediate(resolve)));
  let result: Result | MainCompactionIdleResult = { status: 'deferred', reason: 'interactive_priority' };
  let previousSourceClaim: MainCompactionPreviousSourceClaim | undefined;
  for (let claims = 0; claims < 4; claims++) {
    if (input.shouldYield()) return result;
    if (now() >= deadline) return { ...result, reason: 'idle_budget_exhausted' };
    const next = previousSourceClaim
      ? await input.run(new Date(deadline).toISOString(), previousSourceClaim)
      : await input.run(new Date(deadline).toISOString());
    if (next.status === 'degraded' && next.reason === 'compaction_enclosing_deadline' &&
        result.status === 'compacted' && result.continuationPending === true)
      return { ...result, reason: 'idle_budget_exhausted' };
    result = next;
    if (next.status === 'degraded' && ['schema_invalid', 'source_packet_budget'].includes(String(next.reason)) && next.canReduceSource === true &&
        typeof next.sourceDigest === 'string' && next.sourceDigest &&
        typeof next.domainEpochKey === 'string' && next.domainEpochKey &&
        Number.isSafeInteger(next.sourceBytes) && Number(next.sourceBytes) > 0 &&
        Number.isSafeInteger(next.nextSourceTargetBytes) && Number(next.nextSourceTargetBytes) > 0 &&
        Number(next.nextSourceTargetBytes) < Number(next.sourceBytes) &&
        (!previousSourceClaim || (next.domainEpochKey === previousSourceClaim.domainEpochKey &&
          next.sourceDigest !== previousSourceClaim.sourceDigest &&
          Number(next.sourceBytes) < previousSourceClaim.sourceBytes &&
          Number(next.nextSourceTargetBytes) < previousSourceClaim.nextSourceTargetBytes))) {
      previousSourceClaim = { sourceDigest: next.sourceDigest, sourceBytes: Number(next.sourceBytes),
        domainEpochKey: next.domainEpochKey, nextSourceTargetBytes: Number(next.nextSourceTargetBytes) };
      await yieldIdle();
      continue;
    }
    previousSourceClaim = undefined;
    if (result.status !== 'compacted' || result.continuationPending !== true) return result;
    await yieldIdle();
  }
  return { ...result, reason: 'idle_budget_exhausted' };
}
