import { interactionPresentationSequence } from '../../agents/interactionContext';
import type { NativeResponseIdentity, NativeResponseCommit } from '@librechat/data-schemas';
import {
  nativeIdentityJson,
  nativeIdentityValid,
  nativeJobMatches,
  retainNativeResponse,
  NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
} from './nativeResponse';
import { logger } from '@librechat/data-schemas';
import { retainLogicalTurnInput, mergeLogicalTurnInput } from './logicalTurnInput';
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
  CortexPresentationBinding,
  SourceOrderObservation,
  SourceOrderObservationResult,
} from '~/stream/interfaces/IJobStore';

interface LogicalTurnState {
  scope: string;
  logicalTurnId: string;
  revision: number;
  active: boolean;
  currentStreamId?: string;
  receipts: Map<string, { streamId: string; interactionContext: InteractionContext }>;
  revisionStreams: Map<number, string>;
  deliveryAcknowledgements: Map<number, InteractionDeliveryAck>;
  completedAt?: number;
  pendingInputs?: InteractionContext[];
  currentContext?: InteractionContext;
}

function logicalTurnScope(userId: string, interactionContext: InteractionContext): string {
  if (interactionContext.source_order_scope) return interactionContext.source_order_scope;
  return [
    userId,
    interactionContext.conversation_id,
    interactionContext.actor_kind,
    interactionContext.origin,
  ].join('\u0000');
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
  /* VIVENTIUM START: process-local mirrors of the logical/source publication owner. */
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

  private sourceOrders = new Map<string, SourceOrderObservationResult & { expiresAt: number }>();
  /* VIVENTIUM END */
  private jobs = new Map<string, SerializableJobData>();
  private contentState = new Map<string, ContentState>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Maps userId -> Set of streamIds (conversationIds) for active jobs */
  private userJobMap = new Map<string, Set<string>>();

  /** One synchronous claim state per user/conversation scope. */
  private logicalTurns = new Map<string, LogicalTurnState>();
  /** Reverse owner index; callers never supply user or conversation authority. */
  private logicalTurnIndex = new Map<string, LogicalTurnState>();
  private streamScopes = new Map<string, string>();

  /** Time to keep completed jobs before cleanup (0 = immediate) */
  private ttlAfterComplete = 0;

  /** Maximum number of concurrent jobs */
  private maxJobs = 1000;

  constructor(options?: { ttlAfterComplete?: number; maxJobs?: number }) {
    if (options?.ttlAfterComplete) {
      this.ttlAfterComplete = options.ttlAfterComplete;
    }
    if (options?.maxJobs) {
      this.maxJobs = options.maxJobs;
    }
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[InMemoryJobStore] Initialized with cleanup interval');
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    initialData?: Partial<SerializableJobData>,
  ): Promise<SerializableJobData> {
    const previous = this.jobs.get(streamId);
    if (previous) {
      const result = await this.cancelNativeResponse(previous);
      if (result.status === 'committed' && !previous.nativeResponseSettled) {
        throw new Error('Saved native result is pending');
      }
      if (this.jobs.get(streamId) !== previous) {
        throw new Error('Stream incarnation changed');
      }
    }
    if (this.jobs.size >= this.maxJobs) {
      await this.evictOldest();
      if (this.jobs.size >= this.maxJobs && !previous) {
        throw new Error('Generation job capacity reached');
      }
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

    // Existing replay closures must observe retirement before the replacement is published.
    if (previous) {
      previous.nativeResponseCancelled = true;
      delete previous.finalEvent;
    }
    this.jobs.set(streamId, job);

    // Track job by userId for efficient user-scoped queries
    let userJobs = this.userJobMap.get(userId);
    if (!userJobs) {
      userJobs = new Set();
      this.userJobMap.set(userId, userJobs);
    }
    userJobs.add(streamId);

    logger.debug(`[InMemoryJobStore] Created job: ${streamId}`);

    return job;
  }

  /* VIVENTIUM START: one publication winner, before any transport replay. */
  async observeSourceOrder(
    observation: SourceOrderObservation,
  ): Promise<SourceOrderObservationResult> {
    const previous = this.sourceOrders.get(observation.source_order_scope);
    const latest = Math.max(previous?.latest_source_sequence ?? 0, observation.source_sequence);
    const result = {
      latest_source_sequence: latest,
      observed_at: latest === previous?.latest_source_sequence ? previous.observed_at : Date.now(),
      stale: observation.source_sequence < latest,
    };
    this.sourceOrders.set(observation.source_order_scope, {
      ...result,
      expiresAt: Math.max(previous?.expiresAt ?? 0, Date.now() + 300_000),
    });
    return result;
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
        this.sourceOrders.get(identity.sourceOrderScope)?.latest_source_sequence ===
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
    if (!prior && job.status !== 'running') {
      return false;
    }
    if (!prior) {
      this.nativePublications.set(this.nativeKey(identity), {
        identity: encoded,
        state: 'bound',
        recoverUntil: identity.recoverUntil,
      });
    }
    job.nativeResponse = JSON.parse(encoded) as NativeResponseIdentity;
    const source = identity.sourceOrderScope && this.sourceOrders.get(identity.sourceOrderScope);
    if (source) {
      source.expiresAt = Math.max(source.expiresAt, identity.recoverUntil);
    }
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
    if (!nativeIdentityValid(identity)) {
      return { status: 'unavailable' };
    }
    const record = this.nativePublications.get(this.nativeKey(identity));
    if (!record || record.identity !== nativeIdentityJson(identity)) {
      return { status: 'unavailable' };
    }
    return record.state === 'committed'
      ? { status: 'committed', candidateSha256: record.candidateSha256 }
      : { status: record.state === 'revoked' ? 'revoked' : 'unavailable' };
  }

  async revokeNativeResponse(identity: NativeResponseIdentity): Promise<NativeResponseCommit> {
    if (!nativeIdentityValid(identity)) {
      return { status: 'unavailable' };
    }
    const record = this.nativePublications.get(this.nativeKey(identity));
    if (!record || record.identity !== nativeIdentityJson(identity)) {
      return { status: 'unavailable' };
    }
    if (record.state === 'committed') {
      return { status: 'committed', candidateSha256: record.candidateSha256 };
    }
    record.state = 'revoked';
    const job = this.jobs.get(identity.streamId) ?? null;
    if (nativeJobMatches(job, identity)) {
      job.nativeResponseCancelled = true;
    }
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
    if (job.nativeResponse) {
      return this.revokeNativeResponse(job.nativeResponse);
    }
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
      )
        return false;
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
    if (job.nativeResponseFinished) {
      return job.finalEvent === finalEvent;
    }
    job.finalEvent = finalEvent;
    job.nativeResponseFinished = true;
    job.generationCompleted = true;
    job.status = mode === 'cancelled' ? 'aborted' : 'complete';
    job.completedAt = Date.now();
    delete job.error;
    return true;
  }
  /* VIVENTIUM END */

  async retainLogicalTurnInput(userId: string, context: InteractionContext): Promise<InteractionContext> {
    const scope = logicalTurnScope(userId, context);
    let state = this.logicalTurns.get(scope);
    mergeLogicalTurnInput([...(state?.active && state.currentContext ? [state.currentContext] : []), ...(state?.pendingInputs ?? [])], context);
    if (!state) {
      state = { scope, logicalTurnId: randomUUID(), revision: 0, active: false,
        receipts: new Map(), revisionStreams: new Map(), deliveryAcknowledgements: new Map() };
      this.logicalTurns.set(scope, state);
    }
    if (state.receipts.has(context.source_event_id) || state.currentContext?.source_segments?.some((source) => source.source_event_id === context.source_event_id)) return context;
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
    const existing = this.logicalTurns.get(scope);
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
    const presentationSequence = interactionPresentationSequence(interactionContext);
    const latestSequence = interactionContext.source_order_scope
      ? Math.max(this.sourceOrders.get(interactionContext.source_order_scope)?.latest_source_sequence ?? 0,
          interactionPresentationSequence(existing?.currentContext) ?? 0,
          ...(existing?.pendingInputs ?? []).flatMap((input) => (input.source_segments ?? []).map((segment) => segment.source_sequence ?? 0))) : undefined;
    if (presentationSequence != null && latestSequence != null && presentationSequence < latestSequence) {
      return { status: 'superseded', streamId, interactionContext, supersededStreamIds: [] };
    }
    const pendingInputs = existing?.pendingInputs ?? [];
    const previousContext = existing?.active ? existing.currentContext : undefined;
    const mergedInput = mergeLogicalTurnInput([...(previousContext ? [previousContext] : []), ...pendingInputs], interactionContext);
    if (mergedInput.source_segments?.some((segment) => segment.source_message_id && segment.source_persisted !== true)) {
      return { status: 'initializing', streamId, interactionContext, supersededStreamIds: [] };
    }
    const activeStreamId = existing?.active ? existing.currentStreamId : undefined;
    const continuesTurn = activeStreamId != null;
    if (!continuesTurn && existing) {
      this.retireLogicalTurnState(existing);
    }
    const state: LogicalTurnState = continuesTurn
      ? existing!
      : {
          scope,
          logicalTurnId: randomUUID(),
          revision: 0,
          active: false,
          receipts: new Map(),
          revisionStreams: new Map(),
          deliveryAcknowledgements: new Map(),
        };
    state.completedAt = undefined;
    state.revision += 1;

    const claimedContext: InteractionContext = Object.freeze({
      ...mergedInput,
      logical_turn_id: state.logicalTurnId,
      revision: state.revision,
    });
    const supersededStreamIds = continuesTurn && activeStreamId ? [activeStreamId] : [];
    state.currentContext = claimedContext;
    state.pendingInputs = [];
    state.currentStreamId = streamId;
    state.active = true;
    state.revisionStreams.set(state.revision, streamId);
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

  async rollbackLogicalTurnClaim(
    streamId: string,
    interactionContext: InteractionContext,
  ): Promise<boolean> {
    const scope = this.streamScopes.get(streamId);
    const state = scope ? this.logicalTurns.get(scope) : undefined;
    if (
      !scope ||
      !state ||
      state.logicalTurnId !== interactionContext.logical_turn_id ||
      state.revision !== interactionContext.revision ||
      state.currentStreamId !== streamId
    ) {
      return false;
    }
    const receipt = state.receipts.get(interactionContext.source_event_id);
    if (receipt?.streamId === streamId) {
      state.receipts.delete(interactionContext.source_event_id);
    }
    state.pendingInputs = retainLogicalTurnInput(state.pendingInputs ?? [], interactionContext);
    state.revisionStreams.delete(state.revision);
    this.streamScopes.delete(streamId);
    state.revision -= 1;
    if (state.revision > 0) {
      state.currentStreamId = state.revisionStreams.get(state.revision);
      state.currentContext = [...state.receipts.values()].find((receipt) => receipt.streamId === state.currentStreamId)?.interactionContext;
      state.active = Boolean(state.currentStreamId);
    } else {
      state.currentStreamId = undefined;
      state.active = false;
      state.completedAt = Date.now();
      this.logicalTurnIndex.delete(state.logicalTurnId);
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
    if (
      !state ||
      this.logicalTurns.get(state.scope) !== state ||
      receipt?.streamId !== expectedStreamId
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
      )
        return;
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
    const scope = this.streamScopes.get(streamId);
    if (!scope) {
      return true;
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

  private stalePresentation(state: LogicalTurnState, revision: number): boolean {
    const context = [...state.receipts.values()].find((receipt) => receipt.interactionContext.revision === revision)?.interactionContext;
    const sequence = interactionPresentationSequence(context);
    const latest = context?.source_order_scope ? this.sourceOrders.get(context.source_order_scope)?.latest_source_sequence : undefined;
    return sequence != null && latest != null && sequence < latest;
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
    if (acknowledgement.revision < state.revision && acknowledgement.state === 'committed') {
      return { status: 'stale_revision' };
    }
    const existingAcknowledgement = state.deliveryAcknowledgements.get(acknowledgement.revision);
    if (existingAcknowledgement) {
      const idempotent =
        existingAcknowledgement.state === acknowledgement.state &&
        existingAcknowledgement.presentation_ref === acknowledgement.presentation_ref;
      return idempotent
        ? {
            status: 'recorded',
            acknowledgement: existingAcknowledgement,
            idempotent: true,
            ownerStreamId,
          }
        : { status: 'conflict' };
    }
    if (['committed', 'committed_effect'].includes(acknowledgement.state) && this.stalePresentation(state, acknowledgement.revision)) {
      return { status: 'stale_source_order' };
    }
    const recordedAcknowledgement = Object.freeze({ ...acknowledgement });
    state.deliveryAcknowledgements.set(acknowledgement.revision, recordedAcknowledgement);
    if (
      acknowledgement.revision === state.revision &&
      (acknowledgement.state === 'committed' || acknowledgement.state === 'failed')
    ) {
      state.active = false;
      state.completedAt = Date.now();
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
        (!nativeJobMatches(job, expectedNativeIdentity) || !job.nativeResponse ||
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

  /** Atomically bind one exact Cortex presentation generation to its in-memory job. */
  async bindCortexPresentation(
    streamId: string,
    binding: CortexPresentationBinding,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job) {
      return false;
    }
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

  /** Compare-and-bind an acknowledgement to the exact current Cortex presentation. */
  async bindDeliveryAcknowledgement(
    streamId: string,
    acknowledgement: InteractionDeliveryAck,
    expectedCortexPresentation: CortexPresentationBinding | null,
  ): Promise<DeliveryAcknowledgementBindingResult> {
    const state = this.logicalTurnIndex.get(acknowledgement.logical_turn_id);
    if (!state || this.logicalTurns.get(state.scope) !== state) {
      return { status: 'not_found' };
    }
    const ownerStreamId = state.revisionStreams.get(acknowledgement.revision);
    if (!ownerStreamId || acknowledgement.revision > state.revision) {
      return { status: 'stale_revision' };
    }
    if (ownerStreamId !== streamId) {
      return { status: 'conflict' };
    }
    if (acknowledgement.revision < state.revision && acknowledgement.state === 'committed') {
      return { status: 'stale_revision' };
    }
    const job = this.jobs.get(streamId);
    if (!job) {
      return { status: 'not_found' };
    }

    const samePresentation = (
      left: CortexPresentationBinding | undefined,
      right: CortexPresentationBinding | undefined,
    ) =>
      Boolean(
        left &&
        right &&
        left.ownerId === right.ownerId &&
        left.messageId === right.messageId &&
        left.parentMessageId === right.parentMessageId &&
        left.revision === right.revision &&
        left.generation === right.generation &&
        left.boundAt === right.boundAt &&
        left.claimToken === right.claimToken &&
        left.presentationLeaseToken === right.presentationLeaseToken &&
        left.deliveryIds.length === right.deliveryIds.length &&
        left.deliveryIds.every((deliveryId, index) => deliveryId === right.deliveryIds[index]) &&
        left.deliveryReceipts.length === right.deliveryReceipts.length &&
        left.deliveryReceipts.every(
          (receipt, index) =>
            receipt.deliveryId === right.deliveryReceipts[index].deliveryId &&
            receipt.graphResultHash === right.deliveryReceipts[index].graphResultHash,
        ),
      );
    const current = job.cortexPresentation;
    if (expectedCortexPresentation && !samePresentation(current, expectedCortexPresentation)) {
      return { status: 'retryable_conflict' };
    }

    const acknowledgementInput = { ...acknowledgement };
    delete acknowledgementInput.presentation_committed_at;
    const existingLogicalAcknowledgement = state.deliveryAcknowledgements.get(
      acknowledgement.revision,
    );
    if (!existingLogicalAcknowledgement && ['committed', 'committed_effect'].includes(acknowledgement.state) &&
        this.stalePresentation(state, acknowledgement.revision)) return { status: 'stale_source_order' };
    let recordedAcknowledgement = existingLogicalAcknowledgement;
    let logicalIdempotent = false;
    if (existingLogicalAcknowledgement) {
      const existingInput = { ...existingLogicalAcknowledgement };
      delete existingInput.presentation_committed_at;
      if (JSON.stringify(existingInput) !== JSON.stringify(acknowledgementInput)) {
        return { status: 'conflict' };
      }
      logicalIdempotent = true;
    }

    let cortexIdempotent = !expectedCortexPresentation;
    if (expectedCortexPresentation) {
      const existing = job.cortexDeliveryAcknowledgement;
      const existingPresentation = job.cortexDeliveryAcknowledgementPresentation;
      if ((existing && !existingPresentation) || (!existing && existingPresentation)) {
        return { status: 'retryable_conflict' };
      }
      if (existing && existingPresentation) {
        const existingInput = { ...existing };
        delete existingInput.presentation_committed_at;
        if (JSON.stringify(existingInput) !== JSON.stringify(acknowledgementInput)) {
          return { status: 'conflict' };
        }
        cortexIdempotent = true;
      }
    }

    if (!recordedAcknowledgement) {
      recordedAcknowledgement = Object.freeze({
        ...acknowledgementInput,
        ...(expectedCortexPresentation &&
        ['committed', 'committed_effect'].includes(acknowledgementInput.state)
          ? { presentation_committed_at: Date.now() }
          : {}),
      });
      state.deliveryAcknowledgements.set(acknowledgement.revision, recordedAcknowledgement);
    }
    if (
      acknowledgement.revision === state.revision &&
      (acknowledgement.state === 'committed' || acknowledgement.state === 'failed')
    ) {
      state.active = false;
      state.completedAt = Date.now();
    }
    job.deliveryAcknowledgement = recordedAcknowledgement;
    if (expectedCortexPresentation) {
      job.cortexDeliveryAcknowledgement = recordedAcknowledgement;
      job.cortexDeliveryAcknowledgementPresentation = current;
    }
    return {
      status: 'recorded',
      acknowledgement: recordedAcknowledgement,
      idempotent: logicalIdempotent && cortexIdempotent,
      ownerStreamId,
      ...(expectedCortexPresentation && current ? { cortexPresentation: current } : {}),
    };
  }

  async deleteJob(streamId: string, retiredNativeResponse?: NativeResponseIdentity): Promise<void> {
    const job = this.jobs.get(streamId);
    if (retiredNativeResponse && job) {
      if (
        !job.nativeResponse ||
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(retiredNativeResponse)
      )
        return;
      // Existing in-flight replay references observe retirement before this job is removed.
      job.nativeResponseCancelled = true;
      delete job.finalEvent;
    } else if (job && retainNativeResponse(job)) {
      return;
    }
    this.jobs.delete(streamId);
    this.contentState.delete(streamId);
    logger.debug(`[InMemoryJobStore] Deleted job: ${streamId}`);
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

    for (const [scope, source] of this.sourceOrders) {
      if (source.expiresAt <= now) {
        this.sourceOrders.delete(scope);
      }
    }
    for (const [key, publication] of this.nativePublications) {
      if (publication.recoverUntil <= now) {
        this.nativePublications.delete(key);
      }
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

    if (toDelete.length > 0) {
      logger.debug(`[InMemoryJobStore] Cleaned up ${toDelete.length} expired jobs`);
    }

    return toDelete.length;
  }

  private async evictOldest(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [streamId, job] of this.jobs) {
      if (!retainNativeResponse(job) && job.createdAt < oldestTime) {
        oldestTime = job.createdAt;
        oldestId = streamId;
      }
    }

    if (oldestId) {
      logger.warn(`[InMemoryJobStore] Evicting oldest job: ${oldestId}`);
      await this.deleteJob(oldestId);
    }
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.nativePublications.clear();
    this.sourceOrders.clear();
    this.jobs.clear();
    this.contentState.clear();
    this.userJobMap.clear();
    this.logicalTurns.clear();
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
