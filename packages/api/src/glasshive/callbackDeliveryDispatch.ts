/* === VIVENTIUM START === Durable surface-delivery dispatch permit owner. === */

import type {
  GlassHiveTerminalCallbackAcceptedOperationReference,
  GlassHiveTerminalCallbackEffectLease,
} from '@librechat/data-schemas';

const DEFAULT_DISPATCH_PERMIT_MS = 60_000;
const MIN_DISPATCH_PERMIT_MS = 5_000;
const MAX_DISPATCH_PERMIT_MS = 5 * 60_000;
const MAX_WORKER_COMPLETION_BINDINGS = 32;

interface GlassHiveCallbackDeliveryWorkerCompletionBinding {
  resultKey: string;
  acceptedOperationId: string;
  terminalCallbackId: string;
  resultDigest: string;
  resultRevision: number;
  effectGeneration: number;
}

interface GlassHiveCallbackDeliveryWorkerCompletionPresentation {
  bindings: ReadonlyArray<GlassHiveCallbackDeliveryWorkerCompletionBinding>;
}

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
  unknownAt?: Date | null;
  nextAttemptAt?: Date | null;
  projectionPendingAt?: Date | null;
  projectionNextAttemptAt?: Date | null;
  workerCompletionPresentation?: GlassHiveCallbackDeliveryWorkerCompletionPresentation | null;
  workerCompletionEffectLeases?: GlassHiveTerminalCallbackEffectLease[];
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
  permitId: string;
  permitGeneration: number;
  resultRevision: number;
  resultDigest: string;
  expiresAt: string;
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

export interface SettleGlassHiveCallbackDeliveryUnknownInput extends GlassHiveCallbackDeliveryConstraintInput {
  dispatchPermit?: GlassHiveCallbackDeliveryDispatchPermit | null;
  lastError?: string;
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
  settleGlassHiveCallbackDeliveryUnknown(
    input: SettleGlassHiveCallbackDeliveryUnknownInput,
  ): Promise<GlassHiveCallbackDeliverySentSettlement>;
}

function normalizeText(value: string | number | null | undefined): string {
  return String(value ?? '').trim();
}

function sanitizeDeliveryError(value?: string): string {
  return normalizeText(value)
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:access_)?token|api[_-]?key|secret)=([^&\s]+)/gi, '$1=<redacted>')
    .slice(0, 2000);
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

