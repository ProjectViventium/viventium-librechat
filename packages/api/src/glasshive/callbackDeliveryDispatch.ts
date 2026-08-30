/* === VIVENTIUM START === Durable surface-delivery dispatch permit owner. === */

import type {
  GlassHiveTerminalCallbackAcceptedOperationReference,
  GlassHiveTerminalCallbackEffectLease,
} from '@librechat/data-schemas';

const DEFAULT_DISPATCH_PERMIT_MS = 60_000;
const MIN_DISPATCH_PERMIT_MS = 5_000;
const MAX_DISPATCH_PERMIT_MS = 5 * 60_000;

export interface GlassHiveCallbackDeliveryDispatchRow {
  deliveryId: string;
  claimId: string;
  surface: string;
  status: string;
  userId?: string;
  voiceCallSessionId?: string;
  terminalCallbackResultKey?: string;
  terminalCallbackAcceptedOperationId?: string;
  terminalCallbackId?: string;
  terminalCallbackResultDigest?: string;
  terminalCallbackResultRevision?: number;
  terminalCallbackEffectGeneration?: number;
  dispatchPermitId?: string;
  dispatchPermitGeneration?: number;
  dispatchPermitExpiresAt?: Date | null;
  sentAt?: Date | null;
  leaseExpiresAt?: Date | null;
  lastError?: string;
  telegramSentMessageIds?: string[];
  telegramMessageId?: string;
  transportReceiptVersion?: number;
}

interface GlassHiveCallbackDeliveryLeanQuery<T> {
  lean(): Promise<T>;
  session(session: object): GlassHiveCallbackDeliveryLeanQuery<T>;
}

export interface GlassHiveCallbackDeliveryDispatchModel {
  findOne(
    filter: object,
  ): GlassHiveCallbackDeliveryLeanQuery<GlassHiveCallbackDeliveryDispatchRow | null>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options?: object,
  ): GlassHiveCallbackDeliveryLeanQuery<GlassHiveCallbackDeliveryDispatchRow | null>;
  updateOne(
    filter: object,
    update: object,
    options?: object,
  ): PromiseLike<{ matchedCount?: number }>;
}

export interface GlassHiveCallbackDeliveryDispatchPermit {
  deliveryId: string;
  claimId: string;
  surface: string;
  resultKey: string;
  acceptedOperationId: string;
  acceptedOperationGeneration: number;
  leaseId: string;
  generation: number;
  resultRevision: number;
  callbackId: string;
  resultDigest: string;
  expiresAt: Date;
}

export interface GlassHiveCallbackDeliveryConstraintInput {
  deliveryId: string;
  claimId: string;
  userId?: string;
  voiceCallSessionId?: string;
}

export interface AuthorizeGlassHiveCallbackDeliveryDispatchInput extends GlassHiveCallbackDeliveryConstraintInput {
  leaseMs?: number;
}

export interface RenewGlassHiveCallbackDeliveryDispatchInput extends GlassHiveCallbackDeliveryConstraintInput {
  dispatchPermit: GlassHiveCallbackDeliveryDispatchPermit;
  leaseMs?: number;
}

export interface ReleaseGlassHiveCallbackDeliveryDispatchInput extends GlassHiveCallbackDeliveryConstraintInput {
  dispatchPermit: GlassHiveCallbackDeliveryDispatchPermit;
}

export interface SettleGlassHiveCallbackDeliverySentInput extends GlassHiveCallbackDeliveryConstraintInput {
  dispatchPermit?: GlassHiveCallbackDeliveryDispatchPermit | null;
  telegramMessageIds?: string[];
}

export type GlassHiveCallbackDeliverySentSettlement =
  { handled: false } | { handled: true; row: GlassHiveCallbackDeliveryDispatchRow | null };

export interface GlassHiveCallbackDeliveryDispatchDependencies {
  DeliveryModel: GlassHiveCallbackDeliveryDispatchModel;
  resultExists(filter: object): Promise<boolean>;
  acquireEffectLease(input: {
    reference: GlassHiveTerminalCallbackAcceptedOperationReference;
    now: Date;
    leaseDurationMs: number;
    session: object;
  }): Promise<GlassHiveTerminalCallbackEffectLease | null>;
  renewEffectLease(input: {
    lease: GlassHiveTerminalCallbackEffectLease;
    now: Date;
    leaseDurationMs: number;
    session: object;
  }): Promise<boolean>;
  fenceEffectTransaction(input: {
    lease: GlassHiveTerminalCallbackEffectLease;
    now: Date;
    session: object;
  }): Promise<boolean>;
  releaseEffectLease(input: {
    lease: GlassHiveTerminalCallbackEffectLease;
    session: object;
  }): Promise<boolean>;
  runTransaction<T>(operation: (session: object) => T | Promise<T>): Promise<T>;
}

