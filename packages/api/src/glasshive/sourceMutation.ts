import type {
  IInteractionDurableEffect,
  InteractionDurableEffectJsonValue,
} from '@librechat/data-schemas';
import type { GlassHiveSourceAuthorBody } from './sourceAuthor';

import { assertCurrentGlassHiveSourceAuthor } from './sourceAuthor';

/* === VIVENTIUM START === Mongo reservation precedes the final Main-author dispatch fence. === */
export const SOURCE_MUTATION_ADAPTERS = [
  'glasshive.worker_delegate.v1',
  'glasshive.work_action.v1',
  'mcp.provider_mutation.v1',
] as const;
export const SOURCE_MUTATION_EFFECT_KINDS = [
  'durable_work_accepted',
  'durable_work_action_accepted',
  'provider_mutation_returned',
] as const;

export type SourceMutationPrepareInput = Pick<
  IInteractionDurableEffect,
  | 'adapterId'
  | 'routeId'
  | 'operation'
  | 'effectKind'
  | 'effectOrdinal'
  | 'effectOccurrenceRef'
  | 'providerIdempotencyKey'
  | 'providerIdempotencyMode'
> & { streamId: string; userId: string; canonicalArgs: object; sourceEventId?: string };

interface SourceMutationClaim {
  decision: 'dispatch' | 'reconcile' | 'in_progress' | 'return_committed';
  effectKey: string;
  claimToken?: string;
  replayResult?: InteractionDurableEffectJsonValue;
}

export interface SourceMutationService {
  prepareDurableEffect(input: SourceMutationPrepareInput): Promise<SourceMutationClaim>;
  commitDurableEffect(input: {
    effectKey: string;
    claimToken: string;
    providerReceiptRef: string;
    replayResult: InteractionDurableEffectJsonValue;
  }): Promise<IInteractionDurableEffect>;
  settleDurableEffectFailure(input: {
    effectKey: string;
    claimToken: string;
    outcome: 'failed_without_effect' | 'provider_outcome_unknown';
    failureCode: string;
  }): Promise<IInteractionDurableEffect>;
}

function mutationError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(code), { code, retryable: false as const });
}

export interface SourceMutationResult {
  result: InteractionDurableEffectJsonValue;
  /** A real provider or Core operation receipt; absence leaves the dispatch outcome unknown. */
  receiptRef?: string;
  /** Only a typed provider rejection or a local pre-dispatch boundary can certify this. */
  noEffect?: boolean;
}

export async function executeSourceMutation({
  input,
  service,
  assertAuthor,
  dispatch,
  recordReceipt,
}: {
  input: SourceMutationPrepareInput;
  service: SourceMutationService;
  assertAuthor(): Promise<void>;
  dispatch(): Promise<SourceMutationResult>;
  recordReceipt?(row: IInteractionDurableEffect): Promise<void>;
}): Promise<InteractionDurableEffectJsonValue> {
  const claim = await service.prepareDurableEffect(input);
  if (claim.decision === 'return_committed') {
    if (claim.replayResult === undefined) throw mutationError('source_mutation_result_unavailable');
    return claim.replayResult;
  }
  if (claim.decision !== 'dispatch' || !claim.claimToken) {
    throw mutationError('source_mutation_outcome_pending');
  }
  const settlement = (
    outcome: 'failed_without_effect' | 'provider_outcome_unknown',
    code: string,
  ) =>
    service.settleDurableEffectFailure({
      effectKey: claim.effectKey,
      claimToken: claim.claimToken!,
      outcome,
      failureCode: code,
    });
  try {
    await assertAuthor();
  } catch (error) {
    await settlement('failed_without_effect', 'source_authority_rejected_before_dispatch');
    throw error;
  }
  let outcome: SourceMutationResult;
  try {
    outcome = await dispatch();
  } catch (error) {
    await settlement('provider_outcome_unknown', 'source_mutation_dispatch_unconfirmed');
    throw error;
  }
  if (!outcome.receiptRef) {
    await settlement(
      outcome.noEffect === true ? 'failed_without_effect' : 'provider_outcome_unknown',
      outcome.noEffect === true
        ? 'source_mutation_rejected'
        : 'source_mutation_receipt_unconfirmed',
    );
    return outcome.result;
  }
  const committed = await service.commitDurableEffect({
    effectKey: claim.effectKey,
    claimToken: claim.claimToken,
    providerReceiptRef: outcome.receiptRef,
    replayResult: outcome.result,
  });
  // Mongo owns the accepted outcome. A failed optional presentation projection cannot replay it.
  await recordReceipt?.(committed).catch(() => undefined);
  return outcome.result;
}

