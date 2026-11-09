/* === VIVENTIUM START === Read existing Native/Main receipts into the existing roster. === */
import { createNativeCoordinatorResultSourceVerifier } from './nativeCoordinatorVoicePresentation';
import {
  buildMainGenerationPresentation,
  mainGenerationPresentation,
} from './mainGenerationPresentation';
import { nativeCoordinatorWorkRef, nativeCoordinatorTurnRef } from './nativeCoordinatorWork';
import { normalizeWorkDeliveryScope } from './workDeliveryScope';
import { requiredSurfacesFor } from '../cortex/insightDeliveryService';
import type {
  NativeCoordinatorOwnedSnapshot,
  NativeCoordinatorGoal,
  NativeCoordinatorTurn,
  NativeCoordinatorWorkBinding,
} from './nativeCoordinatorWork';
import type { NativeCoordinatorResultEvidenceDependencies } from './nativeCoordinatorVoicePresentation';
import type {
  MainGenerationMessage,
  MainGenerationPresentation,
  MainGenerationDelivery,
} from './mainGenerationPresentation';

type Value = Record<string, unknown>;
const record = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Value) : {};
export type NativeResultDeliveryTarget = { binding: NativeCoordinatorWorkBinding } & (
  { goal: NativeCoordinatorGoal } | { turn: NativeCoordinatorTurn }
);
interface PublishedMain extends MainGenerationMessage {
  error?: boolean;
  unfinished?: boolean;
  deletedAt?: Date | string | null;
}
interface Dependencies {
  readMessages(ownerId: string, targets: NativeResultDeliveryTarget[]): Promise<PublishedMain[]>;
  readSources(ownerId: string, targets: NativeResultDeliveryTarget[]): Promise<Value[]>;
  readRows(ownerId: string, deliveryIds: string[]): Promise<Value[]>;
  readResult: NativeCoordinatorResultEvidenceDependencies['readResult'];
  readTurnResult?: NativeCoordinatorResultEvidenceDependencies['readTurnResult'];
  readDestinations: NativeCoordinatorResultEvidenceDependencies['readDestinations'];
}

