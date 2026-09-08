/* === VIVENTIUM START ===
 * Feature: Durable completed-cortex insight outbox.
 * Purpose: Replay graph results whose first delivery-ledger write did not complete.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const createViventiumCortexInsightOutbox = require('~/db/viventiumCortexInsightOutbox');
const {
  buildCortexInsightDeliveryCandidates,
  normalizeCortexFeelingSnapshot,
  recordCompletedCortexInsightDeliveryBatch,
  requireExactCortexInsightDeliveryAcceptance,
  requireExactCortexInsightPersistenceEnvelope,
} = require('~/server/services/viventium/CortexInsightDeliveryService');

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_REPLAY_BACKOFF_MS = 1_000;
const MAX_REPLAY_BACKOFF_MS = 60_000;
const MAX_BATCH_ENTRIES = 256;
const MAX_BATCH_DOCUMENT_BYTES = 8 * 1024 * 1024;
const LEGACY_REPLAY_CLAIM_MS = 5 * 60 * 1000;
const REPLAY_STATE_PENDING = 'pending';
const REPLAY_STATE_QUARANTINED = 'quarantined';
const QUARANTINED_REPLAY_FAILURE_CODES = new Set([
  'cortex_feeling_snapshot_invalid',
  'cortex_insight_delivery_batch_mixed_envelope',
  'cortex_insight_delivery_envelope_conflict',
]);
const TRANSACTION_SUPPORT = new WeakMap();
const LEGACY_REPLAY_LOCKS = new WeakMap();

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim();
}

function exactInsightText(value) {
  const exact = value == null ? '' : String(value);
  return exact.trim() ? exact : '';
}

function buildOutboxEntries(params, now) {
  const entries = new Map();
  const feelingSnapshot = normalizeCortexFeelingSnapshot(params?.feelingSnapshot);
  const completedInsights = [];
  for (const insight of Array.isArray(params?.insights) ? params.insights : []) {
    const exactInsight = exactInsightText(insight?.insight);
    if (!exactInsight) continue;
    completedInsights.push({ ...insight, insight: exactInsight });
  }
  const candidates = buildCortexInsightDeliveryCandidates({
    ...params,
    insights: completedInsights,
  });
  for (const candidate of candidates) {
    const source = completedInsights.find((insight) => {
      const [single] = buildCortexInsightDeliveryCandidates({ ...params, insights: [insight] });
      return single?.deliveryKey === candidate.deliveryKey;
    });
    if (!source) continue;
    entries.set(candidate.deliveryKey, {
      outboxKey: candidate.deliveryKey,
      deliveryId: candidate.deliveryId,
      userId: candidate.userId,
      conversationId: candidate.conversationId,
      parentMessageId: candidate.parentMessageId,
      cortexId: candidate.cortexId,
      cortexName: candidate.cortexName,
      insight: source.insight,
      insightHash: candidate.insightHash,
      graphResultHash: candidate.graphResultHash,
      surface: candidate.surface,
      streamId: candidate.streamId,
      sourceRevision: candidate.sourceRevision,
      messageRevision: candidate.messageRevision,
      batchId: candidate.batchId,
      batchSize: candidate.batchSize,
      batchMemberHashes: candidate.batchMemberHashes,
      ...(feelingSnapshot ? { feelingSnapshot } : {}),
      nextAttemptAt: now,
      replayAttempts: 0,
      replayState: REPLAY_STATE_PENDING,
      lastFailureCode: '',
      lastFailureAt: null,
      quarantinedAt: null,
      retentionAlertAt: new Date(now.getTime() + RETENTION_MS),
    });
  }
  const batchEntries = [...entries.values()];
  const batchOutboxKeys = batchEntries.map((entry) => entry.outboxKey).sort();
  return batchEntries.map((entry) => ({ ...entry, batchOutboxKeys }));
}

function outboxConflictError() {
  const error = new Error('Completed Cortex insight outbox identity conflicts with stored work');
  error.code = 'cortex_insight_outbox_conflict';
  return error;
}

function assertBoundedBatchEnvelope(entries, durableEnvelope) {
  if (
    entries.length > MAX_BATCH_ENTRIES ||
    Buffer.byteLength(JSON.stringify(durableEnvelope), 'utf8') > MAX_BATCH_DOCUMENT_BYTES
  ) {
    const error = new Error('Completed Cortex insight batch exceeds the durable outbox limit');
    error.code = 'cortex_insight_outbox_batch_too_large';
    throw error;
  }
}

function isTransactionUnsupported(error) {
  const code = Number(error?.code);
  return (
    [20, 263, 40573].includes(code) ||
    /transaction numbers are only allowed|transactions are not supported/i.test(
      String(error?.message || ''),
    )
  );
}

function createCortexInsightOutboxService({
  OutboxModel = createViventiumCortexInsightOutbox(mongoose),
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  function lacksEmbeddedBatch(row) {
    return !Array.isArray(row?.batchEntries) || row.batchEntries.length === 0;
  }

  function hasDeclaredBatchMembership(row) {
    return (
      normalizeText(row?.batchId) !== '' ||
      Number(row?.batchSize) > 1 ||
      (Array.isArray(row?.batchMemberHashes) && row.batchMemberHashes.length > 0) ||
      (Array.isArray(row?.batchOutboxKeys) && row.batchOutboxKeys.length > 0) ||
      row?.legacyBatchMigrated === true
    );
  }

  function isUndeclaredLegacyRow(row) {
    return lacksEmbeddedBatch(row) && !hasDeclaredBatchMembership(row);
  }

  function isDeclaredTransitionRow(row) {
    return lacksEmbeddedBatch(row) && hasDeclaredBatchMembership(row);
  }

  function legacyBatchIdentity(row) {
    return JSON.stringify({
      userId: normalizeText(row?.userId),
      conversationId: normalizeText(row?.conversationId),
      parentMessageId: normalizeText(row?.parentMessageId),
      surface: normalizeText(row?.surface),
      streamId: normalizeText(row?.streamId),
      sourceRevision: Math.max(1, Number(row?.sourceRevision ?? row?.messageRevision) || 1),
      feelingSnapshot: normalizeCortexFeelingSnapshot(row?.feelingSnapshot),
    });
  }

  async function readLegacyBatch(seed) {
    const query = OutboxModel.find({
      userId: seed.userId,
      conversationId: seed.conversationId,
      parentMessageId: seed.parentMessageId,
      surface: seed.surface,
      $or: [{ batchEntries: { $exists: false } }, { batchEntries: { $size: 0 } }],
    })
      .select(
        '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
          '+batchOutboxKeys +batchEntries +legacyBatchMigrated +legacyReplayClaimToken ' +
          '+legacyReplayClaimExpiresAt',
      )
      .sort({ createdAt: 1, _id: 1 });
    const rows = await query.lean();
    const identity = legacyBatchIdentity(seed);
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => isUndeclaredLegacyRow(row) && legacyBatchIdentity(row) === identity)
      .sort(
        (left, right) =>
          new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime() ||
          String(left._id).localeCompare(String(right._id)),
      );
  }

  async function readDeclaredCoordinator(seed) {
    if (typeof OutboxModel?.findOne !== 'function') return null;
    const query = OutboxModel.findOne({
      userId: seed.userId,
      conversationId: seed.conversationId,
      parentMessageId: seed.parentMessageId,
      surface: seed.surface,
      batchOutboxKeys: seed.outboxKey,
    }).select(
      '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
        '+batchOutboxKeys +batchEntries +legacyBatchMigrated +legacyReplayClaimToken ' +
        '+legacyReplayClaimExpiresAt',
    );
    return query.lean();
  }

  async function readDeclaredTransitionBatch(coordinator, onRowsRead = () => {}) {
    const batchId = normalizeText(coordinator?.batchId);
    const batchSize = Number(coordinator?.batchSize);
    const memberHashes = Array.isArray(coordinator?.batchMemberHashes)
      ? coordinator.batchMemberHashes.map(normalizeText).filter(Boolean).sort()
      : [];
    const outboxKeys = Array.isArray(coordinator?.batchOutboxKeys)
      ? coordinator.batchOutboxKeys.map(normalizeText).filter(Boolean).sort()
      : [];
    if (
      !batchId ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      memberHashes.length !== batchSize ||
      new Set(memberHashes).size !== batchSize ||
      outboxKeys.length !== batchSize ||
      new Set(outboxKeys).size !== batchSize ||
      !outboxKeys.includes(normalizeText(coordinator?.outboxKey))
    ) {
      throw outboxConflictError();
    }
    const query = OutboxModel.find({ outboxKey: { $in: outboxKeys } })
      .select(
        '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
          '+batchOutboxKeys +batchEntries +legacyBatchMigrated +legacyReplayClaimToken ' +
          '+legacyReplayClaimExpiresAt',
      )
      .sort({ createdAt: 1, _id: 1 });
    const rows = await query.lean();
    onRowsRead(Array.isArray(rows) ? rows : []);
    if (!Array.isArray(rows) || rows.length !== batchSize) throw outboxConflictError();
    const identity = legacyBatchIdentity(coordinator);
    if (
      rows.some(
        (row) =>
          !lacksEmbeddedBatch(row) ||
          legacyBatchIdentity(row) !== identity ||
          !outboxKeys.includes(normalizeText(row?.outboxKey)),
      )
    ) {
      throw outboxConflictError();
    }
    const declaredId = String(coordinator._id || '');
    return [coordinator, ...rows.filter((row) => String(row?._id || '') !== declaredId)];
  }

  async function claimReplayBatch(rows, replayStartedAt, { requireLegacy = false } = {}) {
    const coordinator = rows[0];
    if (!coordinator) return null;
    const scopeKey = legacyBatchIdentity(coordinator);
    if (typeof OutboxModel?.findOneAndUpdate !== 'function' || !OutboxModel?.db) {
      let locks = LEGACY_REPLAY_LOCKS.get(OutboxModel);
      if (!locks) {
        locks = new Set();
        LEGACY_REPLAY_LOCKS.set(OutboxModel, locks);
      }
      if (locks.has(scopeKey)) return null;
      locks.add(scopeKey);
      return { coordinator, token: '', release: () => locks.delete(scopeKey) };
    }
    const token = `ciol_${randomUUID()}`;
    const claimExpiresAt = new Date(replayStartedAt.getTime() + LEGACY_REPLAY_CLAIM_MS);
    const query = OutboxModel.findOneAndUpdate(
      {
        _id: coordinator._id,
        outboxKey: coordinator.outboxKey,
        $and: [
          ...(requireLegacy
            ? [{ $or: [{ batchEntries: { $exists: false } }, { batchEntries: { $size: 0 } }] }]
            : []),
          {
            $or: [
              { legacyReplayClaimToken: { $exists: false } },
              { legacyReplayClaimToken: '' },
              { legacyReplayClaimExpiresAt: { $lte: replayStartedAt } },
            ],
          },
        ],
      },
      {
        $set: {
          legacyReplayClaimToken: token,
          legacyReplayClaimExpiresAt: claimExpiresAt,
        },
      },
      { new: true },
    );
    const claimed = query?.lean ? await query.lean() : await query;
    if (!claimed) return null;
    return {
      coordinator,
      token,
      release: async () => {
        await OutboxModel.updateOne(
          { _id: coordinator._id, outboxKey: coordinator.outboxKey, legacyReplayClaimToken: token },
          { $unset: { legacyReplayClaimToken: 1, legacyReplayClaimExpiresAt: 1 } },
        );
      },
    };
  }

  function replayBatchFor(entries) {
    const first = entries[0];
    return {
      ownerId: first.userId,
      conversationId: first.conversationId,
      parentMessageId: first.parentMessageId,
      surface: first.surface,
      streamId: first.streamId || '',
      messageRevision: Math.max(1, Number(first.sourceRevision ?? first.messageRevision) || 1),
      ...(first.feelingSnapshot ? { feelingSnapshot: first.feelingSnapshot } : {}),
      insights: entries.map((entry) => ({
        cortexId: entry.cortexId,
        cortexName: entry.cortexName,
        insight: entry.insight,
        status: 'completed',
      })),
    };
  }

  function requireExactLegacyReplayBatch(entries, replayBatch) {
    const expected = buildCortexInsightDeliveryCandidates(replayBatch);
    if (expected.length !== entries.length) throw outboxConflictError();
    for (let index = 0; index < entries.length; index += 1) {
      const candidate = expected[index];
      const entry = entries[index];
      if (
        candidate.userId !== normalizeText(entry.userId) ||
        candidate.conversationId !== normalizeText(entry.conversationId) ||
        candidate.parentMessageId !== normalizeText(entry.parentMessageId) ||
        candidate.cortexId !== normalizeText(entry.cortexId) ||
        candidate.cortexName !== normalizeText(entry.cortexName) ||
        candidate.insightHash !== normalizeText(entry.insightHash) ||
        candidate.graphResultHash !== normalizeText(entry.graphResultHash ?? entry.insightHash) ||
        candidate.surface !== normalizeText(entry.surface) ||
        candidate.streamId !== normalizeText(entry.streamId) ||
        candidate.sourceRevision !==
          Math.max(1, Number(entry.sourceRevision ?? entry.messageRevision) || 1)
      ) {
        throw outboxConflictError();
      }
    }
    assertBoundedBatchEnvelope(entries, replayBatch);
    return expected;
  }

  function requireExactMigratedLegacyCoordinator(row, entries, expectedDeliveries) {
    const expected = expectedDeliveries[0];
    const expectedMembers = [...expected.batchMemberHashes].map(normalizeText).sort();
    const persistedMembers = Array.isArray(row?.batchMemberHashes)
      ? [...row.batchMemberHashes].map(normalizeText).sort()
      : [];
    const expectedKeys = entries.map((entry) => normalizeText(entry?.outboxKey)).sort();
    const persistedKeys = Array.isArray(row?.batchOutboxKeys)
      ? [...row.batchOutboxKeys].map(normalizeText).sort()
      : [];
    if (
      row?.legacyBatchMigrated !== true ||
      normalizeText(row?.batchId) !== expected.batchId ||
      Number(row?.batchSize) !== entries.length ||
      JSON.stringify(persistedMembers) !== JSON.stringify(expectedMembers) ||
      JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)
    ) {
      throw outboxConflictError();
    }
  }

  function requireExactDeclaredTransitionCoordinator(row, entries, expectedDeliveries) {
    const expected = expectedDeliveries[0];
    const expectedMembers = [...expected.batchMemberHashes].map(normalizeText).sort();
    const persistedMembers = Array.isArray(row?.batchMemberHashes)
      ? [...row.batchMemberHashes].map(normalizeText).sort()
      : [];
    const expectedKeys = entries.map((entry) => normalizeText(entry?.outboxKey)).sort();
    const persistedKeys = Array.isArray(row?.batchOutboxKeys)
      ? [...row.batchOutboxKeys].map(normalizeText).sort()
      : [];
    if (
      normalizeText(row?.batchId) !== expected.batchId ||
      Number(row?.batchSize) !== entries.length ||
      JSON.stringify(persistedMembers) !== JSON.stringify(expectedMembers) ||
      JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)
    ) {
      throw outboxConflictError();
    }
  }

  function durableLegacyEntry(entry) {
    const durable = { ...entry };
    delete durable._id;
    delete durable.__v;
    delete durable.createdAt;
    delete durable.updatedAt;
    delete durable.legacyReplayClaimToken;
    delete durable.legacyReplayClaimExpiresAt;
    return durable;
  }

  async function migrateLegacyBatch(claim, entries, expectedDeliveries) {
    if (!claim?.token || typeof OutboxModel?.collection?.findOneAndUpdate !== 'function') {
      const firstExpected = expectedDeliveries[0];
      return {
        ...claim.coordinator,
        sourceRevision: Math.max(
          1,
          Number(claim.coordinator.sourceRevision ?? claim.coordinator.messageRevision) || 1,
        ),
        batchId: firstExpected.batchId,
        batchSize: entries.length,
        batchMemberHashes: firstExpected.batchMemberHashes,
        batchOutboxKeys: entries.map((entry) => entry.outboxKey).sort(),
        batchEntries: entries,
        legacyBatchMigrated: true,
      };
    }
    const durableEntries = entries.map(durableLegacyEntry);
    const firstExpected = expectedDeliveries[0];
    const declaredCoordinator = isDeclaredTransitionRow(claim.coordinator);
    const result = await OutboxModel.collection.findOneAndUpdate(
      {
        _id: claim.coordinator._id,
        outboxKey: claim.coordinator.outboxKey,
        legacyReplayClaimToken: claim.token,
        $or: [{ batchEntries: { $exists: false } }, { batchEntries: { $size: 0 } }],
        ...(declaredCoordinator
          ? {
              batchId: claim.coordinator.batchId,
              batchSize: claim.coordinator.batchSize,
              batchMemberHashes: claim.coordinator.batchMemberHashes,
              batchOutboxKeys: claim.coordinator.batchOutboxKeys,
            }
          : {}),
      },
      {
        $set: {
          sourceRevision: Math.max(
            1,
            Number(claim.coordinator.sourceRevision ?? claim.coordinator.messageRevision) || 1,
          ),
          batchId: firstExpected.batchId,
          batchSize: durableEntries.length,
          batchMemberHashes: firstExpected.batchMemberHashes,
          batchOutboxKeys: durableEntries.map((entry) => entry.outboxKey).sort(),
          batchEntries: durableEntries,
          legacyBatchMigrated: true,
        },
      },
      { returnDocument: 'after' },
    );
    const migrated = result?.value || result;
    if (!migrated) throw outboxConflictError();
    return migrated;
  }

  async function deleteRepresentedSiblings(coordinator, entries) {
    const siblingKeys = entries
      .map((entry) => normalizeText(entry?.outboxKey))
      .filter((outboxKey) => outboxKey && outboxKey !== coordinator.outboxKey);
    if (siblingKeys.length === 0) return;
    await OutboxModel.deleteMany({ outboxKey: { $in: siblingKeys } });
  }

  async function deleteReplayRows(entries) {
    const ids = entries.map((entry) => entry._id).filter(Boolean);
    if (typeof OutboxModel?.deleteMany === 'function') {
      return OutboxModel.deleteMany({ _id: { $in: ids } });
    }
    return Promise.all(
      entries.map((entry) => OutboxModel.deleteOne({ _id: entry._id, outboxKey: entry.outboxKey })),
    );
  }

  function replayFailureCode(error) {
    return String(error?.code || error?.name || 'outbox_replay_failed').slice(0, 120);
  }

  function isQuarantinedReplayFailure(error) {
    return QUARANTINED_REPLAY_FAILURE_CODES.has(replayFailureCode(error));
  }

  async function scheduleReplayFailure(entries, replayStartedAt, error) {
    const replayAttempts =
      Math.max(0, ...entries.map((entry) => Number(entry.replayAttempts) || 0)) + 1;
    const backoffMs = Math.min(
      MAX_REPLAY_BACKOFF_MS,
      MIN_REPLAY_BACKOFF_MS * 2 ** Math.min(replayAttempts - 1, 6),
    );
    const ids = entries.map((entry) => entry._id).filter(Boolean);
    if (typeof OutboxModel?.updateMany === 'function') {
      await OutboxModel.updateMany(
        { _id: { $in: ids } },
        {
          $set: {
            replayState: REPLAY_STATE_PENDING,
            nextAttemptAt: new Date(replayStartedAt.getTime() + backoffMs),
            lastFailureCode: replayFailureCode(error),
            lastFailureAt: replayStartedAt,
          },
          $inc: { replayAttempts: 1 },
        },
      );
      return;
    }
    await Promise.all(
      entries.map((entry) =>
        OutboxModel.updateOne(
          { _id: entry._id, outboxKey: entry.outboxKey },
          {
            $set: {
              replayState: REPLAY_STATE_PENDING,
              nextAttemptAt: new Date(replayStartedAt.getTime() + backoffMs),
              lastFailureCode: replayFailureCode(error),
              lastFailureAt: replayStartedAt,
            },
            $inc: { replayAttempts: 1 },
          },
        ),
      ),
    );
  }

  async function quarantineReplayFailure(entries, replayStartedAt, error) {
    const ids = entries.map((entry) => entry._id).filter(Boolean);
    const update = {
      $set: {
        replayState: REPLAY_STATE_QUARANTINED,
        lastFailureCode: replayFailureCode(error),
        lastFailureAt: replayStartedAt,
        quarantinedAt: replayStartedAt,
      },
      $inc: { replayAttempts: 1 },
    };
    if (typeof OutboxModel?.updateMany === 'function') {
      const result = await OutboxModel.updateMany({ _id: { $in: ids } }, update);
      return Number(result?.matchedCount ?? result?.modifiedCount) === ids.length;
    }
    const results = await Promise.all(
      entries.map((entry) =>
        OutboxModel.updateOne({ _id: entry._id, outboxKey: entry.outboxKey }, update),
      ),
    );
    return results.every((result) => Number(result?.matchedCount ?? result?.modifiedCount) === 1);
  }

  async function runTransaction(work) {
    const startSession = OutboxModel?.db?.startSession;
    if (typeof startSession !== 'function' || TRANSACTION_SUPPORT.get(OutboxModel) === false) {
      return { used: false, result: null };
    }
    const session = await startSession.call(OutboxModel.db);
    if (!session || typeof session.withTransaction !== 'function') {
      await session?.endSession?.();
      TRANSACTION_SUPPORT.set(OutboxModel, false);
      return { used: false, result: null };
    }
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      TRANSACTION_SUPPORT.set(OutboxModel, true);
      return { used: true, result };
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        TRANSACTION_SUPPORT.set(OutboxModel, false);
        return { used: false, result: null };
      }
      throw error;
    } finally {
      await session.endSession?.();
    }
  }

  async function readEntries(entries, session = null) {
    const query = OutboxModel.find({
      outboxKey: { $in: entries.map((entry) => entry.outboxKey) },
    }).select(
      '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
        '+batchOutboxKeys +batchEntries',
    );
    const sessionQuery = session && query?.session ? query.session(session) : query;
    const rows = await sessionQuery.lean();
    return Array.isArray(rows) ? rows : [];
  }

  function validateEntries(entries, persistedRows) {
    const expectedByKey = new Map(entries.map((entry) => [entry.outboxKey, entry]));
    for (const persisted of persistedRows) {
      const expected = expectedByKey.get(persisted?.outboxKey);
      if (!expected) continue;
      try {
        requireExactCortexInsightPersistenceEnvelope(expected, persisted);
        if (Array.isArray(persisted?.batchEntries) && persisted.batchEntries.length > 0) {
          if (persisted.batchEntries.length !== entries.length) throw outboxConflictError();
          const nestedByKey = new Map(
            persisted.batchEntries.map((entry) => [entry?.outboxKey, entry]),
          );
          for (const entry of entries) {
            const nested = nestedByKey.get(entry.outboxKey);
            if (!nested) throw outboxConflictError();
            requireExactCortexInsightPersistenceEnvelope(entry, nested);
          }
        }
      } catch (error) {
        if (isTransactionUnsupported(error)) throw error;
        throw outboxConflictError();
      }
    }
  }

  function requireExactReplayBatch(row, entries, replayBatch) {
    const expected = buildCortexInsightDeliveryCandidates(replayBatch);
    if (expected.length !== entries.length) throw outboxConflictError();
    const expectedByKey = new Map(expected.map((candidate) => [candidate.deliveryKey, candidate]));
    for (const entry of entries) {
      const candidate = expectedByKey.get(entry?.outboxKey);
      if (!candidate) throw outboxConflictError();
      requireExactCortexInsightPersistenceEnvelope(
        { ...candidate, outboxKey: candidate.deliveryKey },
        entry,
      );
    }
    const coordinator = expectedByKey.get(row?.outboxKey);
    if (!coordinator) throw outboxConflictError();
    const expectedMembers = [...coordinator.batchMemberHashes].map(normalizeText).sort();
    const persistedMembers = Array.isArray(row?.batchMemberHashes)
      ? [...row.batchMemberHashes].map(normalizeText).sort()
      : [];
    const expectedKeys = entries.map((entry) => normalizeText(entry?.outboxKey)).sort();
    const persistedKeys = Array.isArray(row?.batchOutboxKeys)
      ? [...row.batchOutboxKeys].map(normalizeText).sort()
      : [];
    if (
      normalizeText(row?.batchId) !== coordinator.batchId ||
      Number(row?.batchSize) !== expected.length ||
      JSON.stringify(persistedMembers) !== JSON.stringify(expectedMembers) ||
      JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)
    ) {
      throw outboxConflictError();
    }
    return expected;
  }

  async function enqueueBatch(params) {
    const entries = buildOutboxEntries(params, now());
    if (entries.length === 0) return { outboxKeys: [] };
    const coordinator = [...entries].sort((left, right) =>
      left.outboxKey.localeCompare(right.outboxKey),
    )[0];
    const durableEnvelope = { ...coordinator, batchEntries: entries };
    assertBoundedBatchEnvelope(entries, durableEnvelope);
    async function acceptExactExisting() {
      let persistedRows;
      try {
        persistedRows = await readEntries(entries);
        validateEntries(entries, persistedRows);
      } catch (_error) {
        throw outboxConflictError();
      }
      const persistedCoordinator = persistedRows.find(
        (row) => row.outboxKey === coordinator.outboxKey,
      );
      if (
        !persistedCoordinator ||
        (entries.length > 1 && persistedCoordinator.batchEntries?.length !== entries.length)
      ) {
        throw outboxConflictError();
      }
      return { outboxKeys: entries.map((entry) => entry.outboxKey) };
    }
    async function persistEntries(session = null, acceptanceToken = '') {
      let existingRows;
      try {
        existingRows = await readEntries(entries, session);
      } catch (error) {
        if (isTransactionUnsupported(error)) throw error;
        throw outboxConflictError();
      }
      validateEntries(entries, existingRows);
      await OutboxModel.bulkWrite(
        [durableEnvelope].map((entry) => ({
          updateOne: {
            filter: { outboxKey: entry.outboxKey },
            update: {
              $setOnInsert: {
                ...entry,
                ...(acceptanceToken ? { acceptanceToken } : {}),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false, ...(session ? { session } : {}) },
      );
      let persistedRows;
      try {
        persistedRows = await readEntries(entries, session);
      } catch (error) {
        if (isTransactionUnsupported(error)) throw error;
        throw outboxConflictError();
      }
      const persistedCoordinator = persistedRows.find(
        (row) => row.outboxKey === coordinator.outboxKey,
      );
      if (!persistedCoordinator) throw outboxConflictError();
      try {
        validateEntries(entries, persistedRows);
        if (entries.length > 1 && persistedCoordinator.batchEntries?.length !== entries.length) {
          throw outboxConflictError();
        }
      } catch (_error) {
        throw outboxConflictError();
      }
      return { outboxKeys: entries.map((entry) => entry.outboxKey) };
    }

    if (entries.length > 1) {
      try {
        const transaction = await runTransaction((session) => persistEntries(session));
        if (transaction.used) return transaction.result;
        return await persistEntries(null, `cioa_${randomUUID()}`);
      } catch (error) {
        if (Number(error?.code) === 11000) return acceptExactExisting();
        throw error;
      }
    }
    try {
      return await persistEntries();
    } catch (error) {
      if (Number(error?.code) === 11000) return acceptExactExisting();
      throw error;
    }
  }

  async function settleBatch({ outboxKeys = [] } = {}) {
    const supplied = Array.isArray(outboxKeys) ? outboxKeys : [];
    const normalized = supplied.map(normalizeText);
    const keys = [...new Set(normalized.filter(Boolean))];
    if (keys.length === 0) return { deleted: 0 };
    if (keys.length !== supplied.length || normalized.some((key) => !key)) {
      throw outboxConflictError();
    }
    const query = OutboxModel.find({
      $or: [{ outboxKey: { $in: keys } }, { batchOutboxKeys: { $in: keys } }],
    }).select(
      '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
        '+batchOutboxKeys +batchEntries +legacyBatchMigrated',
    );
    const rows = await query.lean();
    if (!Array.isArray(rows) || rows.length === 0) return { deleted: 0 };
    if (rows.length !== 1) throw outboxConflictError();
    const coordinator = rows[0];
    const expectedKeys =
      Array.isArray(coordinator.batchOutboxKeys) && coordinator.batchOutboxKeys.length > 0
        ? coordinator.batchOutboxKeys.map(normalizeText).sort()
        : [normalizeText(coordinator.outboxKey)];
    if (
      expectedKeys.length !== new Set(expectedKeys).size ||
      JSON.stringify([...keys].sort()) !== JSON.stringify(expectedKeys)
    ) {
      throw outboxConflictError();
    }
    if (Array.isArray(coordinator.batchEntries) && coordinator.batchEntries.length > 0) {
      const replayEntries = coordinator.batchEntries;
      const replayBatch = replayBatchFor(replayEntries);
      requireExactReplayBatch(coordinator, replayEntries, replayBatch);
    } else if (
      expectedKeys.length !== 1 ||
      Number(coordinator.batchSize || 1) !== 1 ||
      normalizeText(coordinator.outboxKey) !== expectedKeys[0]
    ) {
      throw outboxConflictError();
    }
    const result = await OutboxModel.deleteMany({
      _id: coordinator._id,
      outboxKey: coordinator.outboxKey,
    });
    return { deleted: Number(result?.deletedCount) || 0 };
  }

  async function replayPending({
    limit = 100,
    recordBatch = recordCompletedCortexInsightDeliveryBatch,
  } = {}) {
    const replayStartedAt = now();
    const dueFilter = {
      $and: [
        {
          $or: [{ replayState: { $exists: false } }, { replayState: REPLAY_STATE_PENDING }],
        },
        {
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: { $lte: replayStartedAt } },
          ],
        },
      ],
    };
    if (!(await OutboxModel.exists(dueFilter))) {
      return { scanned: 0, replayed: 0, pending: 0 };
    }
    const rows = await OutboxModel.find(dueFilter)
      .select(
        '+insight +streamId +feelingSnapshot +graphResultHash +batchMemberHashes ' +
          '+batchOutboxKeys +batchEntries +legacyBatchMigrated',
      )
      .sort({ nextAttemptAt: 1, createdAt: 1, _id: 1 })
      .hint('cortex_outbox_replay_due')
      .limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
      .lean();
    const summary = { scanned: 0, replayed: 0, pending: 0 };
    const scannedKeys = new Set();
    for (const pageRow of rows) {
      if (scannedKeys.has(pageRow.outboxKey)) continue;
      let row = pageRow;
      let replayEntries = [pageRow];
      let failureRows = [pageRow];
      let replayClaim = null;
      try {
        if (lacksEmbeddedBatch(pageRow)) {
          const declaredCoordinator = await readDeclaredCoordinator(pageRow);
          if (declaredCoordinator) {
            scannedKeys.add(pageRow.outboxKey);
            row = declaredCoordinator;
            failureRows = [declaredCoordinator];
          }
        }
        const beganLegacy = isUndeclaredLegacyRow(row);
        const beganDeclaredTransition = isDeclaredTransitionRow(row);
        replayEntries =
          Array.isArray(row.batchEntries) && row.batchEntries.length > 0 ? row.batchEntries : [row];
        if (beganLegacy || beganDeclaredTransition) {
          if (beganDeclaredTransition) {
            replayEntries = await readDeclaredTransitionBatch(row, (representedRows) => {
              failureRows = representedRows;
            });
          } else {
            replayEntries = await readLegacyBatch(row);
            failureRows = replayEntries;
          }
          replayClaim = await claimReplayBatch(replayEntries, replayStartedAt, {
            requireLegacy: true,
          });
          if (!replayClaim) {
            replayEntries.forEach((entry) => scannedKeys.add(entry.outboxKey));
            summary.scanned = scannedKeys.size;
            continue;
          }
        } else {
          replayClaim = await claimReplayBatch([row], replayStartedAt);
          if (!replayClaim) {
            scannedKeys.add(row.outboxKey);
            summary.scanned = scannedKeys.size;
            continue;
          }
        }
        (beganLegacy || beganDeclaredTransition ? replayEntries : [row]).forEach((entry) =>
          scannedKeys.add(entry.outboxKey),
        );
        summary.scanned = scannedKeys.size;
        const retentionAlertAt = row.retentionAlertAt ? new Date(row.retentionAlertAt) : null;
        if (
          retentionAlertAt instanceof Date &&
          Number.isFinite(retentionAlertAt.getTime()) &&
          retentionAlertAt.getTime() <= now().getTime()
        ) {
          logger.warn('[VIVENTIUM][cortex-insight-outbox] Pending retention threshold reached', {
            code: 'cortex_insight_outbox_retention_alert',
          });
        }
        const legacyEnvelope =
          beganLegacy || beganDeclaredTransition || row.legacyBatchMigrated === true;
        validateEntries(replayEntries, legacyEnvelope ? replayEntries : [row]);
        if (!legacyEnvelope && Number(row.batchSize || 1) !== replayEntries.length) {
          throw outboxConflictError();
        }
        if (replayEntries.length > MAX_BATCH_ENTRIES) throw outboxConflictError();
        const replayBatch = replayBatchFor(replayEntries);
        let expectedDeliveries;
        if (legacyEnvelope) {
          expectedDeliveries = requireExactLegacyReplayBatch(replayEntries, replayBatch);
          if (beganDeclaredTransition) {
            requireExactDeclaredTransitionCoordinator(row, replayEntries, expectedDeliveries);
          }
        } else if (replayEntries.length > 1) {
          expectedDeliveries = requireExactReplayBatch(row, replayEntries, replayBatch);
        } else {
          expectedDeliveries = buildCortexInsightDeliveryCandidates(replayBatch);
        }
        if (expectedDeliveries.length !== replayEntries.length) throw outboxConflictError();
        let replayCoordinator = row;
        if (beganLegacy || beganDeclaredTransition) {
          replayCoordinator = await migrateLegacyBatch(
            replayClaim,
            replayEntries,
            expectedDeliveries,
          );
        }
        if (replayCoordinator.legacyBatchMigrated === true) {
          requireExactMigratedLegacyCoordinator(
            replayCoordinator,
            replayEntries,
            expectedDeliveries,
          );
          await deleteRepresentedSiblings(replayCoordinator, replayEntries);
          failureRows = [replayCoordinator];
        }
        const receipt = await recordBatch(replayBatch);
        requireExactCortexInsightDeliveryAcceptance(expectedDeliveries, receipt);
        await deleteReplayRows([replayCoordinator]);
        summary.replayed += 1;
      } catch (error) {
        scannedKeys.add(pageRow.outboxKey);
        summary.scanned = scannedKeys.size;
        const failureRowsToUpdate = failureRows.length > 0 ? failureRows : [row || pageRow];
        const shouldQuarantine = isQuarantinedReplayFailure(error);
        let quarantined = false;
        try {
          if (shouldQuarantine) {
            quarantined = await quarantineReplayFailure(
              failureRowsToUpdate,
              replayStartedAt,
              error,
            );
          } else {
            await scheduleReplayFailure(failureRowsToUpdate, replayStartedAt, error);
          }
        } catch (scheduleError) {
          logger.warn('[VIVENTIUM][cortex-insight-outbox] Replay backoff persistence failed', {
            code: String(
              scheduleError?.code || scheduleError?.name || 'outbox_replay_backoff_failed',
            ).slice(0, 120),
          });
        }
        if (quarantined) {
          summary.quarantined = Number(summary.quarantined || 0) + 1;
          logger.warn('[VIVENTIUM][cortex-insight-outbox] Replay quarantined for operator repair', {
            code: 'cortex_insight_outbox_quarantined',
            failureCode: replayFailureCode(error),
          });
        } else {
          summary.pending += 1;
          logger.warn('[VIVENTIUM][cortex-insight-outbox] Replay remains pending', {
            code: replayFailureCode(error),
          });
        }
      } finally {
        await replayClaim?.release?.();
      }
    }
    return summary;
  }

  return { enqueueBatch, settleBatch, replayPending };
}

const defaultService = createCortexInsightOutboxService();

module.exports = {
  createCortexInsightOutboxService,
  enqueueCompletedCortexInsightOutboxBatch: defaultService.enqueueBatch,
  settleCompletedCortexInsightOutboxBatch: defaultService.settleBatch,
  replayCompletedCortexInsightOutbox: defaultService.replayPending,
};