export function isManagedSourceMutation(body?: GlassHiveSourceAuthorBody): boolean {
  return Boolean(
    body?.viventiumStreamId ||
    body?.viventiumLogicalTurnId ||
    body?.viventiumLogicalTurnRevision != null,
  );
}

export async function executeManagedSourceMutation(options: {
  userId: string;
  requestBody?: GlassHiveSourceAuthorBody;
  adapterId: string;
  routeId: string;
  operation: string;
  effectKind: IInteractionDurableEffect['effectKind'];
  occurrenceId: string;
  providerIdempotencyKey: string;
  providerIdempotencyMode: IInteractionDurableEffect['providerIdempotencyMode'];
  canonicalArgs: object;
  service: SourceMutationService;
  getJob: Parameters<typeof assertCurrentGlassHiveSourceAuthor>[0]['getJob'];
  dispatch(): Promise<SourceMutationResult>;
  recordReceipt?(row: IInteractionDurableEffect): Promise<void>;
  signal?: AbortSignal;
  rejectDispatch?(error: unknown): Promise<void>;
}): Promise<InteractionDurableEffectJsonValue> {
  if (!isManagedSourceMutation(options.requestBody)) return (await options.dispatch()).result;
  return executeSourceMutation({
    input: {
      streamId: options.requestBody?.viventiumStreamId || '',
      sourceEventId: options.requestBody?.viventiumSourceEventId,
      userId: options.userId,
      adapterId: options.adapterId,
      routeId: options.routeId,
      operation: options.operation,
      effectKind: options.effectKind,
      effectOrdinal: 0,
      effectOccurrenceRef: options.occurrenceId,
      providerIdempotencyKey: options.providerIdempotencyKey,
      providerIdempotencyMode: options.providerIdempotencyMode,
      canonicalArgs: options.canonicalArgs,
    },
    service: options.service,
    assertAuthor: async () => {
      try {
        options.signal?.throwIfAborted();
        await assertCurrentGlassHiveSourceAuthor(options);
      } catch (error) {
        await options.rejectDispatch?.(error);
        throw error;
      }
    },
    dispatch: options.dispatch,
    recordReceipt: options.recordReceipt,
  });
}

export type SourceEffectFact = Pick<
  IInteractionDurableEffect,
  | 'effectKey'
  | 'sourceEventId'
  | 'logicalTurnRevision'
  | 'responseMessageId'
  | 'effectKind'
  | 'status'
  | 'routeId'
  | 'operation'
  | 'providerReceiptRef'
>;

export interface SourceWorkFact {
  sourceEventId: string;
  originRef: string;
  workRef?: string;
  launchState: string;
}

export interface SourceRecoveryFacts {
  effects: readonly SourceEffectFact[];
  work: readonly SourceWorkFact[];
}

export function sourceEffectFacts(rows: readonly IInteractionDurableEffect[]): SourceEffectFact[] {
  return rows.map((row) => ({
    effectKey: row.effectKey,
    sourceEventId: row.sourceEventId,
    logicalTurnRevision: row.logicalTurnRevision,
    responseMessageId: row.responseMessageId,
    effectKind: row.effectKind,
    status: row.status,
    routeId: row.routeId,
    operation: row.operation,
    ...(row.providerReceiptRef ? { providerReceiptRef: row.providerReceiptRef } : {}),
  }));
}

export interface SourceEffectScope {
  ownerId: string;
  conversationId: string;
  logicalTurnId: string;
  sourceEventIds: readonly string[];
}

