/* === VIVENTIUM START ===
 * Feature: Atomic GlassHive terminal-result receiver CAS.
 * Purpose: A lower or conflicting callback can never replace the durable winner.
 * === VIVENTIUM END === */

import crypto from 'crypto';
import type { ClientSession, Model } from 'mongoose';
import type {
  IGlassHiveTerminalCallbackResult,
  GlassHiveTerminalCallbackCasDecision,
  GlassHiveTerminalCallbackEffectLease,
  GlassHiveTerminalCallbackEffectLeaseDecision,
  GlassHiveTerminalCallbackAcceptedOperationReference,
  GlassHiveTerminalCallbackResultIdentity,
} from '~/types/glassHiveTerminalCallbackResult';

const MAX_UPSERT_RACE_RETRIES = 3;

function receiverKey(identity: GlassHiveTerminalCallbackResultIdentity): string {
  const encoded = [identity.ownerId, identity.originRef, identity.workRef, identity.runId].join(
    '\0',
  );
  return `ghtr_${crypto.createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

function isDuplicateKeyError(error: object): boolean {
  return 'code' in error && error.code === 11000;
}

function exactIdentity(
  current: IGlassHiveTerminalCallbackResult,
  incoming: GlassHiveTerminalCallbackResultIdentity,
): boolean {
  return (
    current.ownerId === incoming.ownerId &&
    current.originRef === incoming.originRef &&
    current.workRef === incoming.workRef &&
    current.workerId === incoming.workerId &&
    current.runId === incoming.runId &&
    current.callbackId === incoming.callbackId &&
    current.attemptNumber === incoming.attemptNumber &&
    current.resultState === incoming.resultState &&
    current.resultEndedAt === incoming.resultEndedAt &&
    current.resultRevision === incoming.resultRevision &&
    current.resultDigest === incoming.resultDigest
  );
}

function resultIdentity(
  result: IGlassHiveTerminalCallbackResult,
): GlassHiveTerminalCallbackResultIdentity {
  return {
    ownerId: result.ownerId,
    originRef: result.originRef,
    workRef: result.workRef,
    workerId: result.workerId,
    runId: result.runId,
    callbackId: result.callbackId,
    attemptNumber: result.attemptNumber,
    resultState: result.resultState,
    resultEndedAt: result.resultEndedAt,
    resultRevision: result.resultRevision,
    resultDigest: result.resultDigest,
  };
}

function leaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 15 * 60 * 1000) {
    throw new Error('glasshive_terminal_callback_effect_lease_duration_invalid');
  }
  return value;
}

function currentStatus(
  current: IGlassHiveTerminalCallbackResult,
  incoming: GlassHiveTerminalCallbackResultIdentity,
): 'busy' | 'superseded' | 'conflict' {
  if (current.resultRevision > incoming.resultRevision) return 'superseded';
  if (exactIdentity(current, incoming)) return 'busy';
  return 'conflict';
}

export async function compareAndSetGlassHiveTerminalCallbackResult({
  ResultModel,
  incoming,
  now = new Date(),
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  incoming: GlassHiveTerminalCallbackResultIdentity;
  now?: Date;
}): Promise<GlassHiveTerminalCallbackCasDecision> {
  const _id = receiverKey(incoming);
  const acceptedOperationId = crypto.randomBytes(16).toString('hex');
  const higherRevision = {
    $lt: [{ $ifNull: ['$resultRevision', 0] }, incoming.resultRevision],
  };
  const activeEffectLease = {
    $and: [
      { $ne: [{ $ifNull: ['$effectLeaseId', ''] }, ''] },
      { $gt: [{ $ifNull: ['$effectLeaseExpiresAt', new Date(0)] }, now] },
    ],
  };
  const incomingWins = { $and: [higherRevision, { $not: [activeEffectLease] }] };
  const updatePipeline = [
    {
      $set: {
        ownerId: { $ifNull: ['$ownerId', incoming.ownerId] },
        originRef: { $ifNull: ['$originRef', incoming.originRef] },
        workRef: { $ifNull: ['$workRef', incoming.workRef] },
        runId: { $ifNull: ['$runId', incoming.runId] },
        workerId: { $cond: [incomingWins, incoming.workerId, '$workerId'] },
        callbackId: { $cond: [incomingWins, incoming.callbackId, '$callbackId'] },
        attemptNumber: { $cond: [incomingWins, incoming.attemptNumber, '$attemptNumber'] },
        resultState: { $cond: [incomingWins, incoming.resultState, '$resultState'] },
        resultEndedAt: { $cond: [incomingWins, incoming.resultEndedAt, '$resultEndedAt'] },
        resultRevision: { $cond: [incomingWins, incoming.resultRevision, '$resultRevision'] },
        resultDigest: { $cond: [incomingWins, incoming.resultDigest, '$resultDigest'] },
        acceptedOperationId: {
          $cond: [incomingWins, acceptedOperationId, '$acceptedOperationId'],
        },
        acceptedOperationGeneration: {
          $cond: [
            incomingWins,
            { $add: [{ $ifNull: ['$acceptedOperationGeneration', 0] }, 1] },
            { $ifNull: ['$acceptedOperationGeneration', 1] },
          ],
        },
        acceptedAt: { $cond: [incomingWins, now, '$acceptedAt'] },
        effectLeaseId: { $cond: [incomingWins, '$$REMOVE', '$effectLeaseId'] },
        effectLeaseOperationId: {
          $cond: [incomingWins, '$$REMOVE', '$effectLeaseOperationId'],
        },
        effectLeaseExpiresAt: {
          $cond: [incomingWins, '$$REMOVE', '$effectLeaseExpiresAt'],
        },
        createdAt: { $ifNull: ['$createdAt', now] },
        updatedAt: { $cond: [incomingWins, now, '$updatedAt'] },
      },
    },
  ];

  let current: IGlassHiveTerminalCallbackResult | null = null;
  for (let attempt = 0; attempt < MAX_UPSERT_RACE_RETRIES; attempt += 1) {
    try {
      current = await ResultModel.findOneAndUpdate({ _id }, updatePipeline, {
        new: true,
        upsert: true,
      })
        .lean<IGlassHiveTerminalCallbackResult>()
        .exec();
      break;
    } catch (error) {
      if (!(error instanceof Error) || !isDuplicateKeyError(error)) throw error;
    }
  }
  if (!current) throw new Error('glasshive_terminal_callback_result_cas_failed');
  if (
    current._id !== _id ||
    current.ownerId !== incoming.ownerId ||
    current.originRef !== incoming.originRef ||
    current.workRef !== incoming.workRef ||
    current.runId !== incoming.runId
  ) {
    throw new Error('glasshive_terminal_callback_result_scope_collision');
  }

  let status: GlassHiveTerminalCallbackCasDecision['status'] = 'conflict';
  if (current.acceptedOperationId === acceptedOperationId) status = 'accepted';
  else if (current.resultRevision > incoming.resultRevision) status = 'superseded';
  else if (exactIdentity(current, incoming)) status = 'idempotent';
  else if (current.resultRevision < incoming.resultRevision) {
    throw new Error('glasshive_terminal_callback_effects_in_progress');
  }
  return {
    status,
    incoming,
    current: resultIdentity(current),
    acceptedOperationId: current.acceptedOperationId,
    acceptedOperationGeneration: Number(current.acceptedOperationGeneration),
  };
}

export async function acquireGlassHiveTerminalCallbackEffectLease({
  ResultModel,
  incoming,
  acceptedOperationId,
  now = new Date(),
  leaseDurationMs = 60_000,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  incoming: GlassHiveTerminalCallbackResultIdentity;
  acceptedOperationId: string;
  now?: Date;
  leaseDurationMs?: number;
}): Promise<GlassHiveTerminalCallbackEffectLeaseDecision> {
  const _id = receiverKey(incoming);
  const leaseId = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + leaseDuration(leaseDurationMs));
  const current = await ResultModel.findOneAndUpdate(
    {
      _id,
      acceptedOperationId,
      callbackId: incoming.callbackId,
      resultRevision: incoming.resultRevision,
      resultDigest: incoming.resultDigest,
      $or: [
        { effectLeaseId: { $exists: false } },
        { effectLeaseExpiresAt: { $exists: false } },
        { effectLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        effectLeaseId: leaseId,
        effectLeaseOperationId: acceptedOperationId,
        effectLeaseExpiresAt: expiresAt,
      },
      $inc: { effectLeaseGeneration: 1 },
    },
    { new: true },
  )
    .lean<IGlassHiveTerminalCallbackResult>()
    .exec();
  if (current && current.effectLeaseId === leaseId) {
    const lease: GlassHiveTerminalCallbackEffectLease = {
      resultKey: _id,
      acceptedOperationId,
      acceptedOperationGeneration: Number(current.acceptedOperationGeneration),
      leaseId,
      generation: Number(current.effectLeaseGeneration),
      resultRevision: incoming.resultRevision,
      callbackId: incoming.callbackId,
      resultDigest: incoming.resultDigest,
    };
    return { status: 'acquired', lease };
  }

  const durable = await ResultModel.findById(_id).lean<IGlassHiveTerminalCallbackResult>().exec();
  if (!durable) throw new Error('glasshive_terminal_callback_result_missing');
  if (
    durable.ownerId !== incoming.ownerId ||
    durable.originRef !== incoming.originRef ||
    durable.workRef !== incoming.workRef ||
    durable.runId !== incoming.runId
  ) {
    throw new Error('glasshive_terminal_callback_result_scope_collision');
  }
  return { status: currentStatus(durable, incoming), current: resultIdentity(durable) };
}

/** Acquire a lease for a restart-time dispatcher that only has the accepted-operation reference. */
export async function acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
  ResultModel,
  reference,
  now = new Date(),
  leaseDurationMs = 60_000,
  session,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  reference: GlassHiveTerminalCallbackAcceptedOperationReference;
  now?: Date;
  leaseDurationMs?: number;
  session?: ClientSession;
}): Promise<GlassHiveTerminalCallbackEffectLease | null> {
  const leaseId = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + leaseDuration(leaseDurationMs));
  const current = await ResultModel.findOneAndUpdate(
    {
      _id: reference.resultKey,
      acceptedOperationId: reference.acceptedOperationId,
      acceptedOperationGeneration: reference.generation,
      callbackId: reference.callbackId,
      resultRevision: reference.resultRevision,
      resultDigest: reference.resultDigest,
      $or: [
        { effectLeaseId: { $exists: false } },
        { effectLeaseExpiresAt: { $exists: false } },
        { effectLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        effectLeaseId: leaseId,
        effectLeaseOperationId: reference.acceptedOperationId,
        effectLeaseExpiresAt: expiresAt,
      },
      $inc: { effectLeaseGeneration: 1 },
    },
    { new: true, ...(session ? { session } : {}) },
  )
    .lean<IGlassHiveTerminalCallbackResult>()
    .exec();
  if (!current || current.effectLeaseId !== leaseId) return null;
  return {
    resultKey: reference.resultKey,
    acceptedOperationId: reference.acceptedOperationId,
    acceptedOperationGeneration: reference.generation,
    leaseId,
    generation: Number(current.effectLeaseGeneration),
    resultRevision: reference.resultRevision,
    callbackId: reference.callbackId,
    resultDigest: reference.resultDigest,
  };
}

export async function renewGlassHiveTerminalCallbackEffectLease({
  ResultModel,
  lease,
  now = new Date(),
  leaseDurationMs = 60_000,
  session,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
  now?: Date;
  leaseDurationMs?: number;
  session?: ClientSession;
}): Promise<boolean> {
  const result = await ResultModel.updateOne(
    {
      _id: lease.resultKey,
      acceptedOperationId: lease.acceptedOperationId,
      callbackId: lease.callbackId,
      resultRevision: lease.resultRevision,
      resultDigest: lease.resultDigest,
      effectLeaseId: lease.leaseId,
      effectLeaseOperationId: lease.acceptedOperationId,
      effectLeaseGeneration: lease.generation,
      effectLeaseExpiresAt: { $gt: now },
    },
    { $set: { effectLeaseExpiresAt: new Date(now.getTime() + leaseDuration(leaseDurationMs)) } },
    session ? { session } : undefined,
  ).exec();
  return result.matchedCount === 1;
}

/**
 * Take the central result row's write lock inside the destination transaction.
 *
 * The destination writes happen first in the same Mongo transaction. This final conditional
 * write either proves that the accepted operation and lease generation are still current, or
 * makes Mongo abort every provisional destination write. A revision accepted after the
 * transaction snapshot causes a write conflict; a revision accepted before this check causes a
 * zero-match fence failure.
 */
export async function fenceGlassHiveTerminalCallbackEffectTransaction({
  ResultModel,
  lease,
  session,
  now = new Date(),
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
  session: ClientSession;
  now?: Date;
}): Promise<boolean> {
  if (!session?.inTransaction()) {
    throw new Error('glasshive_terminal_callback_effect_transaction_required');
  }
  const result = await ResultModel.updateOne(
    {
      _id: lease.resultKey,
      acceptedOperationId: lease.acceptedOperationId,
      callbackId: lease.callbackId,
      resultRevision: lease.resultRevision,
      resultDigest: lease.resultDigest,
      effectLeaseId: lease.leaseId,
      effectLeaseOperationId: lease.acceptedOperationId,
      effectLeaseGeneration: lease.generation,
      effectLeaseExpiresAt: { $gt: now },
    },
    { $set: { updatedAt: now } },
    { session },
  ).exec();
  return result.matchedCount === 1;
}

/** Fence a restart-time projection/dispatcher against the still-current accepted result. */
export async function fenceGlassHiveTerminalCallbackAcceptedOperationTransaction({
  ResultModel,
  reference,
  session,
  now = new Date(),
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  reference: GlassHiveTerminalCallbackAcceptedOperationReference;
  session: ClientSession;
  now?: Date;
}): Promise<boolean> {
  if (!session?.inTransaction()) {
    throw new Error('glasshive_terminal_callback_effect_transaction_required');
  }
  const result = await ResultModel.updateOne(
    {
      _id: reference.resultKey,
      acceptedOperationId: reference.acceptedOperationId,
      acceptedOperationGeneration: reference.generation,
      callbackId: reference.callbackId,
      resultRevision: reference.resultRevision,
      resultDigest: reference.resultDigest,
    },
    { $set: { updatedAt: now } },
    { session },
  ).exec();
  return result.matchedCount === 1;
}

export async function releaseGlassHiveTerminalCallbackEffectLease({
  ResultModel,
  lease,
  session,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
  session?: ClientSession;
}): Promise<boolean> {
  const result = await ResultModel.updateOne(
    {
      _id: lease.resultKey,
      acceptedOperationId: lease.acceptedOperationId,
      callbackId: lease.callbackId,
      resultRevision: lease.resultRevision,
      resultDigest: lease.resultDigest,
      effectLeaseId: lease.leaseId,
      effectLeaseOperationId: lease.acceptedOperationId,
      effectLeaseGeneration: lease.generation,
    },
    {
      $unset: {
        effectLeaseId: '',
        effectLeaseOperationId: '',
        effectLeaseExpiresAt: '',
      },
    },
    session ? { session } : undefined,
  ).exec();
  return result.matchedCount === 1;
}
