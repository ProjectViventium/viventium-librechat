/* === VIVENTIUM START === Real Native goal results use the existing independent Main speaker. === */
import type {
  MainGenerationMessage,
  MainGenerationDelivery,
  NativeCoordinatorPublicationSource,
} from './mainGenerationPresentation';
import {
  nativeCoordinatorResultCortexId,
  nativeCoordinatorResultSource,
} from './mainGenerationPresentation';
import { buildCortexInsightDeliveryCandidates } from '../cortex/insightDeliveryService';
import { nativeCoordinatorResultEvidence } from './nativeCoordinatorContext';
import { createHash } from 'node:crypto';

type Value = Record<string, unknown>;
const record = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Value) : {};

export interface NativeCoordinatorResultEvidenceDependencies {
  tenantId(): string;
  readBinding(id: string, session?: object): Promise<Value | null>;
  readSource(bindingRef: string, turnId: string, session?: object): Promise<Value | null>;
  readGoal(ownerId: string, conversationId: string, goalId: string): Promise<Value>;
  readResult(
    ownerId: string,
    conversationId: string,
    goalId: string,
    runId: string,
  ): Promise<Value>;
  readTurnResult?(
    ownerId: string,
    conversationId: string,
    turnId: string,
    requestId: string,
    runId: string,
  ): Promise<Value>;
  readCortexRows(ownerId: string, deliveryIds: string[], session?: object): Promise<Value[]>;
  readDestinations(ownerId: string, requestBody: Value): Promise<Value[]>;
}