export interface GlassHiveCallbackDeliveryDispatchService {
  authorizeGlassHiveCallbackDeliveryDispatch(
    input: AuthorizeGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<GlassHiveCallbackDeliveryDispatchPermit | null>;
  renewGlassHiveCallbackDeliveryDispatch(
    input: RenewGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<GlassHiveCallbackDeliveryDispatchPermit | null>;
  releaseGlassHiveCallbackDeliveryDispatch(
    input: ReleaseGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<boolean>;
  settleGlassHiveCallbackDeliverySent(
    input: SettleGlassHiveCallbackDeliverySentInput,
  ): Promise<GlassHiveCallbackDeliverySentSettlement>;
}

function normalizeText(value: string | number | null | undefined): string {
  return String(value ?? '').trim();
}

function dispatchPermitDuration(value?: number): number {
  const parsed = Number(value) || DEFAULT_DISPATCH_PERMIT_MS;
  return Math.max(MIN_DISPATCH_PERMIT_MS, Math.min(parsed, MAX_DISPATCH_PERMIT_MS));
}

function terminalCallbackReference(
  row: GlassHiveCallbackDeliveryDispatchRow,
): GlassHiveTerminalCallbackAcceptedOperationReference | null {
  const reference = {
    resultKey: normalizeText(row.terminalCallbackResultKey),
    acceptedOperationId: normalizeText(row.terminalCallbackAcceptedOperationId),
    callbackId: normalizeText(row.terminalCallbackId),
    resultDigest: normalizeText(row.terminalCallbackResultDigest),
    resultRevision: Number(row.terminalCallbackResultRevision),
    generation: Number(row.terminalCallbackEffectGeneration),
  };
  if (
    !/^ghtr_[a-f0-9]{64}$/.test(reference.resultKey) ||
    !/^[a-f0-9]{32}$/.test(reference.acceptedOperationId) ||
    !/^cb_terminal_[a-f0-9]{64}$/.test(reference.callbackId) ||
    !/^sha256:[a-f0-9]{64}$/.test(reference.resultDigest) ||
    !Number.isSafeInteger(reference.resultRevision) ||
    reference.resultRevision < 1 ||
    !Number.isSafeInteger(reference.generation) ||
    reference.generation < 1
  ) {
    return null;
  }
  return reference;
}

function dispatchPermitLease(
  row: GlassHiveCallbackDeliveryDispatchRow,
): GlassHiveTerminalCallbackEffectLease | null {
  const reference = terminalCallbackReference(row);
  const leaseId = normalizeText(row.dispatchPermitId);
  const generation = Number(row.dispatchPermitGeneration);
  if (!reference || !/^[a-f0-9]{32}$/.test(leaseId) || !Number.isSafeInteger(generation)) {
    return null;
  }
  return {
    resultKey: reference.resultKey,
    acceptedOperationId: reference.acceptedOperationId,
    acceptedOperationGeneration: reference.generation,
    leaseId,
    generation,
    resultRevision: reference.resultRevision,
    callbackId: reference.callbackId,
    resultDigest: reference.resultDigest,
  };
}

function toDispatchPermit(
  row: GlassHiveCallbackDeliveryDispatchRow | null,
): GlassHiveCallbackDeliveryDispatchPermit | null {
  if (!row) return null;
  const lease = dispatchPermitLease(row);
  const expiresAt = row.dispatchPermitExpiresAt ? new Date(row.dispatchPermitExpiresAt) : null;
  if (!lease || !expiresAt || !Number.isFinite(expiresAt.getTime())) return null;
  return {
    deliveryId: normalizeText(row.deliveryId),
    claimId: normalizeText(row.claimId),
    surface: normalizeText(row.surface),
    ...lease,
    expiresAt,
  };
}

function permitMatches(
  row: GlassHiveCallbackDeliveryDispatchRow,
  permit: GlassHiveCallbackDeliveryDispatchPermit,
): boolean {
  const current = toDispatchPermit(row);
  return Boolean(
    current &&
    current.deliveryId === normalizeText(permit.deliveryId) &&
    current.claimId === normalizeText(permit.claimId) &&
    current.resultKey === normalizeText(permit.resultKey) &&
    current.acceptedOperationId === normalizeText(permit.acceptedOperationId) &&
    current.acceptedOperationGeneration === Number(permit.acceptedOperationGeneration) &&
    current.leaseId === normalizeText(permit.leaseId) &&
    current.generation === Number(permit.generation) &&
    current.resultRevision === Number(permit.resultRevision) &&
    current.callbackId === normalizeText(permit.callbackId) &&
    current.resultDigest === normalizeText(permit.resultDigest),
  );
}

function constraintFilter(input: GlassHiveCallbackDeliveryConstraintInput): object {
  return {
    deliveryId: normalizeText(input.deliveryId),
    claimId: normalizeText(input.claimId),
    status: 'claimed',
    ...(input.userId ? { userId: normalizeText(input.userId) } : {}),
    ...(input.voiceCallSessionId
      ? { voiceCallSessionId: normalizeText(input.voiceCallSessionId) }
      : {}),
  };
}

function isExpectedDispatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'glasshive_callback_delivery_claim_missing',
    'glasshive_callback_delivery_dispatch_claim_changed',
    'glasshive_callback_delivery_dispatch_fenced',
    'glasshive_callback_delivery_dispatch_permit_invalid',
  ].includes(error.message);
}

export function createGlassHiveCallbackDeliveryDispatchService(
  dependencies: GlassHiveCallbackDeliveryDispatchDependencies,
): GlassHiveCallbackDeliveryDispatchService {
  const {
    DeliveryModel,
    resultExists,
    acquireEffectLease,
    renewEffectLease,
    fenceEffectTransaction,
    releaseEffectLease,
    runTransaction,
  } = dependencies;

  async function markSuperseded(deliveryId: string): Promise<void> {
    await DeliveryModel.updateOne(
      { deliveryId, status: 'claimed' },
      {
        $set: {
          status: 'superseded',
          leaseExpiresAt: null,
          dispatchPermitId: '',
          dispatchPermitGeneration: 0,
          dispatchPermitExpiresAt: null,
          lastError: 'glasshive_callback_delivery_superseded',
        },
      },
    );
  }

  async function existingPermitIsCurrent(
    row: GlassHiveCallbackDeliveryDispatchRow,
    now: Date,
  ): Promise<boolean> {
    const lease = dispatchPermitLease(row);
    const expiresAt = row.dispatchPermitExpiresAt ? new Date(row.dispatchPermitExpiresAt) : null;
    if (!lease || !expiresAt || expiresAt <= now) return false;
    return resultExists({
      _id: lease.resultKey,
      acceptedOperationId: lease.acceptedOperationId,
      acceptedOperationGeneration: lease.acceptedOperationGeneration,
      callbackId: lease.callbackId,
      resultRevision: lease.resultRevision,
      resultDigest: lease.resultDigest,
      effectLeaseId: lease.leaseId,
      effectLeaseGeneration: lease.generation,
      effectLeaseExpiresAt: { $gt: now },
    });
  }

  async function authorizeGlassHiveCallbackDeliveryDispatch(
    input: AuthorizeGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<GlassHiveCallbackDeliveryDispatchPermit | null> {
    const now = new Date();
    const durationMs = dispatchPermitDuration(input.leaseMs);
    const constraint = constraintFilter(input);
    const initial = await DeliveryModel.findOne(constraint).lean();
    if (!initial) return null;
    if (await existingPermitIsCurrent(initial, now)) return toDispatchPermit(initial);
    const reference = terminalCallbackReference(initial);
    if (!reference) return null;

    try {
      return await runTransaction(async (session) => {
        const current = await DeliveryModel.findOne(constraint).session(session).lean();
        if (!current) throw new Error('glasshive_callback_delivery_claim_missing');
        const currentReference = terminalCallbackReference(current);
        if (!currentReference) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const lease = await acquireEffectLease({
          reference: currentReference,
          now,
          leaseDurationMs: durationMs,
          session,
        });
        if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const expiresAt = new Date(now.getTime() + durationMs);
        const row = await DeliveryModel.findOneAndUpdate(
          {
            ...constraint,
            $or: [
              { dispatchPermitId: '' },
              { dispatchPermitId: { $exists: false } },
              { dispatchPermitExpiresAt: null },
              { dispatchPermitExpiresAt: { $lte: now } },
            ],
          },
          {
            $set: {
              dispatchPermitId: lease.leaseId,
              dispatchPermitGeneration: lease.generation,
              dispatchPermitExpiresAt: expiresAt,
            },
          },
          { new: true, session },
        ).lean();
        if (!row) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
        return toDispatchPermit(row);
      });
    } catch (error) {
      const replay = await DeliveryModel.findOne(constraint).lean();
      if (replay && (await existingPermitIsCurrent(replay, now))) return toDispatchPermit(replay);
      const stillCurrent = await resultExists({
        _id: reference.resultKey,
        acceptedOperationId: reference.acceptedOperationId,
        acceptedOperationGeneration: reference.generation,
        callbackId: reference.callbackId,
        resultRevision: reference.resultRevision,
        resultDigest: reference.resultDigest,
      });
      if (!stillCurrent) {
        await markSuperseded(normalizeText(initial.deliveryId));
        return null;
      }
      if (isExpectedDispatchError(error)) return null;
      throw error;
    }
  }

  async function renewGlassHiveCallbackDeliveryDispatch(
    input: RenewGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<GlassHiveCallbackDeliveryDispatchPermit | null> {
    const now = new Date();
    const durationMs = dispatchPermitDuration(input.leaseMs);
    const constraint = constraintFilter(input);
    try {
      return await runTransaction(async (session) => {
        const current = await DeliveryModel.findOne({
          ...constraint,
          dispatchPermitExpiresAt: { $gt: now },
        })
          .session(session)
          .lean();
        if (!current || !permitMatches(current, input.dispatchPermit)) {
          throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        }
        const lease = dispatchPermitLease(current);
        if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const renewed = await renewEffectLease({
          lease,
          now,
          leaseDurationMs: durationMs,
          session,
        });
        if (!renewed) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const row = await DeliveryModel.findOneAndUpdate(
          {
            ...constraint,
            dispatchPermitId: current.dispatchPermitId,
            dispatchPermitGeneration: current.dispatchPermitGeneration,
            dispatchPermitExpiresAt: { $gt: now },
          },
          { $set: { dispatchPermitExpiresAt: new Date(now.getTime() + durationMs) } },
          { new: true, session },
        ).lean();
        if (!row) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
        return toDispatchPermit(row);
      });
    } catch (error) {
      if (isExpectedDispatchError(error)) return null;
      throw error;
    }
  }

  async function releaseGlassHiveCallbackDeliveryDispatch(
    input: ReleaseGlassHiveCallbackDeliveryDispatchInput,
  ): Promise<boolean> {
    const constraint = constraintFilter(input);
    try {
      return await runTransaction(async (session) => {
        const current = await DeliveryModel.findOne(constraint).session(session).lean();
        if (!current || !permitMatches(current, input.dispatchPermit)) return false;
        const lease = dispatchPermitLease(current);
        if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const released = await releaseEffectLease({ lease, session });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const cleared = await DeliveryModel.updateOne(
          {
            ...constraint,
            dispatchPermitId: current.dispatchPermitId,
            dispatchPermitGeneration: current.dispatchPermitGeneration,
          },
          {
            $set: {
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
            },
          },
          { session },
        );
        if (cleared.matchedCount !== 1) {
          throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
        }
        return true;
      });
    } catch (error) {
      if (isExpectedDispatchError(error)) return false;
      throw error;
    }
  }

  async function settleGlassHiveCallbackDeliverySent(
    input: SettleGlassHiveCallbackDeliverySentInput,
  ): Promise<GlassHiveCallbackDeliverySentSettlement> {
    const now = new Date();
    const constraint = constraintFilter(input);
    const initial = await DeliveryModel.findOne(constraint).lean();
    if (!initial || !terminalCallbackReference(initial)) return { handled: false };
    const dispatchPermit = input.dispatchPermit;
    if (!dispatchPermit || !permitMatches(initial, dispatchPermit)) {
      return { handled: true, row: null };
    }
    const expiresAt = initial.dispatchPermitExpiresAt
      ? new Date(initial.dispatchPermitExpiresAt)
      : null;
    if (!expiresAt || expiresAt <= now) return { handled: true, row: null };
    const messageIds = (input.telegramMessageIds || []).map(normalizeText).filter(Boolean);

    try {
      const row = await runTransaction(async (session) => {
        const current = await DeliveryModel.findOne({
          ...constraint,
          dispatchPermitExpiresAt: { $gt: now },
        })
          .session(session)
          .lean();
        if (!current || !permitMatches(current, dispatchPermit)) {
          throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        }
        const lease = dispatchPermitLease(current);
        if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const updated = await DeliveryModel.findOneAndUpdate(
          {
            ...constraint,
            dispatchPermitId: lease.leaseId,
            dispatchPermitGeneration: lease.generation,
            dispatchPermitExpiresAt: { $gt: now },
          },
          {
            $set: {
              status: 'sent',
              sentAt: now,
              leaseExpiresAt: null,
              lastError: '',
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
              ...(messageIds.length
                ? {
                    telegramSentMessageIds: messageIds,
                    telegramMessageId: messageIds[messageIds.length - 1],
                    transportReceiptVersion: 1,
                  }
                : {}),
            },
          },
          { new: true, session },
        ).lean();
        if (!updated) throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        const fenced = await fenceEffectTransaction({ lease, now, session });
        if (!fenced) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const released = await releaseEffectLease({ lease, session });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        return updated;
      });
      return { handled: true, row };
    } catch (error) {
      if (!isExpectedDispatchError(error)) throw error;
      await markSuperseded(normalizeText(input.deliveryId));
      return { handled: true, row: null };
    }
  }

  return {
    authorizeGlassHiveCallbackDeliveryDispatch,
    renewGlassHiveCallbackDeliveryDispatch,
    releaseGlassHiveCallbackDeliveryDispatch,
    settleGlassHiveCallbackDeliverySent,
  };
}

/* === VIVENTIUM END === */
