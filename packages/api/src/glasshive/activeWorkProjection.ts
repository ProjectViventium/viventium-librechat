/* === VIVENTIUM START ===
 * Feature: Core-owned Active work delivery projection.
 * Purpose: GlassHive owns execution state, while Core owns actual user-surface delivery. Join the
 * two by opaque workRef so the roster never reports every completed mission as pending forever.
 * === VIVENTIUM END === */

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const DISMISS_SAFE_DELIVERY_STATES = new Set(['delivered', 'acknowledged', 'silent']);
const SETTLED_CORE_DELIVERY_STATES = new Set([
  'sent',
  'delivered',
  'acknowledged',
  'silent',
  'suppressed',
]);
const CORE_ONLY_ATTENTION_LIMIT = 100;
const CORE_ONLY_TERMINAL_RECENCY_MS = 3 * 24 * 60 * 60 * 1000;
const STATE_RECONCILIATION_MIN_RETRY_MS = 5000;
const STATE_RECONCILIATION_MAX_RETRY_MS = 5 * 60 * 1000;
const ORIGIN_SURFACES = new Set(['librechat', 'telegram', 'voice', 'workbench']);

type UnknownRecord = Record<string, unknown>;

export interface ExternalWorkCursor {
  sort: (sort: UnknownRecord) => ExternalWorkCursor;
  limit: (limit: number) => ExternalWorkCursor;
  toArray: () => Promise<UnknownRecord[]>;
}