function workerCompletionReferences(
  row: GlassHiveCallbackDeliveryDispatchRow,
): GlassHiveTerminalCallbackAcceptedOperationReference[] | null {
  const presentation = row.workerCompletionPresentation;
  if (!presentation) return null;
  if (
    normalizeText(row.surface).toLowerCase() !== 'voice' ||
    !Array.isArray(presentation.bindings) ||
    presentation.bindings.length < 1 ||
    presentation.bindings.length > MAX_WORKER_COMPLETION_BINDINGS
  ) {
    return [];
  }
  const references = presentation.bindings.map((binding) =>
    terminalCallbackReference({
      ...row,
      terminalCallbackResultKey: binding?.resultKey,
      terminalCallbackAcceptedOperationId: binding?.acceptedOperationId,
      terminalCallbackId: binding?.terminalCallbackId,
      terminalCallbackResultDigest: binding?.resultDigest,
      terminalCallbackResultRevision: binding?.resultRevision,
      terminalCallbackEffectGeneration: binding?.effectGeneration,
    }),
  );
  if (references.some((reference) => !reference)) return [];
  const exactReferences = references as GlassHiveTerminalCallbackAcceptedOperationReference[];
  if (new Set(exactReferences.map((reference) => reference.resultKey)).size !== references.length) {
    return [];
  }
  const deliveryReference = terminalCallbackReference(row);
  if (
    !deliveryReference ||
    !exactReferences.some(
      (reference) =>
        reference.resultKey === deliveryReference.resultKey &&
        reference.acceptedOperationId === deliveryReference.acceptedOperationId &&
        reference.generation === deliveryReference.generation &&
        reference.callbackId === deliveryReference.callbackId &&
        reference.resultRevision === deliveryReference.resultRevision &&
        reference.resultDigest === deliveryReference.resultDigest,
    )
  ) {
    return [];
  }
  return exactReferences;
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

function dispatchPermitLeases(
  row: GlassHiveCallbackDeliveryDispatchRow,
): GlassHiveTerminalCallbackEffectLease[] {
  const references = workerCompletionReferences(row);
  if (references === null) {
    const lease = dispatchPermitLease(row);
    return lease ? [lease] : [];
  }
  const values = Array.isArray(row.workerCompletionEffectLeases)
    ? row.workerCompletionEffectLeases
    : [];
  if (references.length === 0 || values.length !== references.length) return [];
  const leases = references.map((reference, index) => {
    const value = values[index];
    const leaseId = normalizeText(value?.leaseId);
    const generation = Number(value?.generation);
    if (
      value?.resultKey !== reference.resultKey ||
      value?.acceptedOperationId !== reference.acceptedOperationId ||
      Number(value?.acceptedOperationGeneration) !== reference.generation ||
      value?.callbackId !== reference.callbackId ||
      Number(value?.resultRevision) !== reference.resultRevision ||
      value?.resultDigest !== reference.resultDigest ||
      !/^[a-f0-9]{32}$/.test(leaseId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      return null;
    }
    return { ...value, leaseId, generation };
  });
  if (leases.some((lease) => !lease)) return [];
  const exactLeases = leases as GlassHiveTerminalCallbackEffectLease[];
  if (
    new Set(exactLeases.map((lease) => lease.leaseId)).size !== exactLeases.length ||
    normalizeText(row.dispatchPermitId) !== exactLeases[0].leaseId ||
    Number(row.dispatchPermitGeneration) !== exactLeases[0].generation
  ) {
    return [];
  }
  return exactLeases;
}

function toDispatchPermit(
  row: GlassHiveCallbackDeliveryDispatchRow | null,
): GlassHiveCallbackDeliveryDispatchPermit | null {
  if (!row) return null;
  const lease = dispatchPermitLeases(row)[0];
  const expiresAt = row.dispatchPermitExpiresAt ? new Date(row.dispatchPermitExpiresAt) : null;
  if (!lease || !expiresAt || !Number.isFinite(expiresAt.getTime())) return null;
  return {
    deliveryId: normalizeText(row.deliveryId),
    claimId: normalizeText(row.claimId),
    surface: normalizeText(row.surface),
    permitId: lease.leaseId,
    permitGeneration: lease.generation,
    resultRevision: lease.resultRevision,
    resultDigest: lease.resultDigest,
    expiresAt: expiresAt.toISOString(),
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
    current.surface === normalizeText(permit.surface) &&
    current.permitId === normalizeText(permit.permitId) &&
    current.permitGeneration === Number(permit.permitGeneration) &&
    current.resultRevision === Number(permit.resultRevision) &&
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

  function observedSupersedeFence(
    row: GlassHiveCallbackDeliveryDispatchRow,
  ): Record<string, unknown> | null {
    const reference = terminalCallbackReference(row);
    const permitGeneration = Number(row.dispatchPermitGeneration ?? 0);
    const permitExpiresAt = row.dispatchPermitExpiresAt
      ? new Date(row.dispatchPermitExpiresAt)
      : null;
    if (
      !reference ||
      !Number.isSafeInteger(permitGeneration) ||
      (permitExpiresAt && !Number.isFinite(permitExpiresAt.getTime()))
    ) {
      return null;
    }
    return {
      terminalCallbackResultKey: reference.resultKey,
      terminalCallbackAcceptedOperationId: reference.acceptedOperationId,
      terminalCallbackId: reference.callbackId,
      terminalCallbackResultDigest: reference.resultDigest,
      terminalCallbackResultRevision: reference.resultRevision,
      terminalCallbackEffectGeneration: reference.generation,
      dispatchPermitId: normalizeText(row.dispatchPermitId),
      dispatchPermitGeneration: permitGeneration,
      dispatchPermitExpiresAt: permitExpiresAt,
    };
  }

  async function markSuperseded(
    constraint: object,
    observed: GlassHiveCallbackDeliveryDispatchRow,
  ): Promise<void> {
    const observedFence = observedSupersedeFence(observed);
    if (!observedFence) return;
    await DeliveryModel.updateOne(
      { ...constraint, ...observedFence },
      {
        $set: {
          status: 'superseded',
          leaseExpiresAt: null,
          dispatchPermitId: '',
          dispatchPermitGeneration: 0,
          dispatchPermitExpiresAt: null,
          workerCompletionEffectLeases: [],
          lastError: 'glasshive_callback_delivery_superseded',
        },
      },
    );
  }

  async function existingPermitIsCurrent(
    row: GlassHiveCallbackDeliveryDispatchRow,
    now: Date,
  ): Promise<boolean> {
    const leases = dispatchPermitLeases(row);
    const expiresAt = row.dispatchPermitExpiresAt ? new Date(row.dispatchPermitExpiresAt) : null;
    if (leases.length === 0 || !expiresAt || expiresAt <= now) return false;
    const current = await Promise.all(
      leases.map((lease) =>
        resultExists({
          _id: lease.resultKey,
          acceptedOperationId: lease.acceptedOperationId,
          acceptedOperationGeneration: lease.acceptedOperationGeneration,
          callbackId: lease.callbackId,
          resultRevision: lease.resultRevision,
          resultDigest: lease.resultDigest,
          effectLeaseId: lease.leaseId,
          effectLeaseGeneration: lease.generation,
          effectLeaseExpiresAt: { $gt: now },
        }),
      ),
    );
    return current.every(Boolean);
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
    const initialWorkerReferences = workerCompletionReferences(initial);
    if (!reference || (initialWorkerReferences !== null && initialWorkerReferences.length === 0)) {
      return null;
    }

    try {
      return await runTransaction(async (session) => {
        const current = await DeliveryModel.findOne(constraint).session(session).lean();
        if (!current) throw new Error('glasshive_callback_delivery_claim_missing');
        const currentReference = terminalCallbackReference(current);
        if (!currentReference) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        const currentWorkerReferences = workerCompletionReferences(current);
        if (currentWorkerReferences !== null && currentWorkerReferences.length === 0) {
          throw new Error('glasshive_callback_delivery_dispatch_fenced');
        }
        const references = currentWorkerReferences || [currentReference];
        const leases: GlassHiveTerminalCallbackEffectLease[] = [];
        for (const currentReferenceItem of references) {
          const lease = await acquireEffectLease({
            reference: currentReferenceItem,
            now,
            leaseDurationMs: durationMs,
            session,
          });
          if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
          leases.push(lease);
        }
        const representativeLease = leases[0];
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
              dispatchPermitId: representativeLease.leaseId,
              dispatchPermitGeneration: representativeLease.generation,
              dispatchPermitExpiresAt: expiresAt,
              ...(currentWorkerReferences !== null ? { workerCompletionEffectLeases: leases } : {}),
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
      const references = initialWorkerReferences || [reference];
      const currentReferences = await Promise.all(
        references.map((currentReference) =>
          resultExists({
            _id: currentReference.resultKey,
            acceptedOperationId: currentReference.acceptedOperationId,
            acceptedOperationGeneration: currentReference.generation,
            callbackId: currentReference.callbackId,
            resultRevision: currentReference.resultRevision,
            resultDigest: currentReference.resultDigest,
          }),
        ),
      );
      const stillCurrent = currentReferences.every(Boolean);
      if (!stillCurrent) {
        await markSuperseded(constraint, initial);
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
        const leases = dispatchPermitLeases(current);
        if (leases.length === 0) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        for (const lease of leases) {
          const renewed = await renewEffectLease({
            lease,
            now,
            leaseDurationMs: durationMs,
            session,
          });
          if (!renewed) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        }
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
        const leases = dispatchPermitLeases(current);
        if (leases.length === 0) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        for (const lease of leases) {
          const released = await releaseEffectLease({ lease, session });
          if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        }
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
              workerCompletionEffectLeases: [],
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
    if (workerCompletionReferences(initial) !== null) return { handled: true, row: null };
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
      await markSuperseded(constraint, initial);
      return { handled: true, row: null };
    }
  }

  async function settleGlassHiveCallbackDeliveryUnknown(
    input: SettleGlassHiveCallbackDeliveryUnknownInput,
  ): Promise<GlassHiveCallbackDeliverySentSettlement> {
    const now = new Date();
    const constraint = constraintFilter(input);
    const initial = await DeliveryModel.findOne(constraint).lean();
    if (!initial || !terminalCallbackReference(initial)) return { handled: false };
    if (workerCompletionReferences(initial) !== null) return { handled: true, row: null };
    const dispatchPermit = input.dispatchPermit;
    if (!dispatchPermit || !permitMatches(initial, dispatchPermit)) {
      return { handled: true, row: null };
    }
    const expiresAt = initial.dispatchPermitExpiresAt
      ? new Date(initial.dispatchPermitExpiresAt)
      : null;
    if (!expiresAt || expiresAt <= now) return { handled: true, row: null };

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
              status: 'delivery_unknown',
              unknownAt: now,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: sanitizeDeliveryError(input.lastError),
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
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
      if (
        error instanceof Error &&
        error.message === 'glasshive_callback_delivery_dispatch_fenced'
      ) {
        await markSuperseded(constraint, initial);
      }
      return { handled: true, row: null };
    }
  }

  return {
    authorizeGlassHiveCallbackDeliveryDispatch,
    renewGlassHiveCallbackDeliveryDispatch,
    releaseGlassHiveCallbackDeliveryDispatch,
    settleGlassHiveCallbackDeliverySent,
    settleGlassHiveCallbackDeliveryUnknown,
  };
}

/* === VIVENTIUM END === */