export function createNativeCoordinatorResultDeliveryProjection(deps: Dependencies) {
  return async (input: {
    ownerId: string;
    tenantId: string;
    snapshots: NativeCoordinatorOwnedSnapshot[];
    roster: Value;
  }) => {
    if (!Array.isArray(input.roster.work)) return input.roster;
    const targets = input.snapshots.flatMap(({ binding, snapshot }) => {
      if (
        !binding._id ||
        binding.kind !== 'native_coordinator_binding' ||
        !binding.active ||
        binding.ownerId !== input.ownerId ||
        binding.tenantId !== input.tenantId ||
        binding.nativeConversationId !== snapshot.conversation_id
      )
        return [];
      const goals = snapshot.goals
        .filter(
          (goal) =>
            !goal.work_ref &&
            goal.run_id &&
            goal.source_turn_id &&
            ['completed', 'failed'].includes(goal.state) &&
            goal.intent_state === 'accepted' &&
            goal.restore_hold === false &&
            (!goal.control_run_id || goal.control_run_id === goal.run_id) &&
            Number.isSafeInteger(goal.result_revision) &&
            Number(goal.result_revision) > 0,
        )
        .map((goal): NativeResultDeliveryTarget => ({ binding, goal }));
      const turns = (snapshot.turns || [])
        .filter(
          (turn) =>
            turn.has_result === true &&
            turn.presentation_eligible === true &&
            turn.state === 'completed' &&
            turn.run_id &&
            turn.request_id &&
            turn.source_turn_id &&
            turn.intent_state === 'accepted' &&
            turn.restore_hold === false &&
            turn.superseded === false &&
            !turn.retry_turn_id &&
            Number.isSafeInteger(turn.result_revision) &&
            Number(turn.result_revision) > 0,
        )
        .map((turn): NativeResultDeliveryTarget => ({ binding, turn }));
      return [...goals, ...turns];
    });
    if (!targets.length) return input.roster;
    const messages = await deps.readMessages(input.ownerId, targets);
    const publications = messages.flatMap((message) => {
      const authority = record(record(message.metadata).viventium).mainGenerationPresentation;
      const main = mainGenerationPresentation({
        event: 'main.followup',
        surface: '',
        callbackMessageId: message.messageId,
        mainGenerationPresentation: authority as MainGenerationPresentation | null,
      });
      if (
        !main ||
        main.version !== 2 ||
        message.user !== input.ownerId ||
        message.isCreatedByUser !== false ||
        typeof message.text !== 'string' ||
        !message.text.trim() ||
        message.error ||
        message.unfinished ||
        message.deletedAt
      )
        return [];
      const source = main.nativeCoordinatorResult;
      const target = targets.find((target) => {
        const { binding } = target;
        const subject = 'turn' in target ? target.turn : target.goal;
        const identity =
          'turn' in target
            ? source.kind === 'native_coordinator_turn' &&
              source.turnId === target.turn.turn_id &&
              source.requestId === target.turn.request_id
            : source.kind === 'native_coordinator_goal' && source.goalId === target.goal.goal_id;
        return (
          identity &&
          source.bindingRef === binding._id &&
          source.nativeConversationId === binding.nativeConversationId &&
          source.runId === subject.run_id &&
          source.resultRevision === subject.result_revision &&
          source.sourceTurnId === subject.source_turn_id &&
          message.conversationId === binding.conversationId
        );
      });
      if (!target) return [];
      const canonical = buildMainGenerationPresentation(
        { nativeCoordinatorResult: source },
        message.messageId,
        message.text,
      );
      if (canonical?.responseDigest !== main.responseDigest) return [];
      const ids = record(record(message.metadata).viventium).cortexInsightDeliveryIds;
      if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string') return [];
      return [{ message, source, target, deliveryId: ids[0] }];
    });
    if (!publications.length) return input.roster;
    const [sources, rows] = await Promise.all([
      deps.readSources(
        input.ownerId,
        publications.map((publication) => publication.target),
      ),
      deps.readRows(
        input.ownerId,
        publications.map((publication) => publication.deliveryId),
      ),
    ]);
    const settled = await Promise.allSettled(
      publications.map(async (publication) => {
        const { source, target, message } = publication;
        const row = rows.find(
          (row) => row.deliveryId === publication.deliveryId && row.userId === input.ownerId,
        );
        if (!row || row.status === 'dropped') return null;
        const required = requiredSurfacesFor(row.surface);
        if (
          !Array.isArray(row.requiredSurfaces) ||
          row.requiredSurfaces.length !== required.length ||
          !required.every((surface) => (row.requiredSurfaces as unknown[]).includes(surface)) ||
          !Array.isArray(row.presentedSurfaces) ||
          !Array.isArray(row.presentationReceiptHashes)
        )
          return null;
        const presented = row.presentedSurfaces;
        const receipts = row.presentationReceiptHashes;
        const accepted = sources.find(
          (value) => value.bindingRef === source.bindingRef && value.turnId === source.sourceTurnId,
        );
        if (!accepted) return null;
        const destinations = await deps.readDestinations(
          input.ownerId,
          record(accepted.requestBody),
        );
        const surface = row.surface === 'web' ? 'librechat' : row.surface;
        const selected = destinations.find((value) => value.surface === surface);
        if (!selected || typeof selected.surface !== 'string') return null;
        const destination: MainGenerationDelivery = {
          surface: selected.surface,
          telegramChatId:
            typeof selected.telegramChatId === 'string' ? selected.telegramChatId : undefined,
          telegramUserId:
            typeof selected.telegramUserId === 'string' ? selected.telegramUserId : undefined,
          telegramMessageThreadId:
            typeof selected.telegramMessageThreadId === 'string'
              ? selected.telegramMessageThreadId
              : undefined,
          voiceCallSessionId:
            typeof selected.voiceCallSessionId === 'string'
              ? selected.voiceCallSessionId
              : undefined,
        };
        const verify = createNativeCoordinatorResultSourceVerifier({
          tenantId: () => input.tenantId,
          readBinding: async (id) => (id === target.binding._id ? { ...target.binding } : null),
          readSource: async (ref, turn) =>
            sources.find((value) => value.bindingRef === ref && value.turnId === turn) || null,
          readGoal: async () => ('goal' in target ? { ...target.goal } : {}),
          readResult: deps.readResult,
          readTurnResult: deps.readTurnResult,
          readCortexRows: async (owner, ids) =>
            rows.filter(
              (value) => value.userId === owner && ids.includes(String(value.deliveryId)),
            ),
          readDestinations: async () => destinations,
        });
        if (
          !(await verify({
            source,
            ownerId: input.ownerId,
            conversationId: target.binding.conversationId,
            message,
            destination,
          }))
        )
          return null;
        const delivered =
          row.status === 'sent' &&
          required.length > 0 &&
          required.every((surface) => presented.includes(surface)) &&
          receipts.length > 0;
        if (row.status === 'sent' && !delivered) return null;
        const state = delivered ? 'delivered' : row.status === 'failed' ? 'failed' : 'pending';
        return {
          workRef:
            source.kind === 'native_coordinator_turn'
              ? nativeCoordinatorTurnRef(source.nativeConversationId, source.turnId)
              : nativeCoordinatorWorkRef(source.nativeConversationId, source.goalId),
          delivery: { state, unreadTerminal: !delivered },
          deliveryScope: normalizeWorkDeliveryScope({
            originConversationId: target.binding.conversationId,
            destinations: required.map((surface) => (surface === 'web' ? 'librechat' : surface)),
            resultRunId: source.runId,
            resultRevision: source.resultRevision,
          }),
        };
      }),
    );
    const projected = settled.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
    const byRef = new Map(projected.map((value) => [value.workRef, value]));
    return {
      ...input.roster,
      work: input.roster.work.map((value) => {
        const item = record(value);
        const result = byRef.get(String(item.workRef));
        if (
          !result ||
          !['native_coordinator', 'native_coordinator_turn'].includes(
            String(item.managementKind),
          ) ||
          item.nativeWorkRef
        )
          return value;
        const deliveredTurn =
          item.managementKind === 'native_coordinator_turn' &&
          result.delivery.state === 'delivered';
        const { attention: _attention, ...withoutAttention } = item;
        return {
          ...(deliveredTurn ? withoutAttention : item),
          ...(deliveredTurn ? { state: 'completed' } : {}),
          delivery: result.delivery,
          ...(result.deliveryScope ? { deliveryScope: result.deliveryScope } : {}),
        };
      }),
    };
  };
}
/* === VIVENTIUM END === */
