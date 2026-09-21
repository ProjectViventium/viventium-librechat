import { interactionPresentationSequence } from '../../agents/interactionContext';
import { logger } from '@librechat/data-schemas';
import type { NativeResponseIdentity, NativeResponseCommit } from '@librechat/data-schemas';
import { randomUUID } from 'crypto';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type {
  SerializableJobData,
  UsageMetadata,
  IJobStore,
  JobStatus,
  InteractionContext,
  LogicalTurnClaim,
  InteractionDeliveryAck,
  DeliveryAcknowledgementResult,
  DeliveryAcknowledgementBindingResult,
  InteractionSourceSegment,
  SourceOrderObservation,
  SourceOrderObservationResult,
  CortexPresentationBinding,
} from '~/stream/interfaces/IJobStore';
import { mergeSourceSegmentsWithOverflow } from '~/stream/sourceSegments';
import { retainLogicalTurnInput, mergeLogicalTurnInput } from './logicalTurnInput';
import { streamLogRef } from '~/stream/logPrivacy';
import {
  nativeIdentityJson,
  nativeIdentityValid,
  nativeJobMatches,
  retainNativeResponse,
  NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
} from './nativeResponse';

interface LogicalTurnState {
  scope: string;
  logicalTurnId: string;
  revision: number;
  active: boolean;
  currentStreamId?: string;
  receipts: Map<string, { streamId: string; interactionContext: InteractionContext }>;
  revisionStreams: Map<number, string>;
  admittedRevisions: Set<number>;
  deliveryAcknowledgements: Map<number, InteractionDeliveryAck>;
  sourceSegments: InteractionSourceSegment[];
  sourceSegmentsOverflowCount: number;
  revisionSourceSegments: Map<number, InteractionSourceSegment[]>;
  revisionSourceSegmentsOverflowCounts: Map<number, number>;
  revisionSourceOrders: Map<number, SourceOrderObservation>;
  currentContext?: InteractionContext;
  pendingInputs?: InteractionContext[];
  completedAt?: number;
}

function logicalTurnScope(userId: string, interactionContext: InteractionContext): string {
  if (interactionContext.source_order_scope) {
    return [
      'source-order',
      interactionContext.source_order_scope,
      interactionContext.actor_kind,
      interactionContext.origin,
    ].join('\u0000');
  }
  return [
    userId,
    interactionContext.conversation_id,
    interactionContext.actor_kind,
    interactionContext.origin,
    ...(interactionContext.turn_scope === 'source_event'
      ? [interactionContext.source_event_id]
      : []),
  ].join('\u0000');
}

/* === VIVENTIUM START ===
 * Feature: Owner-safe stream identity.
 * Purpose: Stream IDs are routing references, not overwrite authority. Preserve the first owner.
 * === VIVENTIUM END === */
function streamIdConflictError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream already exists'), {
    code: 'stream_id_conflict',
  });
}

function streamStoreUnavailableError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream store is unavailable'), {
    code: 'stream_store_unavailable',
  });
}

function streamCapacityExhaustedError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream capacity is exhausted'), {
    code: 'stream_capacity_exhausted',
  });
}

function sameCortexPresentationBinding(
  current: CortexPresentationBinding | undefined,
  expected: CortexPresentationBinding | null,
): boolean {
  if (!current || !expected) return !current && !expected;
  return (
    current.ownerId === expected.ownerId &&
    current.messageId === expected.messageId &&
    current.parentMessageId === expected.parentMessageId &&
    current.revision === expected.revision &&
    current.generation === expected.generation &&
    current.boundAt === expected.boundAt &&
    current.claimToken === expected.claimToken &&
    current.presentationLeaseToken === expected.presentationLeaseToken &&
    current.deliveryIds.length === expected.deliveryIds.length &&
    current.deliveryIds.every((deliveryId, index) => deliveryId === expected.deliveryIds[index]) &&
    current.deliveryReceipts.length === expected.deliveryReceipts.length &&
    current.deliveryReceipts.every(
      (receipt, index) =>
        receipt.deliveryId === expected.deliveryReceipts[index].deliveryId &&
        receipt.graphResultHash === expected.deliveryReceipts[index].graphResultHash,
    )
  );
}

function deliveryAckInput(acknowledgement: InteractionDeliveryAck): string {
  const input = { ...acknowledgement };
  delete input.presentation_committed_at;
  return JSON.stringify(input);
}

/**
 * Content state for a job - volatile, in-memory only.
 * Uses WeakRef to allow garbage collection of graph when no longer needed.
 */
interface ContentState {
  contentParts: Agents.MessageContentComplex[];
  graphRef: WeakRef<StandardGraph> | null;
  collectedUsage: UsageMetadata[];
}

/**
 * In-memory implementation of IJobStore.
 * Suitable for single-instance deployments.
 * For horizontal scaling, use RedisJobStore.
 *
 * Content state is tied to jobs:
 * - Uses WeakRef to graph for live access to contentParts and contentData (run steps)
 * - No chunk persistence needed - same instance handles generation and reconnects
 */
export class InMemoryJobStore implements IJobStore {
  readonly sourceOrderDurability = 'process' as const;

  private nativePublications = new Map<
    string,
    {
      identity?: string;
      state: 'bound' | 'committed' | 'revoked';
      candidateSha256?: string;
      recoverUntil: number;
    }
  >();

  private jobs = new Map<string, SerializableJobData>();
  private contentState = new Map<string, ContentState>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  /* === VIVENTIUM START ===
   * Feature: Owner-safe stream identity.
   * Purpose: Serialize capacity eviction and create-once ownership in the in-process store.
   * === VIVENTIUM END === */
  private createJobTail: Promise<void> = Promise.resolve();
  private destroyed = false;
  private lifecycleEpoch = 0;

  /** Maps userId -> Set of streamIds (conversationIds) for active jobs */
  private userJobMap = new Map<string, Set<string>>();