/** The selected goal keeps its own source identity inside this Main's accepted author scope. */
export function resolveManagedMutationSource(
  interaction: {
    source_event_id?: string;
    revision?: number;
    source_segments?: readonly {
      source_event_id?: string;
      authoring_revision?: number;
    }[];
  },
  selected?: string,
): string {
  if (!selected || selected === interaction.source_event_id)
    return interaction.source_event_id || '';
  if (
    !interaction.source_segments?.some(
      (source) =>
        source.source_event_id === selected && source.authoring_revision === interaction.revision,
    )
  ) {
    throw mutationError('source_mutation_source_not_owned');
  }
  return selected;
}

interface SourceEffectQuery {
  sort(order: { logicalTurnRevision: 1; createdAt: 1 }): SourceEffectQuery;
  limit(count: number): SourceEffectQuery;
  lean(): Promise<IInteractionDurableEffect[]>;
}

interface SourceEffectModel {
  find(filter: {
    ownerId: string;
    conversationId: string;
    logicalTurnId: string;
    sourceEventId: { $in: readonly string[] };
  }): SourceEffectQuery;
}

async function readSourceEffectRows(scope: SourceEffectScope, model: SourceEffectModel) {
  if (
    !scope.ownerId ||
    !scope.conversationId ||
    !scope.logicalTurnId ||
    scope.sourceEventIds.length > 32 ||
    scope.sourceEventIds.some((id) => !id)
  ) {
    throw mutationError('source_mutation_scope_invalid');
  }
  const rows = await model
    .find({
      ownerId: scope.ownerId,
      conversationId: scope.conversationId,
      logicalTurnId: scope.logicalTurnId,
      sourceEventId: { $in: scope.sourceEventIds },
    })
    .sort({ logicalTurnRevision: 1, createdAt: 1 })
    .limit(65)
    .lean();
  if (rows.length > 64) throw mutationError('source_mutation_facts_overflow');
  return rows;
}

export async function readSourceEffectFacts(scope: SourceEffectScope, model: SourceEffectModel) {
  return sourceEffectFacts(await readSourceEffectRows(scope, model));
}

/** A reservation is visible before dispatch; an expired claim remains an unknown outcome. */
export async function readSourceRecoverySnapshot(
  scope: SourceEffectScope,
  model: SourceEffectModel,
  workCollection: {
    find(
      filter: object,
      options: object,
    ): {
      sort(order: object): {
        limit(count: number): {
          toArray(): Promise<
            Array<
              SourceWorkFact & {
                preparationExpiresAt?: Date;
                dispatchExpiresAt?: Date;
              }
            >
          >;
        };
      };
    };
  },
  now = Date.now(),
): Promise<{ facts: SourceRecoveryFacts; pending: boolean }> {
  const effects = await readSourceEffectRows(scope, model);
  const work = await workCollection
    .find(
      {
        ownerId: scope.ownerId,
        conversationId: scope.conversationId,
        sourceEventId: { $in: scope.sourceEventIds },
      },
      {
        projection: {
          sourceEventId: 1,
          originRef: 1,
          workRef: 1,
          launchState: 1,
          preparationExpiresAt: 1,
          dispatchExpiresAt: 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .limit(65)
    .toArray();
  if (work.length > 64) throw mutationError('source_mutation_facts_overflow');
  let pending = false;
  const activeClaim = (value: Date | undefined) => {
    const expires = new Date(value ?? 0).getTime();
    if (!Number.isFinite(expires) || expires <= 0) {
      throw mutationError('source_mutation_claim_unconfirmed');
    }
    pending ||= expires > now;
    return expires > now;
  };
  const facts: SourceRecoveryFacts = {
    effects: sourceEffectFacts(effects).map((fact, index) =>
      fact.status === 'reserved' && !activeClaim(effects[index].claimExpiresAt)
        ? { ...fact, status: 'provider_outcome_unknown' }
        : fact,
    ),
    work: work.map((row) => ({
      sourceEventId: row.sourceEventId,
      originRef: row.originRef,
      ...(row.workRef ? { workRef: row.workRef } : {}),
      launchState:
        ['prepared', 'dispatch_ready'].includes(row.launchState) &&
        !activeClaim(
          row.launchState === 'prepared' ? row.preparationExpiresAt : row.dispatchExpiresAt,
        )
          ? 'dispatch_unknown'
          : row.launchState,
    })),
  };
  return { facts, pending };
}
/* === VIVENTIUM END === */