export interface ExternalWorkCollection {
  createIndex: (keys: UnknownRecord, options: UnknownRecord) => Promise<unknown>;
  find: (filter: UnknownRecord, options?: UnknownRecord) => ExternalWorkCursor;
  findOne: (filter: UnknownRecord, options?: UnknownRecord) => Promise<UnknownRecord | null>;
  findOneAndUpdate: (
    filter: UnknownRecord,
    update: UnknownRecord,
    options?: UnknownRecord,
  ) => Promise<UnknownRecord | null>;
  updateOne: (
    filter: UnknownRecord,
    update: UnknownRecord,
    options?: UnknownRecord,
  ) => Promise<UnknownRecord>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function normalizeText(value: unknown, maxLength = 160): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function isoDate(value: unknown): string | undefined {
  const date = value instanceof Date ? value : new Date(normalizeText(value, 128));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function dateFrom(value: unknown, fallback: Date): Date {
  const date = value instanceof Date ? value : new Date(normalizeText(value, 128));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

export function createGlassHiveActiveWorkProjectionService(collection: ExternalWorkCollection) {
  let indexPromise: Promise<unknown[]> | undefined;

  async function ensureGlassHiveExternalWorkIndexes(): Promise<void> {
    if (!indexPromise) {
      indexPromise = Promise.all([
        collection.createIndex(
          { ownerId: 1, workRef: 1 },
          { name: 'owner_work_ref', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, externalState: 1, updatedAt: -1 },
          { name: 'owner_state_updated', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, launchState: 1, externalState: 1 },
          { name: 'owner_launch_external', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, launchState: 1, attentionPending: 1 },
          { name: 'owner_launch_attention', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, launchState: 1, deliveryState: 1 },
          { name: 'owner_launch_delivery', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, schedulerDispatchDocumentId: 1 },
          { name: 'owner_scheduler_dispatch', background: true },
        ),
        collection.createIndex(
          { ownerId: 1, scheduleOccurrenceKey: 1 },
          { name: 'owner_schedule_occurrence', background: true },
        ),
        collection.createIndex(
          { workRef: 1, launchState: 1, reconciliationNextAt: 1, updatedAt: 1 },
          { name: 'launch_reconciliation', background: true },
        ),
      ]).catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    }
    await indexPromise;
  }

  function projectedDelivery(itemValue: unknown, rowValue?: unknown): unknown {
    const item = recordFrom(itemValue);
    if (!rowValue) {
      return item.delivery;
    }
    const row = recordFrom(rowValue);
    const terminal = TERMINAL_STATES.has(normalizeText(item.state, 32));
    const deliveryState = normalizeText(row.deliveryState, 32).toLowerCase();
    const adjudicationState = normalizeText(row.adjudicationState, 32).toLowerCase();

    let state = 'pending';
    if (deliveryState === 'sent') {
      state = 'delivered';
    } else if (deliveryState === 'unknown') {
      state = 'unknown';
    } else if (deliveryState === 'acknowledged') {
      state = 'acknowledged';
    } else if (deliveryState === 'suppressed' || adjudicationState === 'silent') {
      state = 'silent';
    } else if (
      deliveryState === 'failed' ||
      deliveryState === 'unresolved' ||
      adjudicationState === 'failed'
    ) {
      state = 'failed';
    }

    return {
      state,
      unreadTerminal:
        terminal &&
        row.attentionPending !== false &&
        !['delivered', 'acknowledged', 'silent'].includes(state),
    };
  }

  function workStateReconciliationFilter(ownerId: unknown, workRef: unknown): UnknownRecord {
    return {
      ownerId: normalizeText(ownerId),
      workRef: normalizeText(workRef),
      externalState: { $nin: Array.from(TERMINAL_STATES) },
    };
  }

  function stateReconciliationErrorCode(error: unknown): string {
    const normalized = recordFrom(error);
    const candidate = normalizeText(normalized.code || normalized.name, 120);
    return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate)
      ? candidate
      : 'work_state_reconciliation_failed';
  }

  async function deferGlassHiveWorkStateReconciliation({
    ownerId,
    row: rowValue,
    error,
  }: {
    ownerId?: unknown;
    row?: unknown;
    error?: unknown;
  } = {}): Promise<{ reconciled: boolean; pending: boolean }> {
    const row = recordFrom(rowValue);
    const normalizedOwnerId = normalizeText(ownerId);
    const workRef = normalizeText(row.workRef);
    if (!normalizedOwnerId || !workRef) {
      return { reconciled: false, pending: false };
    }
    const now = new Date();
    const attempts = Math.max(0, Number(row.stateReconciliationAttempts) || 0) + 1;
    const retryMs = Math.min(
      STATE_RECONCILIATION_MAX_RETRY_MS,
      STATE_RECONCILIATION_MIN_RETRY_MS * 2 ** Math.min(attempts - 1, 6),
    );
    const pendingAt = dateFrom(row.stateReconciliationPendingAt, now);
    await collection.updateOne(workStateReconciliationFilter(normalizedOwnerId, workRef), {
      $set: {
        stateReconciliationPendingAt: pendingAt,
        stateReconciliationNextAt: new Date(now.getTime() + retryMs),
        stateReconciliationErrorCode: stateReconciliationErrorCode(error),
        updatedAt: now,
      },
      $inc: { stateReconciliationAttempts: 1 },
    });
    return { reconciled: false, pending: true };
  }

  async function reconcileAuthoritativeGlassHiveWorkState({
    ownerId,
    item: itemValue,
    row: rowValue,
  }: {
    ownerId?: unknown;
    item?: unknown;
    row?: unknown;
  } = {}): Promise<{ reconciled: boolean; pending: boolean }> {
    const item = recordFrom(itemValue);
    const row = recordFrom(rowValue);
    const normalizedOwnerId = normalizeText(ownerId);
    const workRef = normalizeText(item.workRef);
    const state = normalizeText(item.state, 32).toLowerCase();
    const currentState = normalizeText(row.externalState, 32).toLowerCase();
    if (
      !normalizedOwnerId ||
      !workRef ||
      workRef !== normalizeText(row.workRef) ||
      !TERMINAL_STATES.has(state) ||
      !currentState ||
      TERMINAL_STATES.has(currentState)
    ) {
      return { reconciled: false, pending: false };
    }

    const now = new Date();
    const lifecycle = recordFrom(item.lifecycle);
    const observedTerminalAt = dateFrom(lifecycle.endedAt || item.updatedAt, now);
    const deliveryState = normalizeText(row.deliveryState, 32).toLowerCase();
    const fields: UnknownRecord = {
      externalState: state,
      terminalAt: observedTerminalAt,
      attentionPending: !SETTLED_CORE_DELIVERY_STATES.has(deliveryState),
      updatedAt: now,
      stateReconciliationAppliedAt: now,
      stateReconciliationPendingAt: null,
      stateReconciliationNextAt: null,
      stateReconciliationAttempts: 0,
      stateReconciliationErrorCode: '',
      ...(deliveryState ? {} : { deliveryState: 'pending' }),
    };
    const runRef = normalizeText(item.runRef, 96);
    const attemptNumber = Number(lifecycle.attemptNumber);
    if (/^run_sha256:[a-f0-9]{64}$/.test(runRef)) {
      fields.stateReconciliationRunRef = runRef;
    }
    if (Number.isSafeInteger(attemptNumber) && attemptNumber > 0) {
      fields.stateReconciliationAttemptNumber = attemptNumber;
    }

    try {
      const result = await collection.updateOne(
        workStateReconciliationFilter(normalizedOwnerId, workRef),
        { $set: fields },
      );
      if (result.acknowledged === false) {
        throw Object.assign(new Error('work state projection was not acknowledged'), {
          code: 'work_state_projection_unacknowledged',
        });
      }
      if (Number(result.matchedCount ?? 1) === 0) {
        return { reconciled: false, pending: false };
      }
      Object.assign(row, fields);
      return { reconciled: true, pending: false };
    } catch (error) {
      return deferGlassHiveWorkStateReconciliation({
        ownerId: normalizedOwnerId,
        row,
        error,
      });
    }
  }

  function coreOnlyTerminalRecencyMs(): number {
    const configured = Number(process.env.VIVENTIUM_ACTIVE_WORK_TERMINAL_RECENCY_MS);
    if (!Number.isFinite(configured)) {
      return CORE_ONLY_TERMINAL_RECENCY_MS;
    }
    return Math.max(60_000, Math.min(Math.trunc(configured), 365 * 24 * 60 * 60 * 1000));
  }

  function coreOnlyFailureSummary(
    rowValue: unknown,
    { history = false }: { history?: boolean } = {},
  ): UnknownRecord {
    const row = recordFrom(rowValue);
    const destinations = Array.isArray(row.configuredDestinations)
      ? row.configuredDestinations
      : [];
    const originSurface = destinations
      .map((value) => normalizeText(value, 32).toLowerCase())
      .find((value) => ORIGIN_SURFACES.has(value));
    const createdAt = isoDate(row.createdAt);
    const updatedAt = isoDate(row.updatedAt);
    return {
      workRef: normalizeText(row.originRef || row._id),
      title: 'Mission could not start',
      state: 'failed',
      statusSummary: 'No worker was started.',
      attention: {
        kind: 'launch_failed',
        summary:
          'Parallel work could not start this mission. You can dismiss this notice and try again from the conversation.',
      },
      provider: '',
      ...(originSurface ? { originSurface } : {}),
      delivery: {
        state: row.attentionPending === false ? 'acknowledged' : 'failed',
        unreadTerminal: !history,
      },
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      actions: history ? [] : ['dismiss'],
    };
  }

  async function coreOnlyFailureRows(
    ownerId: string,
    { history = false }: { history?: boolean } = {},
  ): Promise<UnknownRecord[]> {
    const cutoff = new Date(Date.now() - coreOnlyTerminalRecencyMs());
    const query: UnknownRecord = {
      ownerId,
      workRef: '',
      launchState: 'not_dispatched',
      externalState: 'failed',
      ...(history
        ? { $or: [{ attentionPending: false }, { updatedAt: { $lt: cutoff } }] }
        : { attentionPending: { $ne: false }, updatedAt: { $gte: cutoff } }),
    };
    return collection
      .find(query, {
        projection: {
          _id: 1,
          originRef: 1,
          configuredDestinations: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(CORE_ONLY_ATTENTION_LIMIT)
      .toArray();
  }

  function dismissedAttentionReceipt(originRef: string): UnknownRecord {
    return { accepted: true, action: 'dismiss', workRef: originRef, state: 'dismissed' };
  }

  async function dismissCoreOnlyPreDispatchAttention({
    ownerId,
    originRef,
    operationId,
  }: {
    ownerId?: unknown;
    originRef?: unknown;
    operationId?: unknown;
  } = {}): Promise<UnknownRecord | null> {
    const normalizedOwnerId = normalizeText(ownerId);
    const normalizedOriginRef = normalizeText(originRef);
    const normalizedOperationId = normalizeText(operationId);
    if (!normalizedOwnerId || !normalizedOriginRef || !normalizedOperationId) {
      return null;
    }
    const identity = {
      _id: normalizedOriginRef,
      ownerId: normalizedOwnerId,
      workRef: '',
      launchState: 'not_dispatched',
      externalState: 'failed',
    };
    const now = new Date();
    const updated = await collection.findOneAndUpdate(
      {
        ...identity,
        attentionPending: { $ne: false },
        $or: [
          { dismissOperationId: { $exists: false } },
          { dismissOperationId: normalizedOperationId },
        ],
      },
      {
        $set: {
          attentionPending: false,
          deliveryState: 'acknowledged',
          dismissOperationId: normalizedOperationId,
          dismissedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    const updatedRecord = recordFrom(updated);
    const updatedRow = recordFrom(updatedRecord.value || updated);
    if (updatedRow._id) {
      return dismissedAttentionReceipt(normalizedOriginRef);
    }

    const existing = await collection.findOne(identity, {
      projection: { _id: 1, dismissOperationId: 1 },
    });
    if (!existing) {
      return null;
    }
    if (normalizeText(existing.dismissOperationId) === normalizedOperationId) {
      return dismissedAttentionReceipt(normalizedOriginRef);
    }
    throw Object.assign(new Error('glasshive_pre_dispatch_attention_already_dismissed'), {
      code: 'glasshive_pre_dispatch_attention_already_dismissed',
      status: 409,
    });
  }

  async function getCoreWorkDelivery({
    ownerId,
    workRef,
  }: {
    ownerId?: unknown;
    workRef?: unknown;
  } = {}): Promise<unknown> {
    const normalizedOwnerId = normalizeText(ownerId);
    const normalizedWorkRef = normalizeText(workRef);
    if (!normalizedOwnerId || !normalizedWorkRef) {
      return null;
    }
    await ensureGlassHiveExternalWorkIndexes();
    const row = await collection.findOne(
      { ownerId: normalizedOwnerId, workRef: normalizedWorkRef },
      { projection: { _id: 0, deliveryState: 1, adjudicationState: 1, attentionPending: 1 } },
    );
    return row ? projectedDelivery({ state: 'completed' }, row) : null;
  }

  async function getCoreWorkOriginRef({
    ownerId,
    workRef,
  }: {
    ownerId?: unknown;
    workRef?: unknown;
  } = {}): Promise<string | null> {
    const normalizedOwnerId = normalizeText(ownerId);
    const normalizedWorkRef = normalizeText(workRef);
    if (!normalizedOwnerId || !normalizedWorkRef) {
      return null;
    }
    await ensureGlassHiveExternalWorkIndexes();
    const row = await collection.findOne(
      { ownerId: normalizedOwnerId, workRef: normalizedWorkRef },
      { projection: { _id: 1, originRef: 1 } },
    );
    return normalizeText(row?.originRef || row?._id) || null;
  }

  async function enrichActiveWorkSnapshot({
    ownerId,
    snapshot,
    includeCoreOnly = false,
    includeCoreOnlyHistory = false,
  }: {
    ownerId?: unknown;
    snapshot?: UnknownRecord | null;
    includeCoreOnly?: boolean;
    includeCoreOnlyHistory?: boolean;
  } = {}): Promise<UnknownRecord | null | undefined> {
    const normalizedOwnerId = normalizeText(ownerId);
    const hasAuthoritativeWork = Array.isArray(snapshot?.work);
    const mayProjectUnavailableAttention = includeCoreOnly && snapshot?.work == null;
    const includeCoreProjection = includeCoreOnly || includeCoreOnlyHistory;
    if (
      !normalizedOwnerId ||
      !snapshot ||
      (!hasAuthoritativeWork && !mayProjectUnavailableAttention)
    ) {
      return snapshot;
    }
    const sourceWork: unknown[] = Array.isArray(snapshot.work) ? snapshot.work : [];
    const workRefs = [
      ...new Set(sourceWork.map((item) => normalizeText(recordFrom(item).workRef)).filter(Boolean)),
    ];
    if (!workRefs.length && !includeCoreProjection) {
      return snapshot;
    }

    await ensureGlassHiveExternalWorkIndexes();
    const [rows, coreOnlyRows] = await Promise.all([
      workRefs.length
        ? collection
            .find(
              { ownerId: normalizedOwnerId, workRef: { $in: workRefs } },
              {
                projection: {
                  _id: 0,
                  workRef: 1,
                  externalState: 1,
                  deliveryState: 1,
                  adjudicationState: 1,
                  attentionPending: 1,
                  stateReconciliationAttempts: 1,
                  stateReconciliationPendingAt: 1,
                },
              },
            )
            .toArray()
        : [],
      includeCoreProjection
        ? coreOnlyFailureRows(normalizedOwnerId, { history: includeCoreOnlyHistory })
        : [],
    ]);
    const byRef = new Map(rows.map((row) => [normalizeText(row.workRef), row]));
    await Promise.all(
      sourceWork
        .filter((itemValue) => {
          const item = recordFrom(itemValue);
          const row = byRef.get(normalizeText(item.workRef));
          return (
            row &&
            TERMINAL_STATES.has(normalizeText(item.state, 32).toLowerCase()) &&
            !TERMINAL_STATES.has(normalizeText(row.externalState, 32).toLowerCase())
          );
        })
        .map((itemValue) => {
          const item = recordFrom(itemValue);
          return reconcileAuthoritativeGlassHiveWorkState({
            ownerId: normalizedOwnerId,
            item,
            row: byRef.get(normalizeText(item.workRef)),
          });
        }),
    );
    const projectedWork = sourceWork.map((itemValue): UnknownRecord => {
      const item = recordFrom(itemValue);
      const row = byRef.get(normalizeText(item.workRef));
      const delivery = projectedDelivery(item, row);
      const actions = Array.isArray(item.actions) ? item.actions : [];
      return {
        ...item,
        ...(row ? { delivery } : {}),
        actions: DISMISS_SAFE_DELIVERY_STATES.has(
          normalizeText(recordFrom(delivery).state, 32).toLowerCase(),
        )
          ? actions
          : actions.filter((action) => action !== 'dismiss'),
      };
    });
    const knownRefs = new Set(projectedWork.map((item) => normalizeText(item.workRef)));
    for (const row of coreOnlyRows) {
      const item = coreOnlyFailureSummary(row, { history: includeCoreOnlyHistory });
      const workRef = normalizeText(item.workRef);
      if (!workRef || knownRefs.has(workRef)) {
        continue;
      }
      knownRefs.add(workRef);
      projectedWork.push(item);
    }
    return {
      ...snapshot,
      work: projectedWork.length > 0 || hasAuthoritativeWork ? projectedWork : snapshot.work,
    };
  }

  return {
    deferGlassHiveWorkStateReconciliation,
    dismissCoreOnlyPreDispatchAttention,
    enrichActiveWorkSnapshot,
    ensureGlassHiveExternalWorkIndexes,
    getCoreWorkDelivery,
    getCoreWorkOriginRef,
    reconcileAuthoritativeGlassHiveWorkState,
  };
}