  /** One synchronous claim state per user/conversation scope. */
  private logicalTurns = new Map<string, LogicalTurnState>();
  /** Core-held source watermarks survive bot process restarts and are shared by all callers. */
  private sourceOrderWatermarks = new Map<
    string,
    { latestSourceSequence: number; observedAt: number; expiresAt: number }
  >();

  /** Reverse owner index; callers never supply user or conversation authority. */
  private logicalTurnIndex = new Map<string, LogicalTurnState>();
  private streamScopes = new Map<string, string>();

  /** Time to keep completed jobs before cleanup (0 = immediate) */
  private ttlAfterComplete = 0;

  /** Bounded retention for inactive source-order scopes. Active turns are never expired. */
  private sourceOrderTtl = 300_000;

  /** Maximum number of concurrent jobs */
  private maxJobs = 1000;

  constructor(options?: { ttlAfterComplete?: number; maxJobs?: number; sourceOrderTtl?: number }) {
    if (options?.ttlAfterComplete) {
      this.ttlAfterComplete = options.ttlAfterComplete;
    }
    if (options?.maxJobs) {
      this.maxJobs = options.maxJobs;
    }
    if (options?.sourceOrderTtl != null) {
      this.sourceOrderTtl = Math.max(1, options.sourceOrderTtl);
    }
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    this.destroyed = false;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[InMemoryJobStore] Initialized with cleanup interval');
  }

  private nativeKey(identity: { logicalTurnId: string; revision: number }): string {
    return JSON.stringify([identity.logicalTurnId, identity.revision]);
  }

  private nativeCurrent(identity: NativeResponseIdentity): boolean {
    const state = this.logicalTurnIndex.get(identity.logicalTurnId);
    return Boolean(
      state &&
      this.logicalTurns.get(state.scope) === state &&
      state.currentStreamId === identity.streamId &&
      state.revision === identity.revision &&
      (!identity.sourceOrderScope ||
        this.sourceOrderWatermarks.get(identity.sourceOrderScope)?.latestSourceSequence ===
          identity.sourceSequence),
    );
  }

  async bindNativeResponse(identity: NativeResponseIdentity): Promise<boolean> {
    const job = this.jobs.get(identity.streamId) ?? null;
    if (
      !nativeIdentityValid(identity) ||
      !nativeJobMatches(job, identity) ||
      job.nativeResponseCancelled ||
      ['aborted', 'superseded'].includes(job.status) ||
      !this.nativeCurrent(identity)
    ) {
      return false;
    }
    const encoded = nativeIdentityJson(identity);
    const prior = this.nativePublications.get(this.nativeKey(identity));
    if (
      (job.nativeResponse && nativeIdentityJson(job.nativeResponse) !== encoded) ||
      (prior && (prior.state === 'revoked' || prior.identity !== encoded))
    ) {
      return false;
    }
    if (!prior && job.status !== 'running') return false;
    if (!prior) {
      this.nativePublications.set(this.nativeKey(identity), {
        identity: encoded,
        state: 'bound',
        recoverUntil: identity.recoverUntil,
      });
    }
    job.nativeResponse = JSON.parse(encoded) as NativeResponseIdentity;
    const watermark =
      identity.sourceOrderScope && this.sourceOrderWatermarks.get(identity.sourceOrderScope);
    if (watermark) watermark.expiresAt = Math.max(watermark.expiresAt, identity.recoverUntil);
    return true;
  }

  async commitNativeResponse(
    identity: NativeResponseIdentity,
    candidateSha256: string,
  ): Promise<NativeResponseCommit> {
    if (!nativeIdentityValid(identity) || !/^[a-f0-9]{64}$/.test(candidateSha256)) {
      return { status: 'unavailable' };
    }
    const record = this.nativePublications.get(this.nativeKey(identity));
    const job = this.jobs.get(identity.streamId) ?? null;
    if (
      !record ||
      !nativeJobMatches(job, identity) ||
      record.identity !== nativeIdentityJson(identity)
    ) {
      return { status: 'unavailable' };
    }
    if (record.state === 'committed') {
      return record.candidateSha256 === candidateSha256
        ? { status: 'committed', candidateSha256 }
        : { status: 'revoked' };
    }
    if (
      record.state === 'revoked' ||
      job.nativeResponseCancelled ||
      !this.nativeCurrent(identity)
    ) {
      return { status: 'revoked' };
    }
    record.state = 'committed';
    record.candidateSha256 = candidateSha256;
    return { status: 'committed', candidateSha256 };
  }

  async getNativeResponseCommit(identity: NativeResponseIdentity): Promise<NativeResponseCommit> {
    if (!nativeIdentityValid(identity)) return { status: 'unavailable' };
    const record = this.nativePublications.get(this.nativeKey(identity));
    if (!record || record.identity !== nativeIdentityJson(identity)) {
      return { status: 'unavailable' };
    }
    return record.state === 'committed'
      ? { status: 'committed', candidateSha256: record.candidateSha256 }
      : { status: record.state === 'revoked' ? 'revoked' : 'unavailable' };
  }

  async revokeNativeResponse(identity: NativeResponseIdentity): Promise<NativeResponseCommit> {
    if (!nativeIdentityValid(identity)) return { status: 'unavailable' };
    const record = this.nativePublications.get(this.nativeKey(identity));
    if (!record || record.identity !== nativeIdentityJson(identity)) {
      return { status: 'unavailable' };
    }
    if (record.state === 'committed') {
      return { status: 'committed', candidateSha256: record.candidateSha256 };
    }
    record.state = 'revoked';
    const job = this.jobs.get(identity.streamId) ?? null;
    if (nativeJobMatches(job, identity)) job.nativeResponseCancelled = true;
    return { status: 'revoked' };
  }

