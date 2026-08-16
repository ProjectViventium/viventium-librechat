/* === VIVENTIUM START ===
 * Feature: Core-owned Active work delivery projection.
 * Purpose: GlassHive owns execution state, while Core owns actual user-surface delivery. Join the
 * two by opaque workRef so the roster never reports every completed mission as pending forever.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');

const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const DISMISS_SAFE_DELIVERY_STATES = new Set(['delivered', 'acknowledged', 'silent']);
const CORE_ONLY_ATTENTION_LIMIT = 100;
const ORIGIN_SURFACES = new Set(['librechat', 'telegram', 'voice', 'workbench']);
let indexPromise;

function normalizeText(value, maxLength = 160) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function externalWorkCollection() {
  return mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
}

async function ensureGlassHiveExternalWorkIndexes() {
  if (!indexPromise) {
    const collection = externalWorkCollection();
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
    ]).catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  await indexPromise;
}

function projectedDelivery(item, row) {
  if (!row) return item?.delivery;
  const terminal = TERMINAL_STATES.has(normalizeText(item?.state, 32));
  const deliveryState = normalizeText(row.deliveryState, 32).toLowerCase();
  const adjudicationState = normalizeText(row.adjudicationState, 32).toLowerCase();

  let state = 'pending';
  if (deliveryState === 'sent') {
    state = 'delivered';
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

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function coreOnlyFailureSummary(row) {
  const destinations = Array.isArray(row?.configuredDestinations)
    ? row.configuredDestinations
    : [];
  const originSurface = destinations
    .map((value) => normalizeText(value, 32).toLowerCase())
    .find((value) => ORIGIN_SURFACES.has(value));
  return {
    workRef: normalizeText(row?.originRef || row?._id),
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
    delivery: { state: 'failed', unreadTerminal: true },
    ...(isoDate(row?.createdAt) ? { createdAt: isoDate(row.createdAt) } : {}),
    ...(isoDate(row?.updatedAt) ? { updatedAt: isoDate(row.updatedAt) } : {}),
    actions: ['dismiss'],
  };
}

async function coreOnlyFailureRows(ownerId) {
  const cursor = externalWorkCollection()
    .find(
      {
        ownerId,
        workRef: '',
        launchState: 'not_dispatched',
        externalState: 'failed',
        attentionPending: { $ne: false },
      },
      {
        projection: {
          _id: 1,
          originRef: 1,
          configuredDestinations: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ updatedAt: -1, _id: 1 })
    .limit(CORE_ONLY_ATTENTION_LIMIT);
  return cursor.toArray();
}

function dismissedAttentionReceipt(originRef) {
  return {
    accepted: true,
    action: 'dismiss',
    workRef: originRef,
    state: 'dismissed',
  };
}

async function dismissCoreOnlyPreDispatchAttention({ ownerId, originRef, operationId } = {}) {
  const normalizedOwnerId = normalizeText(ownerId);
  const normalizedOriginRef = normalizeText(originRef);
  const normalizedOperationId = normalizeText(operationId);
  if (!normalizedOwnerId || !normalizedOriginRef || !normalizedOperationId) return null;
  const identity = {
    _id: normalizedOriginRef,
    ownerId: normalizedOwnerId,
    workRef: '',
    launchState: 'not_dispatched',
    externalState: 'failed',
  };
  const now = new Date();
  const updated = await externalWorkCollection().findOneAndUpdate(
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
  const updatedRow = updated?.value || updated;
  if (updatedRow?._id) return dismissedAttentionReceipt(normalizedOriginRef);

  const existing = await externalWorkCollection().findOne(identity, {
    projection: { _id: 1, dismissOperationId: 1 },
  });
  if (!existing) return null;
  if (normalizeText(existing.dismissOperationId) === normalizedOperationId) {
    return dismissedAttentionReceipt(normalizedOriginRef);
  }
  const error = new Error('glasshive_pre_dispatch_attention_already_dismissed');
  error.code = 'glasshive_pre_dispatch_attention_already_dismissed';
  error.status = 409;
  throw error;
}

async function getCoreWorkDelivery({ ownerId, workRef } = {}) {
  const normalizedOwnerId = normalizeText(ownerId);
  const normalizedWorkRef = normalizeText(workRef);
  if (!normalizedOwnerId || !normalizedWorkRef) return null;
  await ensureGlassHiveExternalWorkIndexes();
  const row = await externalWorkCollection().findOne(
    { ownerId: normalizedOwnerId, workRef: normalizedWorkRef },
    {
      projection: {
        _id: 0,
        deliveryState: 1,
        adjudicationState: 1,
        attentionPending: 1,
      },
    },
  );
  return row ? projectedDelivery({ state: 'completed' }, row) : null;
}

async function enrichActiveWorkSnapshot({ ownerId, snapshot, includeCoreOnly = false } = {}) {
  const normalizedOwnerId = normalizeText(ownerId);
  const hasAuthoritativeWork = Array.isArray(snapshot?.work);
  const mayProjectUnavailableAttention = includeCoreOnly && snapshot?.work == null;
  if (!normalizedOwnerId || !snapshot || (!hasAuthoritativeWork && !mayProjectUnavailableAttention)) {
    return snapshot;
  }
  const sourceWork = hasAuthoritativeWork ? snapshot.work : [];
  const workRefs = [
    ...new Set(sourceWork.map((item) => normalizeText(item?.workRef)).filter(Boolean)),
  ];
  if (!workRefs.length && !includeCoreOnly) return snapshot;

  await ensureGlassHiveExternalWorkIndexes();
  const [rows, coreOnlyRows] = await Promise.all([
    workRefs.length
      ? externalWorkCollection()
          .find(
            { ownerId: normalizedOwnerId, workRef: { $in: workRefs } },
            {
              projection: {
                _id: 0,
                workRef: 1,
                deliveryState: 1,
                adjudicationState: 1,
                attentionPending: 1,
              },
            },
          )
          .toArray()
      : [],
    includeCoreOnly ? coreOnlyFailureRows(normalizedOwnerId) : [],
  ]);
  const byRef = new Map(rows.map((row) => [normalizeText(row.workRef), row]));
  const projectedWork = sourceWork.map((item) => {
    const row = byRef.get(normalizeText(item?.workRef));
    const delivery = projectedDelivery(item, row);
    const actions = Array.isArray(item?.actions) ? item.actions : [];
    return {
      ...item,
      ...(row ? { delivery } : {}),
      actions: DISMISS_SAFE_DELIVERY_STATES.has(normalizeText(delivery?.state, 32).toLowerCase())
        ? actions
        : actions.filter((action) => action !== 'dismiss'),
    };
  });
  const knownRefs = new Set(projectedWork.map((item) => normalizeText(item?.workRef)));
  for (const row of coreOnlyRows) {
    const item = coreOnlyFailureSummary(row);
    if (!item.workRef || knownRefs.has(item.workRef)) continue;
    knownRefs.add(item.workRef);
    projectedWork.push(item);
  }
  return {
    ...snapshot,
    work: projectedWork.length > 0 || hasAuthoritativeWork ? projectedWork : snapshot.work,
  };
}

module.exports = {
  dismissCoreOnlyPreDispatchAttention,
  enrichActiveWorkSnapshot,
  ensureGlassHiveExternalWorkIndexes,
  getCoreWorkDelivery,
};