/** No foreground task or generation job is authority for this independently accepted goal. */
export function createNativeCoordinatorResultSourceVerifier(
  deps: NativeCoordinatorResultEvidenceDependencies,
) {
  return async ({
    source,
    ownerId,
    conversationId,
    message,
    destination,
    session,
  }: {
    source: NativeCoordinatorPublicationSource;
    ownerId: string;
    conversationId: string;
    message: MainGenerationMessage;
    destination: MainGenerationDelivery;
    session?: object;
  }): Promise<boolean> => {
    if (!nativeCoordinatorResultSource(source)) return false;
    const [binding, accepted] = await Promise.all([
      deps.readBinding(source.bindingRef, session),
      deps.readSource(source.bindingRef, source.sourceTurnId, session),
    ]);
    if (
      !binding ||
      binding.kind !== 'native_coordinator_binding' ||
      binding.active !== true ||
      binding.ownerId !== ownerId ||
      binding.tenantId !== deps.tenantId() ||
      binding.conversationId !== conversationId ||
      binding.nativeConversationId !== source.nativeConversationId ||
      !accepted ||
      accepted.kind !== 'native_coordinator_source' ||
      accepted.bindingRef !== source.bindingRef ||
      accepted.turnId !== source.sourceTurnId
    )
      return false;
    const request = record(accepted.requestBody);
    const originalSurface =
      request.viventiumSurface === undefined ? 'web' : request.viventiumSurface;
    if (typeof originalSurface !== 'string') return false;
    const presentationSurface = originalSurface === 'voice' ? 'web' : originalSurface;
    const parentMessageId = request.messageId || request.parentMessageId;
    const callSessionId =
      request.viventiumCallSessionId || request.viventiumVoiceCallSessionId || '';
    if (!parentMessageId || callSessionId !== source.sourceCallSessionId) return false;
    if (destination.surface !== 'voice') {
      const destinations = await deps.readDestinations(ownerId, request);
      if (
        !destinations.some(
          (target) =>
            target.surface === destination.surface &&
            (target.surface === 'librechat' ||
              (target.surface === 'telegram' &&
                target.telegramChatId === destination.telegramChatId &&
                target.telegramUserId === destination.telegramUserId &&
                (target.telegramMessageThreadId || '') ===
                  (destination.telegramMessageThreadId || ''))),
        )
      )
        return false;
    }
    let result: Value;
    let state: unknown;
    if (source.kind === 'native_coordinator_turn') {
      if (!deps.readTurnResult) return false;
      result = await deps.readTurnResult(
        ownerId,
        source.nativeConversationId,
        source.turnId,
        source.requestId,
        source.runId,
      );
      if (
        result.turn_id !== source.turnId ||
        result.source_turn_id !== source.sourceTurnId ||
        result.request_id !== source.requestId ||
        result.run_id !== source.runId ||
        result.state !== 'completed' ||
        result.intent_state !== 'accepted' ||
        result.restore_hold !== false ||
        result.superseded !== false ||
        result.presentation_eligible !== true ||
        'goal_id' in result
      )
        return false;
      state = 'completed';
    } else {
      const goal = await deps.readGoal(ownerId, source.nativeConversationId, source.goalId);
      if (
        goal.goal_id !== source.goalId ||
        goal.source_turn_id !== source.sourceTurnId ||
        goal.run_id !== source.runId ||
        goal.result_revision !== source.resultRevision ||
        !['completed', 'failed'].includes(String(goal.state)) ||
        goal.intent_state !== 'accepted' ||
        goal.restore_hold !== false
      )
        return false;
      result = await deps.readResult(
        ownerId,
        source.nativeConversationId,
        source.goalId,
        source.runId,
      );
      if (result.goal_id !== source.goalId) return false;
      state = goal.state;
    }
    const publisher = record(result.publisher);
    if (
      result.run_id !== source.runId ||
      result.state !== state ||
      result.result_revision !== source.resultRevision ||
      `sha256:${result.sha256}` !== source.resultDigest ||
      publisher.owner_id !== ownerId ||
      publisher.conversation_id !== source.nativeConversationId ||
      publisher.agent_id !== 'coordinator' ||
      publisher.run_id !== source.runId ||
      ![publisher.request_id, publisher.message_id, publisher.stream_id].every(
        (value) => typeof value === 'string' && value.length > 0,
      )
    )
      return false;
    if (
      source.kind === 'native_coordinator_turn' &&
      (publisher.request_id !== source.requestId ||
        publisher.message_id !== source.turnId ||
        publisher.stream_id !== source.turnId)
    )
      return false;
    const insightHash =
      result.total_chars === 0
        ? createHash('sha256')
            .update(
              nativeCoordinatorResultEvidence({
                text: '',
                state: String(result.state || ''),
                failureClass: String(result.failure_class || ''),
                runId: source.runId,
                resultRevision: source.resultRevision,
                resultDigest: source.resultDigest,
              }),
            )
            .digest('hex')
        : source.resultDigest.slice(7);
    const metadata = record(record(message.metadata).viventium);
    const ids = metadata.cortexInsightDeliveryIds;
    const generation = metadata.cortexPresentationGeneration;
    const token = metadata.cortexPresentationClaimToken;
    if (
      !Array.isArray(ids) ||
      ids.length !== 1 ||
      typeof ids[0] !== 'string' ||
      metadata.cortexPresentationParentMessageId !== parentMessageId ||
      !Number.isSafeInteger(generation) ||
      Number(generation) < 1 ||
      typeof token !== 'string' ||
      !token
    )
      return false;
    const rows = await deps.readCortexRows(ownerId, ids, session);
    if (rows.length !== 1) return false;
    const row = rows[0];
    const events = Array.isArray(row.events) ? row.events.map(record) : [];
    const persisted = events.some(
      (event) =>
        event.transition === 'persisted' &&
        event.claimToken === token &&
        event.claimGeneration === generation,
    );
    const expected = buildCortexInsightDeliveryCandidates({
      ownerId,
      conversationId,
      parentMessageId: String(parentMessageId),
      surface: presentationSurface,
      insights: [
        {
          cortexId: nativeCoordinatorResultCortexId(source),
          status: 'completed',
          insight: String(row.insight || ''),
        },
      ],
    })[0];
    return (
      expected?.surface === presentationSurface &&
      expected.surface !== 'unknown' &&
      persisted &&
      row.deliveryId === ids[0] &&
      row.deliveryId === expected.deliveryId &&
      row.userId === ownerId &&
      row.conversationId === conversationId &&
      row.parentMessageId === parentMessageId &&
      row.persistedMessageId === message.messageId &&
      row.persistenceStatus === 'persisted' &&
      row.status !== 'dropped' &&
      row.claimGeneration === generation &&
      row.surface === expected.surface &&
      row.insightHash === insightHash &&
      row.graphResultHash === insightHash
    );
  };
}
/* === VIVENTIUM END === */