  async cancelNativeResponse(expected: SerializableJobData): Promise<NativeResponseCommit> {
    const job = this.jobs.get(expected.streamId);
    if (
      !job ||
      job.createdAt !== expected.createdAt ||
      job.responseMessageId !== expected.responseMessageId ||
      job.userId !== expected.userId
    ) {
      return { status: 'unavailable' };
    }
    if (job.nativeResponse) return this.revokeNativeResponse(job.nativeResponse);
    const context = job.interactionContext;
    if (context?.logical_turn_id) {
      this.nativePublications.set(
        this.nativeKey({ logicalTurnId: context.logical_turn_id, revision: context.revision }),
        { state: 'revoked', recoverUntil: job.createdAt + NATIVE_RESPONSE_RECOVERY_WINDOW_MS },
      );
    }
    job.nativeResponseCancelled = true;
    return { status: 'revoked' };
  }

  async settleNativeResponse(
    identity: NativeResponseIdentity,
    mode?: 'unsupported' | 'cancelled',
  ): Promise<boolean> {
    const receipt = await this.getNativeResponseCommit(identity);
    const job = this.jobs.get(identity.streamId) ?? null;
    if (mode === 'unsupported') {
      if (
        receipt.status !== 'revoked' ||
        !nativeJobMatches(job, identity) ||
        job.nativeResponseFinished ||
        (job.nativeResponse &&
          nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity))
      ) {
        return false;
      }
      delete job.nativeResponse;
      delete job.nativeResponseCancelled;
      return true;
    }
    if (
      receipt.status !== (mode === 'cancelled' ? 'revoked' : 'committed') ||
      !nativeJobMatches(job, identity) ||
      Boolean(job.nativeResponseCancelled) !== (mode === 'cancelled') ||
      !job.nativeResponseFinished
    ) {
      return false;
    }
    job.nativeResponseSettled = true;
    return true;
  }

  async finishNativeResponse(
    identity: NativeResponseIdentity,
    candidateSha256: string,
    finalEvent: string,
    mode?: 'cancelled',
  ): Promise<boolean> {
    const receipt = await this.getNativeResponseCommit(identity);
    const job = this.jobs.get(identity.streamId) ?? null;
    if (
      (mode === 'cancelled'
        ? receipt.status !== 'revoked' || !job?.nativeResponseCancelled
        : receipt.status !== 'committed' ||
          receipt.candidateSha256 !== candidateSha256 ||
          job?.nativeResponseCancelled) ||
      !nativeJobMatches(job, identity) ||
      !job.nativeResponse ||
      nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity)
    ) {
      return false;
    }
    if (job.nativeResponseFinished) return job.finalEvent === finalEvent;
    job.finalEvent = finalEvent;
    job.nativeResponseFinished = true;
    job.generationCompleted = true;
    job.status = mode === 'cancelled' ? 'aborted' : 'complete';
    job.completedAt = Date.now();
    delete job.error;
    return true;
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    initialData?: Partial<SerializableJobData>,
  ): Promise<SerializableJobData> {
    /* === VIVENTIUM START ===
     * Feature: Owner-safe stream identity.
     * Purpose: An await during capacity eviction must not let a second creator pass the same key.
     * === VIVENTIUM END === */
    const lifecycleEpoch = this.lifecycleEpoch;
    const unavailableAtEnqueue = this.destroyed;
    let releaseCreate!: () => void;
    const precedingCreate = this.createJobTail;
    this.createJobTail = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await precedingCreate;

    try {
      if (unavailableAtEnqueue || this.destroyed || lifecycleEpoch !== this.lifecycleEpoch) {
        throw streamStoreUnavailableError();
      }
      const previous = this.jobs.get(streamId);
      const reservedScope = this.streamScopes.get(streamId);
      const reservedState = reservedScope ? this.logicalTurns.get(reservedScope) : undefined;
      const reservedContext = initialData?.interactionContext;
      const replacesReservedRevision = Boolean(
        previous &&
        reservedScope &&
        reservedContext &&
        logicalTurnScope(userId, reservedContext) === reservedScope &&
        reservedState?.currentStreamId === streamId &&
        reservedState.revision === reservedContext.revision &&
        (previous.interactionContext?.revision ?? 0) < reservedContext.revision,
      );
      const replacesSameOwner =
        previous != null &&
        previous.userId === userId &&
        previous.conversationId === conversationId &&
        (initialData?.interactionContext == null || replacesReservedRevision);
      if (previous && !replacesSameOwner) {
        throw streamIdConflictError();
      }
      if (previous) {
        const cancellation = await this.cancelNativeResponse(previous);
        if (cancellation.status === 'committed' && !previous.nativeResponseSettled) {
          throw new Error('Saved native result is pending');
        }
        if (this.jobs.get(streamId) !== previous) {
          throw new Error('Stream incarnation changed');
        }
      }
      if (reservedScope && !replacesSameOwner) {
        const interactionContext = initialData?.interactionContext;
        const state = this.logicalTurns.get(reservedScope);
        const receipt = interactionContext
          ? state?.receipts.get(interactionContext.source_event_id)
          : undefined;
        const exactReservation =
          interactionContext != null &&
          logicalTurnScope(userId, interactionContext) === reservedScope &&
          state != null &&
          state.logicalTurnId === interactionContext.logical_turn_id &&
          receipt?.streamId === streamId &&
          state.revisionStreams.get(interactionContext.revision) === streamId &&
          receipt.interactionContext.logical_turn_id === interactionContext.logical_turn_id &&
          receipt.interactionContext.revision === interactionContext.revision &&
          !Array.from(state.admittedRevisions).some(
            (revision) => revision > interactionContext.revision,
          );
        if (!exactReservation) {
          throw streamIdConflictError();
        }
      } else if (!reservedScope && initialData?.interactionContext) {
        // Context-bearing jobs are admitted only through claimLogicalTurn. A low-level caller may
        // still create a legacy context-free job when no logical reservation exists.
        throw streamIdConflictError();
      }
      if (this.jobs.size >= this.maxJobs && !previous) {
        // Never evict a live generation to admit a newer caller. Completed/error jobs are
        // retired by the normal lifecycle cleanup, which also owns their turn indexes.
        throw streamCapacityExhaustedError();
      }
      if (this.destroyed || lifecycleEpoch !== this.lifecycleEpoch) {
        throw streamStoreUnavailableError();
      }

      const job: SerializableJobData = {
        ...initialData,
        streamId,
        userId,
        status: 'running',
        createdAt: Math.max(Date.now(), (previous?.createdAt ?? 0) + 1),
        nativeResponse: undefined,
        nativeResponseCancelled: undefined,
        nativeResponseFinished: undefined,
        nativeResponseSettled: undefined,
        conversationId,
        syncSent: false,
      };

      if (previous) {
        previous.nativeResponseCancelled = true;
        delete previous.finalEvent;
      }
      this.jobs.set(streamId, job);
      if (initialData?.interactionContext) {
        const state = this.logicalTurns.get(reservedScope!);
        if (state) {
          state.admittedRevisions.add(initialData.interactionContext.revision);
        }
      }

      // Track job by userId for efficient user-scoped queries
      let userJobs = this.userJobMap.get(userId);
      if (!userJobs) {
        userJobs = new Set();
        this.userJobMap.set(userId, userJobs);
      }
      userJobs.add(streamId);

      logger.debug(`[InMemoryJobStore] Created job ${streamLogRef(streamId)}`);

      return job;
    } finally {
      releaseCreate();
    }
  }

  async retainLogicalTurnInput(
    userId: string,
    context: InteractionContext,
  ): Promise<InteractionContext> {
    const scope = logicalTurnScope(userId, context);
    let state = this.logicalTurns.get(scope);
    mergeLogicalTurnInput(
      [
        ...(state?.active && state.currentContext ? [state.currentContext] : []),
        ...(state?.pendingInputs ?? []),
      ],
      context,
    );
    if (!state) {
      state = {
        scope,
        logicalTurnId: randomUUID(),
        revision: 0,
        active: false,
        receipts: new Map(),
        revisionStreams: new Map(),
        admittedRevisions: new Set(),
        deliveryAcknowledgements: new Map(),
        sourceSegments: [],
        sourceSegmentsOverflowCount: 0,
        revisionSourceSegments: new Map(),
        revisionSourceSegmentsOverflowCounts: new Map(),
        revisionSourceOrders: new Map(),
      };
      this.logicalTurns.set(scope, state);
    }
    if (
      state.receipts.has(context.source_event_id) ||
      state.currentContext?.source_segments?.some(
        (source) => source.source_event_id === context.source_event_id,
      )
    ) {
      return context;
    }
    state.pendingInputs = retainLogicalTurnInput(state.pendingInputs ?? [], context);
    state.completedAt = Date.now();
    return context;
  }

  async claimLogicalTurn(
    streamId: string,
    userId: string,
    interactionContext: InteractionContext,
  ): Promise<LogicalTurnClaim> {
    const scope = logicalTurnScope(userId, interactionContext);
    let existing = this.logicalTurns.get(scope);
    const reservedScope = this.streamScopes.get(streamId);
    if (
      !this.jobs.has(streamId) &&
      reservedScope === scope &&
      existing &&
      !existing.active &&
      existing.currentStreamId === streamId &&
      existing.completedAt != null
    ) {
      this.retireLogicalTurnState(existing);
      existing = undefined;
    }
    const receipt = existing?.receipts.get(interactionContext.source_event_id);
    if (receipt) {
      return {
        status: 'duplicate',
        streamId: receipt.streamId,
        interactionContext: receipt.interactionContext,
        supersededStreamIds: [],
      };
    }

    if (interactionContext.ready_input_continuation && existing?.active) {
      return { status: 'busy', streamId, interactionContext, supersededStreamIds: [] };
    }
    const observedSourceOrder = interactionContext.source_order_scope
      ? this.sourceOrderWatermarks.get(interactionContext.source_order_scope)
      : undefined;
    const activeSourceOrder = existing?.active
      ? existing.revisionSourceOrders.get(existing.revision)
      : undefined;
    const latestSourceSequence = Math.max(
      observedSourceOrder?.latestSourceSequence ?? -1,
      activeSourceOrder &&
        activeSourceOrder.source_order_scope === interactionContext.source_order_scope
        ? activeSourceOrder.source_sequence
        : -1,
    );
    if (
      !existing &&
      !interactionContext.ready_input_continuation &&
      interactionContext.source_order_scope &&
      Number.isSafeInteger(interactionContext.source_sequence) &&
      interactionContext.source_sequence! < latestSourceSequence
    ) {
      return {
        status: 'stale_source_order',
        streamId,
        interactionContext,
        supersededStreamIds: [],
      };
    }
    const presentationSequence = interactionPresentationSequence(interactionContext);
    const latestPresentationSequence = interactionContext.source_order_scope
      ? Math.max(
          this.sourceOrderWatermarks.get(interactionContext.source_order_scope)
            ?.latestSourceSequence ?? 0,
          interactionPresentationSequence(existing?.currentContext) ?? 0,
          ...(existing?.pendingInputs ?? []).flatMap((input) =>
            (input.source_segments ?? []).map((segment) => segment.source_sequence ?? 0),
          ),
        )
      : undefined;
    if (
      presentationSequence != null &&
      latestPresentationSequence != null &&
      presentationSequence < latestPresentationSequence
    ) {
      return { status: 'superseded', streamId, interactionContext, supersededStreamIds: [] };
    }
    const pendingInputs = existing?.pendingInputs ?? [];
    const mergedInput = mergeLogicalTurnInput(pendingInputs, interactionContext);
    if (
      mergedInput.source_segments?.some(
        (segment) => segment.source_message_id && segment.source_persisted !== true,
      )
    ) {
      return { status: 'initializing', streamId, interactionContext, supersededStreamIds: [] };
    }

    /* === VIVENTIUM START ===
     * Feature: Owner-safe logical-turn reservation.
     * Purpose: Claiming a turn must not overwrite another scope's stream reverse index before
     * createJob can enforce its create-once owner fence.
     * === VIVENTIUM END === */
    const reusesCurrentStream =
      existing?.active === true &&
      existing.currentStreamId === streamId &&
      this.streamScopes.get(streamId) === scope &&
      this.jobs.get(streamId)?.userId === userId;
    if ((this.jobs.has(streamId) || this.streamScopes.has(streamId)) && !reusesCurrentStream) {
      throw streamIdConflictError();
    }

    const activeStreamId = existing?.active ? existing.currentStreamId : undefined;
    const continuesTurn = activeStreamId != null;
    const continuesPending = !continuesTurn && Boolean(existing?.pendingInputs?.length);
    if (!continuesTurn && existing && !continuesPending) {
      this.retireLogicalTurnState(existing);
    }
    const state: LogicalTurnState =
      continuesTurn || continuesPending
        ? existing!
        : {
            scope,
            logicalTurnId: randomUUID(),
            revision: 0,
            active: false,
            receipts: new Map(),
            revisionStreams: new Map(),
            admittedRevisions: new Set(),
            deliveryAcknowledgements: new Map(),
            sourceSegments: [],
            sourceSegmentsOverflowCount: 0,
            revisionSourceSegments: new Map(),
            revisionSourceSegmentsOverflowCounts: new Map(),
            revisionSourceOrders: new Map(),
          };
    state.completedAt = undefined;
    state.revision += 1;
    const mergedSourceSegments = mergeSourceSegmentsWithOverflow(
      continuesTurn ? state.sourceSegments : [],
      mergedInput.source_segments ? [...mergedInput.source_segments] : undefined,
      continuesTurn ? state.sourceSegmentsOverflowCount : 0,
      mergedInput.source_segments_overflow_count,
    );
    state.sourceSegments = mergedSourceSegments.segments;
    state.sourceSegmentsOverflowCount = mergedSourceSegments.overflowCount;

    const claimedContext: InteractionContext = Object.freeze({
      ...mergedInput,
      logical_turn_id: state.logicalTurnId,
      revision: state.revision,
      ...(state.sourceSegments.length
        ? { source_segments: state.sourceSegments.map((segment) => ({ ...segment })) }
        : {}),
      ...(state.sourceSegmentsOverflowCount > 0
        ? { source_segments_overflow_count: state.sourceSegmentsOverflowCount }
        : {}),
    });
    const supersededStreamIds = continuesTurn && activeStreamId ? [activeStreamId] : [];
    state.currentContext = claimedContext;
    state.pendingInputs = [];
    state.currentStreamId = streamId;
    state.active = true;
    state.revisionStreams.set(state.revision, streamId);
    state.revisionSourceSegments.set(
      state.revision,
      state.sourceSegments.map((segment) => ({ ...segment })),
    );
    state.revisionSourceSegmentsOverflowCounts.set(
      state.revision,
      state.sourceSegmentsOverflowCount,
    );
    if (
      claimedContext.source_order_scope &&
      Number.isSafeInteger(claimedContext.source_sequence) &&
      claimedContext.source_sequence! >= 0
    ) {
      state.revisionSourceOrders.set(state.revision, {
        source_order_scope: claimedContext.source_order_scope,
        source_sequence: claimedContext.source_sequence!,
      });
    }
    state.receipts.set(interactionContext.source_event_id, {
      streamId,
      interactionContext: claimedContext,
    });
    this.logicalTurns.set(scope, state);
    this.logicalTurnIndex.set(state.logicalTurnId, state);
    this.streamScopes.set(streamId, scope);

    return {
      status: 'claimed',
      streamId,
      interactionContext: claimedContext,
      supersededStreamIds,
    };
  }

  async observeSourceOrder(
    observation: SourceOrderObservation,
  ): Promise<SourceOrderObservationResult> {
    const observedAt = Date.now();
    let existing = this.sourceOrderWatermarks.get(observation.source_order_scope);
    if (
      existing &&
      existing.expiresAt <= observedAt &&
      !this.hasActiveSourceOrderScope(observation.source_order_scope)
    ) {
      this.sourceOrderWatermarks.delete(observation.source_order_scope);
      existing = undefined;
    }
    const stale = existing != null && observation.source_sequence < existing.latestSourceSequence;
    const latestSourceSequence = Math.max(
      observation.source_sequence,
      existing?.latestSourceSequence ?? observation.source_sequence,
    );
    const watermark = {
      latestSourceSequence,
      observedAt:
        existing && latestSourceSequence === existing.latestSourceSequence
          ? existing.observedAt
          : observedAt,
      expiresAt: observedAt + this.sourceOrderTtl,
    };
    this.sourceOrderWatermarks.set(observation.source_order_scope, watermark);
    return {
      latest_source_sequence: watermark.latestSourceSequence,
      observed_at: watermark.observedAt,
      stale,
    };
  }

  async rollbackLogicalTurnClaim(
    streamId: string,
    interactionContext: InteractionContext,
  ): Promise<boolean> {
    const scope = this.streamScopes.get(streamId);
    const state = scope ? this.logicalTurns.get(scope) : undefined;
    const receipt = state?.receipts.get(interactionContext.source_event_id);
    if (
      !scope ||
      !state ||
      state.logicalTurnId !== interactionContext.logical_turn_id ||
      receipt?.streamId !== streamId ||
      receipt.interactionContext.revision !== interactionContext.revision ||
      state.revisionStreams.get(interactionContext.revision) !== streamId ||
      state.admittedRevisions.has(interactionContext.revision) ||
      this.jobs.has(streamId)
    ) {
      return false;
    }
    if (receipt?.streamId === streamId) {
      state.receipts.delete(interactionContext.source_event_id);
    }
    state.revisionStreams.delete(interactionContext.revision);
    state.revisionSourceSegments.delete(interactionContext.revision);
    state.revisionSourceSegmentsOverflowCounts.delete(interactionContext.revision);
    state.revisionSourceOrders.delete(interactionContext.revision);
    this.streamScopes.delete(streamId);
    if (state.currentStreamId === streamId) {
      state.revision = Math.max(0, ...state.revisionStreams.keys());
    }
    if (state.revision > 0) {
      state.currentStreamId = state.revisionStreams.get(state.revision);
      state.sourceSegments = (state.revisionSourceSegments.get(state.revision) || []).map(
        (segment) => ({ ...segment }),
      );
      state.sourceSegmentsOverflowCount =
        state.revisionSourceSegmentsOverflowCounts.get(state.revision) || 0;
      state.active = Boolean(state.currentStreamId);
    } else {
      state.pendingInputs = retainLogicalTurnInput(state.pendingInputs ?? [], interactionContext);
      state.currentStreamId = undefined;
      state.sourceSegments = [];
      state.sourceSegmentsOverflowCount = 0;
      state.active = false;
      state.completedAt = Date.now();
      /* === VIVENTIUM START ===
       * Feature: Bounded failed-admission state.
       * Purpose: A rolled-back first revision owns no durable job and must not accumulate until
       * the periodic cleanup tick under repeated capacity pressure.
       * === VIVENTIUM END === */
      if (!state.pendingInputs?.length) {
        this.retireLogicalTurnState(state);
      }
    }
    return true;
  }

  async forgetMissingSourceEventReceipt(
    interactionContext: InteractionContext,
    expectedStreamId: string,
  ): Promise<boolean> {
    const logicalTurnId = interactionContext.logical_turn_id;
    const state = logicalTurnId ? this.logicalTurnIndex.get(logicalTurnId) : undefined;
    const receipt = state?.receipts.get(interactionContext.source_event_id);
    /* === VIVENTIUM START ===
     * Feature: Durable source-event idempotency.
     * Purpose: Missing job data is not stale while the current claim is still creating that job.
     * === VIVENTIUM END === */
    const isClaimStillInFlight = state?.active && state.currentStreamId === expectedStreamId;
    if (
      !state ||
      this.logicalTurns.get(state.scope) !== state ||
      receipt?.streamId !== expectedStreamId ||
      isClaimStillInFlight
    ) {
      return false;
    }
    state.receipts.delete(interactionContext.source_event_id);
    return true;
  }

  async completeLogicalTurn(streamId: string, expected?: NativeResponseIdentity): Promise<void> {
    if (expected) {
      const state = this.logicalTurnIndex.get(expected.logicalTurnId);
      if (
        expected.streamId !== streamId ||
        !state ||
        this.logicalTurns.get(state.scope) !== state ||
        state.revision !== expected.revision ||
        state.currentStreamId !== streamId ||
        state.revisionStreams.get(expected.revision) !== streamId
      ) {
        return;
      }
      state.active = false;
      state.completedAt = Date.now();
      return;
    }
    const scope = this.streamScopes.get(streamId);
    if (!scope) {
      return;
    }
    const state = this.logicalTurns.get(scope);
    if (state?.currentStreamId === streamId) {
      state.active = false;
      state.completedAt = Date.now();
    }
  }

  async isCurrentLogicalTurn(streamId: string): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job || !['running', 'complete'].includes(job.status)) {
      return false;
    }
    if (!job.interactionContext) {
      return true;
    }
    const scope = this.streamScopes.get(streamId);
    if (!scope) {
      return false;
    }
    return this.logicalTurns.get(scope)?.currentStreamId === streamId;
  }

  async resolveDeliveryOwner(logicalTurnId: string, revision: number): Promise<string | null> {
    const state = this.logicalTurnIndex.get(logicalTurnId);
    if (!state || this.logicalTurns.get(state.scope) !== state) {
      return null;
    }
    return state.revisionStreams.get(revision) ?? null;
  }

  async acknowledgeDelivery(
    acknowledgement: InteractionDeliveryAck,
  ): Promise<DeliveryAcknowledgementResult> {
    const state = this.logicalTurnIndex.get(acknowledgement.logical_turn_id);
    if (!state || this.logicalTurns.get(state.scope) !== state) {
      return { status: 'not_found' };
    }
    const ownerStreamId = state.revisionStreams.get(acknowledgement.revision);
    if (!ownerStreamId || acknowledgement.revision > state.revision) {
      return { status: 'stale_revision' };
    }
    const existingAcknowledgement = state.deliveryAcknowledgements.get(acknowledgement.revision);
    if (existingAcknowledgement) {
      const idempotent =
        deliveryAckInput(existingAcknowledgement) === deliveryAckInput(acknowledgement);
      return idempotent
        ? {
            status: 'recorded',
            acknowledgement: existingAcknowledgement,
            idempotent: true,
            ownerStreamId,
          }
        : { status: 'conflict' };
    }
    if (acknowledgement.revision < state.revision && acknowledgement.state === 'committed') {
      return { status: 'stale_revision' };
    }
    const sourceOrder = state.revisionSourceOrders.get(acknowledgement.revision);
    const latestSourceOrder = sourceOrder
      ? this.sourceOrderWatermarks.get(sourceOrder.source_order_scope)
      : undefined;
    if (
      ['committed', 'committed_effect'].includes(acknowledgement.state) &&
      sourceOrder &&
      latestSourceOrder &&
      latestSourceOrder.latestSourceSequence > sourceOrder.source_sequence
    ) {
      return { status: 'stale_source_order' };
    }
    const recordedAcknowledgement = { ...acknowledgement };
    delete recordedAcknowledgement.presentation_committed_at;
    if (['committed', 'committed_effect'].includes(recordedAcknowledgement.state)) {
      recordedAcknowledgement.presentation_committed_at = Date.now();
    }
    Object.freeze(recordedAcknowledgement);
    state.deliveryAcknowledgements.set(acknowledgement.revision, recordedAcknowledgement);
    if (
      acknowledgement.revision === state.revision &&
      (acknowledgement.state === 'committed' || acknowledgement.state === 'failed')
    ) {
      state.active = false;
      state.completedAt = Date.now();
      if (sourceOrder) {
        const watermark = this.sourceOrderWatermarks.get(sourceOrder.source_order_scope);
        if (watermark) {
          watermark.expiresAt = Date.now() + this.sourceOrderTtl;
        }
      }
    }
    return {
      status: 'recorded',
      acknowledgement: recordedAcknowledgement,
      idempotent: false,
      ownerStreamId,
    };
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    return this.jobs.get(streamId) ?? null;
  }

  async updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedNativeIdentity?: NativeResponseIdentity,
  ): Promise<void> {
    const job = this.jobs.get(streamId);
    if (
      !job ||
      (expectedNativeIdentity &&
        (!nativeJobMatches(job, expectedNativeIdentity) ||
          !job.nativeResponse ||
          nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(expectedNativeIdentity)))
    ) {
      return;
    }
    const safe = { ...updates };
    delete safe.nativeResponse;
    delete safe.nativeResponseCancelled;
    delete safe.nativeResponseFinished;
    delete safe.nativeResponseSettled;
    if (job.nativeResponse) {
      for (const key of [
        'createdAt',
        'userId',
        'streamId',
        'conversationId',
        'responseMessageId',
        'userMessage',
        'interactionContext',
        'finalEvent',
        'generationCompleted',
      ] as const) {
        delete safe[key];
      }
      if (job.nativeResponseFinished) {
        delete safe.status;
        delete safe.error;
        delete safe.completedAt;
      }
    }
    Object.assign(job, safe);
  }

  /* === VIVENTIUM START === Exact owner/generation/hash Cortex binding replay. === */
  async bindCortexPresentation(
    streamId: string,
    binding: CortexPresentationBinding,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job) return false;
    const current = job.cortexPresentation;
    if (current) {
      if (binding.revision < current.revision || binding.generation < current.generation) {
        return false;
      }
      if (binding.revision === current.revision && binding.generation === current.generation) {
        return (
          binding.ownerId === current.ownerId &&
          binding.messageId === current.messageId &&
          binding.parentMessageId === current.parentMessageId &&
          binding.claimToken === current.claimToken &&
          binding.presentationLeaseToken === current.presentationLeaseToken &&
          binding.deliveryIds.length === current.deliveryIds.length &&
          binding.deliveryIds.every(
            (deliveryId, index) => deliveryId === current.deliveryIds[index],
          ) &&
          binding.deliveryReceipts.length === current.deliveryReceipts.length &&
          binding.deliveryReceipts.every(
            (receipt, index) =>
              receipt.deliveryId === current.deliveryReceipts[index].deliveryId &&
              receipt.graphResultHash === current.deliveryReceipts[index].graphResultHash,
          )
        );
      }
    }
    job.cortexPresentation = binding;
    return true;
  }

  async bindDeliveryAcknowledgement(
    streamId: string,
    acknowledgement: InteractionDeliveryAck,
    expectedCortexPresentation: CortexPresentationBinding | null,
  ): Promise<DeliveryAcknowledgementBindingResult> {
    const job = this.jobs.get(streamId);
    if (!job) return { status: 'not_found' };
    if (!expectedCortexPresentation) {
      job.deliveryAcknowledgement = acknowledgement;
      return { status: 'recorded', acknowledgement };
    }
    if (!sameCortexPresentationBinding(job.cortexPresentation, expectedCortexPresentation)) {
      return { status: 'retryable_conflict' };
    }
    const existingAcknowledgement = job.cortexDeliveryAcknowledgement;
    const existingPresentation = job.cortexDeliveryAcknowledgementPresentation;
    if (existingAcknowledgement || existingPresentation) {
      if (!existingAcknowledgement || !existingPresentation) {
        return { status: 'retryable_conflict' };
      }
      const idempotent =
        deliveryAckInput(existingAcknowledgement) === deliveryAckInput(acknowledgement);
      if (sameCortexPresentationBinding(existingPresentation, expectedCortexPresentation)) {
        return idempotent
          ? {
              status: 'recorded',
              acknowledgement: existingAcknowledgement,
              idempotent: true,
              cortexPresentation: expectedCortexPresentation,
            }
          : { status: 'conflict' };
      }
      if (idempotent) {
        job.cortexDeliveryAcknowledgementPresentation = expectedCortexPresentation;
        return {
          status: 'recorded',
          acknowledgement: existingAcknowledgement,
          idempotent: true,
          cortexPresentation: expectedCortexPresentation,
        };
      }
    }
    const recordedAcknowledgement = { ...acknowledgement };
    delete recordedAcknowledgement.presentation_committed_at;
    recordedAcknowledgement.presentation_committed_at = Date.now();
    Object.freeze(recordedAcknowledgement);
    job.cortexDeliveryAcknowledgement = recordedAcknowledgement;
    job.cortexDeliveryAcknowledgementPresentation = expectedCortexPresentation;
    return {
      status: 'recorded',
      acknowledgement: recordedAcknowledgement,
      idempotent: false,
      cortexPresentation: expectedCortexPresentation,
    };
  }
  /* === VIVENTIUM END === */

  async deleteJob(streamId: string, retiredNativeResponse?: NativeResponseIdentity): Promise<void> {
    const job = this.jobs.get(streamId);
    if (retiredNativeResponse && job) {
      if (
        !job.nativeResponse ||
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(retiredNativeResponse)
      ) {
        return;
      }
      job.nativeResponseCancelled = true;
      delete job.finalEvent;
    } else if (job && retainNativeResponse(job)) {
      return;
    }
    this.jobs.delete(streamId);
    this.contentState.delete(streamId);
    if (job) {
      const userJobs = this.userJobMap.get(job.userId);
      userJobs?.delete(streamId);
      if (userJobs?.size === 0) {
        this.userJobMap.delete(job.userId);
      }
    }
    logger.debug(`[InMemoryJobStore] Deleted job ${streamLogRef(streamId)}`);
  }

  async hasJob(streamId: string): Promise<boolean> {
    return this.jobs.has(streamId);
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    const running: SerializableJobData[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        running.push(job);
      }
    }
    return running;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [streamId, job] of this.jobs) {
      if (retainNativeResponse(job, now)) {
        continue;
      }
      if (job.nativeResponse && job.nativeResponse.recoverUntil <= now) {
        toDelete.push(streamId);
        continue;
      }
      const isFinished = ['complete', 'error', 'aborted', 'superseded'].includes(job.status);
      if (isFinished && job.completedAt) {
        // TTL of 0 means immediate cleanup, otherwise wait for TTL to expire
        if (this.ttlAfterComplete === 0 || now - job.completedAt > this.ttlAfterComplete) {
          toDelete.push(streamId);
        }
      }
    }

    for (const id of toDelete) {
      await this.deleteJob(id);
    }

    for (const state of this.logicalTurns.values()) {
      if (
        !state.active &&
        state.completedAt != null &&
        (this.ttlAfterComplete === 0 || now - state.completedAt > this.ttlAfterComplete)
      ) {
        this.retireLogicalTurnState(state);
      }
    }

    for (const [scope, watermark] of this.sourceOrderWatermarks) {
      if (watermark.expiresAt <= now && !this.hasActiveSourceOrderScope(scope)) {
        this.sourceOrderWatermarks.delete(scope);
      }
    }
    for (const [key, publication] of this.nativePublications) {
      if (publication.recoverUntil <= now) {
        this.nativePublications.delete(key);
      }
    }

    if (toDelete.length > 0) {
      logger.debug(`[InMemoryJobStore] Cleaned up ${toDelete.length} expired jobs`);
    }

    return toDelete.length;
  }

  private retireLogicalTurnState(state: LogicalTurnState): void {
    if (this.logicalTurns.get(state.scope) === state) {
      this.logicalTurns.delete(state.scope);
    }
    if (this.logicalTurnIndex.get(state.logicalTurnId) === state) {
      this.logicalTurnIndex.delete(state.logicalTurnId);
    }
    for (const streamId of state.revisionStreams.values()) {
      if (this.streamScopes.get(streamId) === state.scope) {
        this.streamScopes.delete(streamId);
      }
    }
  }

  private hasActiveSourceOrderScope(scope: string): boolean {
    for (const state of this.logicalTurns.values()) {
      if (
        state.active &&
        Array.from(state.revisionSourceOrders.values()).some(
          (sourceOrder) => sourceOrder.source_order_scope === scope,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Get job count (for monitoring) */
  async getJobCount(): Promise<number> {
    return this.jobs.size;
  }

  /** Get job count by status (for monitoring) */
  async getJobCountByStatus(status: JobStatus): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === status) {
        count++;
      }
    }
    return count;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.lifecycleEpoch += 1;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.jobs.clear();
    this.contentState.clear();
    this.userJobMap.clear();
    this.logicalTurns.clear();
    this.sourceOrderWatermarks.clear();
    this.nativePublications.clear();
    this.logicalTurnIndex.clear();
    this.streamScopes.clear();
    logger.debug('[InMemoryJobStore] Destroyed');
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   */
  async getActiveJobIdsByUser(userId: string): Promise<string[]> {
    const trackedIds = this.userJobMap.get(userId);
    if (!trackedIds || trackedIds.size === 0) {
      return [];
    }

    const activeIds: string[] = [];

    for (const streamId of trackedIds) {
      const job = this.jobs.get(streamId);
      // Only include if job exists AND is still running
      if (job && job.status === 'running') {
        activeIds.push(streamId);
      } else {
        // Self-healing: job completed/deleted but mapping wasn't cleaned - fix it now
        trackedIds.delete(streamId);
      }
    }

    // Clean up empty set
    if (trackedIds.size === 0) {
      this.userJobMap.delete(userId);
    }

    return activeIds;
  }

  // ===== Content State Methods =====

  /**
   * Set the graph reference for a job.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  setGraph(streamId: string, graph: StandardGraph): void {
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.graphRef = new WeakRef(graph);
    } else {
      this.contentState.set(streamId, {
        contentParts: [],
        graphRef: new WeakRef(graph),
        collectedUsage: [],
      });
    }
  }

  /**
   * Set content parts reference for a job.
   */
  setContentParts(streamId: string, contentParts: Agents.MessageContentComplex[]): void {
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.contentParts = contentParts;
    } else {
      this.contentState.set(streamId, { contentParts, graphRef: null, collectedUsage: [] });
    }
  }

  /**
   * Set collected usage reference for a job.
   */
  setCollectedUsage(streamId: string, collectedUsage: UsageMetadata[]): void {
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.collectedUsage = collectedUsage;
    } else {
      this.contentState.set(streamId, { contentParts: [], graphRef: null, collectedUsage });
    }
  }

  /**
   * Get collected usage for a job.
   */
  getCollectedUsage(streamId: string): UsageMetadata[] {
    const state = this.contentState.get(streamId);
    return state?.collectedUsage ?? [];
  }

  /**
   * Get content parts for a job.
   * Returns live content from stored reference.
   */
  async getContentParts(streamId: string): Promise<{
    content: Agents.MessageContentComplex[];
  } | null> {
    const state = this.contentState.get(streamId);
    if (!state?.contentParts) {
      return null;
    }
    return {
      content: state.contentParts,
    };
  }

  /**
   * Get run steps for a job from graph.contentData.
   * Uses WeakRef - may return empty if graph has been GC'd.
   */
  async getRunSteps(streamId: string): Promise<Agents.RunStep[]> {
    const state = this.contentState.get(streamId);
    if (!state?.graphRef) {
      return [];
    }

    // Dereference WeakRef - may return undefined if GC'd
    const graph = state.graphRef.deref();
    return graph?.contentData ?? [];
  }

  /**
   * No-op for in-memory - content available via graph reference.
   */
  async appendChunk(): Promise<void> {
    // No-op: content available via graph reference
  }

  /**
   * Clear content state for a job.
   */
  clearContentState(streamId: string): void {
    this.contentState.delete(streamId);
  }
}
