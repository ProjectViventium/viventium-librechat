/* === VIVENTIUM START ===
 * Feature: MPV-061 strict Voice classifier fallback control.
 * Purpose: Keep a local PRE-GATE fault behind an exact synthetic, candidate-bound, one-time
 * parent approval. This module never selects a provider, model, prompt, or user.
 * === VIVENTIUM END === */

import { createHash, createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'crypto';

export type VoiceClassifierFaultControlState =
  'armed' | 'challenged' | 'approved' | 'consumed' | 'cleared' | 'expired';

export interface VoiceClassifierRouteIdentity {
  provider: string;
  model: string;
}

export interface VoiceClassifierSegmentIdentity {
  segmentId: string;
  revision: number;
}

export interface VoiceClassifierFaultArmBinding {
  caseId: 'MPV-061';
  sessionRef: string;
  candidateDigest: string;
  componentArtifactDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
  ownerId: string;
  callSessionId: string;
  primary: VoiceClassifierRouteIdentity;
  fallback: VoiceClassifierRouteIdentity;
}

export interface VoiceClassifierFaultTurnBinding extends VoiceClassifierFaultArmBinding {
  turnId: string;
  segments: VoiceClassifierSegmentIdentity[];
  utteranceHash: string;
}

export interface VoiceClassifierFaultControlRow {
  schemaVersion: 1;
  controlId: string;
  caseId: 'MPV-061';
  sessionRefHash: string;
  sessionCandidateDigest: string;
  caseTokenHash: string;
  candidateDigest: string;
  componentArtifactDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
  ownerScopeHash: string;
  callScopeHash: string;
  utteranceHash?: string;
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  armBindingHash: string;
  syntheticScope: true;
  state: VoiceClassifierFaultControlState;
  armedAt: string;
  expiresAt: string;
  purgeAt: string;
  challengeId?: string;
  challengeIssuedAt?: string;
  challengeExpiresAt?: string;
  replayExpiresAt?: string;
  turnId?: string;
  segments?: VoiceClassifierSegmentIdentity[];
  turnScopeHash?: string;
  segmentSetHash?: string;
  turnBindingHash?: string;
  coreProof?: string;
  approvedAt?: string;
  approvalProof?: string;
  consumedAt?: string;
  receiptExpiresAt?: string;
  receiptDigest?: string;
  clearedAt?: string;
}

export interface VoiceClassifierFaultControlStore {
  insert(row: VoiceClassifierFaultControlRow): Promise<VoiceClassifierFaultControlRow>;
  findByArmBinding(armBindingHash: string): Promise<VoiceClassifierFaultControlRow | null>;
  findByControlId(controlId: string): Promise<VoiceClassifierFaultControlRow | null>;
  challenge(input: {
    controlId: string;
    armBindingHash: string;
    expectedExpiresAt: string;
    issuedAt: string;
    challenge: Pick<
      VoiceClassifierFaultControlRow,
      | 'challengeId'
      | 'challengeIssuedAt'
      | 'challengeExpiresAt'
      | 'replayExpiresAt'
      | 'turnId'
      | 'segments'
      | 'turnScopeHash'
      | 'segmentSetHash'
      | 'turnBindingHash'
      | 'utteranceHash'
      | 'coreProof'
    >;
  }): Promise<VoiceClassifierFaultControlRow | null>;
  approve(input: {
    controlId: string;
    challengeId: string;
    expectedChallengeExpiresAt: string;
    checkedAt: string;
    approvedAt: string;
    approvalProof: string;
  }): Promise<VoiceClassifierFaultControlRow | null>;
  consume(input: {
    controlId: string;
    challengeId: string;
    expectedChallengeExpiresAt: string;
    checkedAt: string;
    consumedAt: string;
    receiptExpiresAt: string;
    receiptDigest: string;
  }): Promise<VoiceClassifierFaultControlRow | null>;
  clear(input: { armBindingHash: string; clearedAt: string }): Promise<number>;
  removeConsumed(input: { controlId: string; receiptDigest: string }): Promise<number>;
}

export interface VoiceClassifierFaultChallenge {
  active: true;
  controlId: string;
  challengeId: string;
  challengeExpiresAt: string;
  approvalPayload: string;
}

export type VoiceClassifierFaultChallengeResult = VoiceClassifierFaultChallenge | { active: false };

export interface VoiceClassifierFaultConsumedReceipt {
  consumed: true;
  controlId: string;
  challengeId: string;
  receiptDigest: string;
  receiptExpiresAt: string;
  failure: 'provider_temporarily_unavailable';
  preModel: true;
}

export interface VoiceClassifierFaultControlManager {
  arm(input: VoiceClassifierFaultArmBinding): Promise<{
    controlId: string;
    state: 'armed';
    expiresAt: string;
  }>;
  issueChallenge(
    input: VoiceClassifierFaultTurnBinding,
  ): Promise<VoiceClassifierFaultChallengeResult>;
  approve(input: {
    controlId: string;
    challengeId: string;
    binding: VoiceClassifierFaultTurnBinding;
    approvalProof: string;
  }): Promise<{ approved: true; controlId: string; challengeId: string }>;
  consume(input: {
    controlId: string;
    challengeId: string;
    binding: VoiceClassifierFaultTurnBinding;
  }): Promise<VoiceClassifierFaultConsumedReceipt>;
  run(
    input: VoiceClassifierFaultTurnBinding,
  ): Promise<VoiceClassifierFaultConsumedReceipt | { active: false }>;
  clear(input: VoiceClassifierFaultArmBinding): Promise<{ cleared: number }>;
  cleanup(input: { controlId: string; receiptDigest: string }): Promise<{ removed: number }>;
}

export interface VoiceClassifierFaultControlManagerOptions {
  store: VoiceClassifierFaultControlStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  coreSigningKey?: Buffer;
  verifySyntheticOwner: (input: { ownerId: string; callSessionId: string }) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  approvalWaitMs?: number;
  pollIntervalMs?: number;
}

interface VoiceClassifierFaultDocument {
  toObject(): VoiceClassifierFaultControlRow & { [key: string]: object };
}

export interface VoiceClassifierFaultMongooseModel {
  create(input: object): PromiseLike<VoiceClassifierFaultDocument>;
  findOne(filter: object): { lean(): PromiseLike<VoiceClassifierFaultControlRow | null> };
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { new: true; runValidators: true },
  ): PromiseLike<VoiceClassifierFaultDocument | null>;
  deleteOne(filter: object): PromiseLike<{ deletedCount?: number }>;
}

const CASE_ID = 'MPV-061';
const MODE = 'mpv_061';
const HASH = /^sha256:[a-f0-9]{64}$/;
const SESSION_REF = /^qa_[a-f0-9]{24}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_ID = /^mpv061_[A-Za-z0-9_-]{22,80}$/;
const CHALLENGE_ID = /^mpv061_ch_[A-Za-z0-9_-]{22,80}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const MAX_TEXT = 256;
const ARM_TTL_MS = 60_000;
const CHALLENGE_TTL_MS = 5_000;
const MAX_APPROVAL_WAIT_MS = 750;
const DEFAULT_POLL_INTERVAL_MS = 25;
const REPLAY_TTL_MS = 60_000;
const RECEIPT_TTL_MS = 15 * 60_000;
const PURGE_TTL_MS = 24 * 60 * 60_000;

function controlError(code: string, status = 503): Error {
  return Object.assign(new Error(code), { code, status, retryable: status === 503 });
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalJson(value: object): string {
  const render = (item: object | string | number | boolean | null): string => {
    if (Array.isArray(item)) return `[${item.map((value) => render(value)).join(',')}]`;
    if (item && typeof item === 'object') {
      const record = item as { [key: string]: object | string | number | boolean | null };
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${render(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return render(value);
}

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!PROOF.test(left) || !PROOF.test(right)) return false;
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalTimestamp(value: Date): string {
  return value.toISOString();
}

function boundedText(value: string): string {
  const normalized = String(value || '')
    .normalize('NFKC')
    .trim();
  if (!normalized || normalized.length > MAX_TEXT || normalized.includes('\0')) {
    throw controlError('voice_classifier_qa_binding_invalid', 400);
  }
  return normalized;
}

function exactRoute(value: VoiceClassifierRouteIdentity): VoiceClassifierRouteIdentity {
  return Object.freeze({
    provider: boundedText(value?.provider),
    model: boundedText(value?.model),
  });
}

function exactSegments(values: VoiceClassifierSegmentIdentity[]): VoiceClassifierSegmentIdentity[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
    throw controlError('voice_classifier_qa_binding_invalid', 400);
  }
  const segments = values.map((value) => ({
    segmentId: boundedText(value?.segmentId),
    revision: Number(value?.revision),
  }));
  if (
    segments.some((segment) => !Number.isSafeInteger(segment.revision) || segment.revision < 1) ||
    new Set(segments.map((segment) => segment.segmentId)).size !== segments.length
  ) {
    throw controlError('voice_classifier_qa_binding_invalid', 400);
  }
  return segments;
}

function exactHash(value: string): string {
  const normalized = String(value || '').trim();
  if (!HASH.test(normalized)) throw controlError('voice_classifier_qa_binding_invalid', 400);
  return normalized;
}

function tokenBytes(token: string): Buffer {
  if (!TOKEN.test(token)) throw controlError('voice_classifier_qa_authority_invalid');
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== token) {
    throw controlError('voice_classifier_qa_authority_invalid');
  }
  return decoded;
}

interface Authority {
  sessionRef: string;
  sessionRefHash: string;
  sessionCandidateDigest: string;
  caseTokenHash: string;
  caseToken: Buffer;
  componentArtifactDigest: string;
}

function authority(env: NodeJS.ProcessEnv): Authority | null {
  if (
    String(env.VIVENTIUM_LOCAL_QA_CASE_ID || '').trim() !== CASE_ID ||
    String(env.VIVENTIUM_LOCAL_QA_MODE || '').trim() !== MODE
  ) {
    return null;
  }
  const sessionRef = String(env.VIVENTIUM_LOCAL_QA_SESSION_REF || '').trim();
  const token = String(env.VIVENTIUM_LOCAL_QA_CASE_TOKEN || '').trim();
  const componentArtifactDigest = String(
    env.VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST || '',
  ).trim();
  const sessionCandidateDigest = String(env.VIVENTIUM_LOCAL_QA_CANDIDATE_DIGEST || '').trim();
  if (
    !SESSION_REF.test(sessionRef) ||
    !HASH.test(componentArtifactDigest) ||
    !HASH.test(sessionCandidateDigest)
  ) {
    throw controlError('voice_classifier_qa_authority_invalid');
  }
  const decodedToken = tokenBytes(token);
  return {
    sessionRef,
    sessionRefHash: sha256(`session\0${sessionRef}`),
    sessionCandidateDigest,
    caseTokenHash: sha256(`case-token\0${token}`),
    caseToken: decodedToken,
    componentArtifactDigest,
  };
}

interface ExactArmBinding {
  sessionRef: string;
  candidateDigest: string;
  componentArtifactDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
  ownerId: string;
  callSessionId: string;
  primary: VoiceClassifierRouteIdentity;
  fallback: VoiceClassifierRouteIdentity;
}

function normalizeArmBinding(
  input: VoiceClassifierFaultArmBinding,
  currentAuthority: Authority,
): ExactArmBinding {
  if (input?.caseId !== CASE_ID || input.sessionRef !== currentAuthority.sessionRef) {
    throw controlError('voice_classifier_qa_binding_invalid', 400);
  }
  const binding = {
    sessionRef: boundedText(input.sessionRef),
    candidateDigest: exactHash(input.candidateDigest),
    componentArtifactDigest: exactHash(input.componentArtifactDigest),
    installedArtifactDigest: exactHash(input.installedArtifactDigest),
    runtimeOwnerBindingHash: exactHash(input.runtimeOwnerBindingHash),
    ownerId: boundedText(input.ownerId),
    callSessionId: boundedText(input.callSessionId),
    primary: exactRoute(input.primary),
    fallback: exactRoute(input.fallback),
  };
  if (binding.componentArtifactDigest !== currentAuthority.componentArtifactDigest) {
    throw controlError('voice_classifier_qa_binding_mismatch', 409);
  }
  if (binding.candidateDigest !== currentAuthority.sessionCandidateDigest) {
    throw controlError('voice_classifier_qa_binding_mismatch', 409);
  }
  if (
    binding.primary.provider === binding.fallback.provider &&
    binding.primary.model === binding.fallback.model
  ) {
    throw controlError('voice_classifier_qa_fallback_invalid', 400);
  }
  return binding;
}

function armIdentity(binding: ExactArmBinding, currentAuthority: Authority) {
  const identity = {
    schemaVersion: 1,
    caseId: CASE_ID,
    sessionRefHash: currentAuthority.sessionRefHash,
    sessionCandidateDigest: currentAuthority.sessionCandidateDigest,
    caseTokenHash: currentAuthority.caseTokenHash,
    candidateDigest: binding.candidateDigest,
    componentArtifactDigest: binding.componentArtifactDigest,
    installedArtifactDigest: binding.installedArtifactDigest,
    runtimeOwnerBindingHash: binding.runtimeOwnerBindingHash,
    ownerScopeHash: sha256(`owner\0${binding.ownerId}`),
    callScopeHash: sha256(`call\0${binding.callSessionId}`),
    primaryProvider: binding.primary.provider,
    primaryModel: binding.primary.model,
    fallbackProvider: binding.fallback.provider,
    fallbackModel: binding.fallback.model,
  } as const;
  return { ...identity, armBindingHash: sha256(canonicalJson(identity)) };
}

function turnIdentity(input: VoiceClassifierFaultTurnBinding, currentAuthority: Authority) {
  const arm = normalizeArmBinding(input, currentAuthority);
  const armFields = armIdentity(arm, currentAuthority);
  const segments = exactSegments(input.segments);
  const utteranceHash = exactHash(input.utteranceHash);
  const turnId = boundedText(input.turnId);
  const turn = {
    armBindingHash: armFields.armBindingHash,
    turnScopeHash: sha256(`turn\0${turnId}`),
    segmentSetHash: sha256(canonicalJson(segments)),
    utteranceHash,
  } as const;
  return {
    arm,
    armFields,
    turnId,
    segments,
    ...turn,
    turnBindingHash: sha256(canonicalJson(turn)),
  };
}

function challengeUnsigned(row: VoiceClassifierFaultControlRow) {
  return {
    schemaVersion: 1,
    caseId: CASE_ID,
    controlId: row.controlId,
    challengeId: row.challengeId as string,
    challengeIssuedAt: row.challengeIssuedAt as string,
    challengeExpiresAt: row.challengeExpiresAt as string,
    replayExpiresAt: row.replayExpiresAt as string,
    sessionRefHash: row.sessionRefHash,
    sessionCandidateDigest: row.sessionCandidateDigest,
    candidateDigest: row.candidateDigest,
    componentArtifactDigest: row.componentArtifactDigest,
    installedArtifactDigest: row.installedArtifactDigest,
    runtimeOwnerBindingHash: row.runtimeOwnerBindingHash,
    ownerScopeHash: row.ownerScopeHash,
    callScopeHash: row.callScopeHash,
    turnId: row.turnId as string,
    segments: row.segments as VoiceClassifierSegmentIdentity[],
    turnScopeHash: row.turnScopeHash as string,
    segmentSetHash: row.segmentSetHash as string,
    utteranceHash: row.utteranceHash as string,
    primaryProvider: row.primaryProvider,
    primaryModel: row.primaryModel,
    fallbackProvider: row.fallbackProvider,
    fallbackModel: row.fallbackModel,
  };
}

export function voiceClassifierFaultApprovalPayload(row: VoiceClassifierFaultControlRow): string {
  return canonicalJson({ ...challengeUnsigned(row), coreProof: row.coreProof as string });
}

function exactTurnMatches(
  row: VoiceClassifierFaultControlRow,
  identity: ReturnType<typeof turnIdentity>,
): boolean {
  return (
    row.armBindingHash === identity.armBindingHash &&
    row.turnScopeHash === identity.turnScopeHash &&
    row.segmentSetHash === identity.segmentSetHash &&
    row.turnBindingHash === identity.turnBindingHash &&
    row.utteranceHash === identity.utteranceHash &&
    row.turnId === identity.turnId &&
    canonicalJson(row.segments || []) === canonicalJson(identity.segments)
  );
}

function receiptDigest(row: VoiceClassifierFaultControlRow, consumedAt: string): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      caseId: CASE_ID,
      controlId: row.controlId,
      challengeId: row.challengeId as string,
      armBindingHash: row.armBindingHash,
      turnBindingHash: row.turnBindingHash as string,
      consumedAt,
      failure: 'provider_temporarily_unavailable',
      preModel: true,
    }),
  );
}

function duplicate(error: object): boolean {
  return Number((error as { code?: number }).code) === 11000;
}

function boundedTiming(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw controlError('voice_classifier_qa_timing_invalid', 400);
  }
  return selected;
}

function rowFromMongo(value: VoiceClassifierFaultDocument | VoiceClassifierFaultControlRow | null) {
  if (!value) return null;
  const source =
    typeof (value as VoiceClassifierFaultDocument).toObject === 'function'
      ? (value as VoiceClassifierFaultDocument).toObject()
      : (value as VoiceClassifierFaultControlRow);
  const result = { ...source } as VoiceClassifierFaultControlRow & {
    [key: string]: object | string | number | boolean | undefined;
  };
  for (const key of [
    'armedAt',
    'expiresAt',
    'purgeAt',
    'challengeIssuedAt',
    'challengeExpiresAt',
    'replayExpiresAt',
    'approvedAt',
    'consumedAt',
    'receiptExpiresAt',
    'clearedAt',
  ]) {
    const selected = result[key];
    if (selected instanceof Date) result[key] = selected.toISOString();
  }
  return result as VoiceClassifierFaultControlRow;
}

export function createMongooseVoiceClassifierFaultControlStore(
  model: VoiceClassifierFaultMongooseModel,
): VoiceClassifierFaultControlStore {
  const update = async (filter: object, values: object) =>
    rowFromMongo(
      await model.findOneAndUpdate(filter, { $set: values }, { new: true, runValidators: true }),
    );
  const mongooseStore: VoiceClassifierFaultControlStore = {
    async insert(row) {
      return rowFromMongo(
        await model.create({
          ...row,
          armedAt: new Date(row.armedAt),
          expiresAt: new Date(row.expiresAt),
          purgeAt: new Date(row.purgeAt),
        }),
      ) as VoiceClassifierFaultControlRow;
    },
    async findByArmBinding(armBindingHash) {
      return rowFromMongo(await model.findOne({ armBindingHash }).lean());
    },
    async findByControlId(controlId) {
      return rowFromMongo(await model.findOne({ controlId }).lean());
    },
    challenge(input) {
      return update(
        {
          controlId: input.controlId,
          armBindingHash: input.armBindingHash,
          state: 'armed',
          expiresAt: {
            $eq: new Date(input.expectedExpiresAt),
            $gt: new Date(input.issuedAt),
          },
        },
        {
          state: 'challenged',
          ...input.challenge,
          challengeIssuedAt: new Date(input.challenge.challengeIssuedAt as string),
          challengeExpiresAt: new Date(input.challenge.challengeExpiresAt as string),
          replayExpiresAt: new Date(input.challenge.replayExpiresAt as string),
        },
      );
    },
    approve(input) {
      return update(
        {
          controlId: input.controlId,
          challengeId: input.challengeId,
          state: 'challenged',
          challengeExpiresAt: {
            $eq: new Date(input.expectedChallengeExpiresAt),
            $gt: new Date(input.checkedAt),
          },
        },
        {
          state: 'approved',
          approvedAt: new Date(input.approvedAt),
          approvalProof: input.approvalProof,
        },
      );
    },
    consume(input) {
      return update(
        {
          controlId: input.controlId,
          challengeId: input.challengeId,
          state: 'approved',
          challengeExpiresAt: {
            $eq: new Date(input.expectedChallengeExpiresAt),
            $gt: new Date(input.checkedAt),
          },
        },
        {
          state: 'consumed',
          consumedAt: new Date(input.consumedAt),
          receiptExpiresAt: new Date(input.receiptExpiresAt),
          receiptDigest: input.receiptDigest,
        },
      );
    },
    async clear(input) {
      const row = await update(
        {
          armBindingHash: input.armBindingHash,
          state: { $in: ['armed', 'challenged', 'approved'] },
        },
        { state: 'cleared', clearedAt: new Date(input.clearedAt) },
      );
      return row ? 1 : 0;
    },
    async removeConsumed(input) {
      const result = await model.deleteOne({
        controlId: input.controlId,
        state: 'consumed',
        receiptDigest: input.receiptDigest,
      });
      return Number(result.deletedCount || 0);
    },
  };
  return Object.freeze(mongooseStore);
}

export function createVoiceClassifierFaultControlManager({
  store,
  env = process.env,
  now = () => new Date(),
  randomBytes = cryptoRandomBytes,
  coreSigningKey = cryptoRandomBytes(32),
  verifySyntheticOwner,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  approvalWaitMs: configuredApprovalWaitMs,
  pollIntervalMs: configuredPollIntervalMs,
}: VoiceClassifierFaultControlManagerOptions): VoiceClassifierFaultControlManager {
  if (!Buffer.isBuffer(coreSigningKey) || coreSigningKey.length !== 32) {
    throw controlError('voice_classifier_qa_core_key_invalid');
  }
  const approvalWaitMs = boundedTiming(
    configuredApprovalWaitMs,
    MAX_APPROVAL_WAIT_MS,
    MAX_APPROVAL_WAIT_MS,
  );
  const pollIntervalMs = boundedTiming(configuredPollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 100);

  const currentAuthority = (): Authority | null => authority(env);

  const safeStore = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try {
      return await operation();
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      if (Number(code) === 11000) throw error;
      if (typeof code === 'string' && code.startsWith('voice_classifier_qa_')) throw error;
      throw controlError('voice_classifier_qa_store_unavailable');
    }
  };

  const loadChallenge = async (controlId: string, challengeId: string) => {
    const row = await safeStore(() => store.findByControlId(controlId));
    if (!row || row.challengeId !== challengeId) {
      throw controlError('voice_classifier_qa_control_unavailable');
    }
    const expectedCoreProof = hmac(coreSigningKey, canonicalJson(challengeUnsigned(row)));
    if (!constantTimeEqual(String(row.coreProof || ''), expectedCoreProof)) {
      throw controlError('voice_classifier_qa_restart_challenge_invalid');
    }
    return row;
  };

  const control: VoiceClassifierFaultControlManager = {
    async arm(input) {
      const active = currentAuthority();
      if (!active) throw controlError('voice_classifier_qa_controls_disabled');
      const normalized = normalizeArmBinding(input, active);
      if (
        (await verifySyntheticOwner({
          ownerId: normalized.ownerId,
          callSessionId: normalized.callSessionId,
        })) !== true
      ) {
        throw controlError('voice_classifier_qa_synthetic_owner_unverified', 403);
      }
      const identity = armIdentity(normalized, active);
      const armedAt = now();
      const expiresAt = new Date(armedAt.getTime() + ARM_TTL_MS);
      const controlId = `mpv061_${randomBytes(18).toString('base64url')}`;
      if (!CONTROL_ID.test(controlId)) throw controlError('voice_classifier_qa_random_invalid');
      const row: VoiceClassifierFaultControlRow = {
        ...identity,
        controlId,
        syntheticScope: true,
        state: 'armed',
        armedAt: canonicalTimestamp(armedAt),
        expiresAt: canonicalTimestamp(expiresAt),
        purgeAt: canonicalTimestamp(new Date(armedAt.getTime() + PURGE_TTL_MS)),
      };
      try {
        const persisted = await safeStore(() => store.insert(row));
        return {
          controlId: persisted.controlId,
          state: 'armed' as const,
          expiresAt: persisted.expiresAt,
        };
      } catch (error) {
        if (!duplicate(error as object)) throw error;
        throw controlError('voice_classifier_qa_control_already_armed', 409);
      }
    },

    async issueChallenge(input) {
      const active = currentAuthority();
      if (!active) return { active: false };
      const identity = turnIdentity(input, active);
      const existing = await safeStore(() => store.findByArmBinding(identity.armBindingHash));
      if (!existing) return { active: false };
      if (existing.state === 'consumed') {
        throw controlError('voice_classifier_qa_control_replayed', 409);
      }
      if (existing.state !== 'armed') {
        throw controlError('voice_classifier_qa_control_unavailable');
      }
      const issuedAt = now();
      if (issuedAt.getTime() >= new Date(existing.expiresAt).getTime()) {
        throw controlError('voice_classifier_qa_control_expired');
      }
      const challengeId = `mpv061_ch_${randomBytes(18).toString('base64url')}`;
      if (!CHALLENGE_ID.test(challengeId)) {
        throw controlError('voice_classifier_qa_random_invalid');
      }
      const challenge = {
        challengeId,
        challengeIssuedAt: canonicalTimestamp(issuedAt),
        challengeExpiresAt: canonicalTimestamp(new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)),
        replayExpiresAt: canonicalTimestamp(new Date(issuedAt.getTime() + REPLAY_TTL_MS)),
        turnId: identity.turnId,
        segments: identity.segments,
        turnScopeHash: identity.turnScopeHash,
        segmentSetHash: identity.segmentSetHash,
        turnBindingHash: identity.turnBindingHash,
        utteranceHash: identity.utteranceHash,
        coreProof: '',
      };
      const unsignedRow = { ...existing, ...challenge };
      challenge.coreProof = hmac(coreSigningKey, canonicalJson(challengeUnsigned(unsignedRow)));
      const row = await safeStore(() =>
        store.challenge({
          controlId: existing.controlId,
          armBindingHash: existing.armBindingHash,
          expectedExpiresAt: existing.expiresAt,
          issuedAt: canonicalTimestamp(issuedAt),
          challenge,
        }),
      );
      if (!row) throw controlError('voice_classifier_qa_control_raced', 409);
      return {
        active: true,
        controlId: row.controlId,
        challengeId,
        challengeExpiresAt: challenge.challengeExpiresAt,
        approvalPayload: voiceClassifierFaultApprovalPayload(row),
      };
    },

    async approve({ controlId, challengeId, binding, approvalProof: suppliedProof }) {
      const active = currentAuthority();
      if (!active) throw controlError('voice_classifier_qa_controls_disabled');
      const identity = turnIdentity(binding, active);
      const row = await safeStore(() => store.findByControlId(controlId));
      if (!row || row.challengeId !== challengeId || !exactTurnMatches(row, identity)) {
        throw controlError('voice_classifier_qa_binding_mismatch', 409);
      }
      if (row.state !== 'challenged') {
        throw controlError('voice_classifier_qa_control_replayed', 409);
      }
      const checkedAt = now();
      if (checkedAt.getTime() >= new Date(String(row.challengeExpiresAt || '')).getTime()) {
        throw controlError('voice_classifier_qa_challenge_expired');
      }
      const expectedProof = hmac(active.caseToken, voiceClassifierFaultApprovalPayload(row));
      if (!constantTimeEqual(suppliedProof, expectedProof)) {
        throw controlError('voice_classifier_qa_parent_proof_invalid', 403);
      }
      const approved = await safeStore(() =>
        store.approve({
          controlId,
          challengeId,
          expectedChallengeExpiresAt: row.challengeExpiresAt as string,
          checkedAt: canonicalTimestamp(checkedAt),
          approvedAt: canonicalTimestamp(checkedAt),
          approvalProof: suppliedProof,
        }),
      );
      if (!approved) throw controlError('voice_classifier_qa_control_raced', 409);
      return { approved: true, controlId, challengeId };
    },

    async consume({ controlId, challengeId, binding }) {
      const active = currentAuthority();
      if (!active) throw controlError('voice_classifier_qa_controls_disabled');
      const identity = turnIdentity(binding, active);
      const row = await loadChallenge(controlId, challengeId);
      if (!exactTurnMatches(row, identity)) {
        throw controlError('voice_classifier_qa_binding_mismatch', 409);
      }
      if (row.state === 'consumed') {
        throw controlError('voice_classifier_qa_control_replayed', 409);
      }
      if (row.state !== 'approved' || !row.approvalProof) {
        throw controlError('voice_classifier_qa_parent_unavailable');
      }
      const consumedAt = now();
      if (consumedAt.getTime() >= new Date(String(row.challengeExpiresAt || '')).getTime()) {
        throw controlError('voice_classifier_qa_challenge_expired');
      }
      const expectedApproval = hmac(active.caseToken, voiceClassifierFaultApprovalPayload(row));
      if (!constantTimeEqual(row.approvalProof, expectedApproval)) {
        throw controlError('voice_classifier_qa_parent_proof_invalid', 403);
      }
      const renderedConsumedAt = canonicalTimestamp(consumedAt);
      const renderedReceiptExpiry = canonicalTimestamp(
        new Date(consumedAt.getTime() + RECEIPT_TTL_MS),
      );
      const digest = receiptDigest(row, renderedConsumedAt);
      const consumed = await safeStore(() =>
        store.consume({
          controlId,
          challengeId,
          expectedChallengeExpiresAt: row.challengeExpiresAt as string,
          checkedAt: renderedConsumedAt,
          consumedAt: renderedConsumedAt,
          receiptExpiresAt: renderedReceiptExpiry,
          receiptDigest: digest,
        }),
      );
      if (!consumed) throw controlError('voice_classifier_qa_control_replayed', 409);
      return {
        consumed: true,
        controlId,
        challengeId,
        receiptDigest: digest,
        receiptExpiresAt: renderedReceiptExpiry,
        failure: 'provider_temporarily_unavailable',
        preModel: true,
      };
    },

    async run(input) {
      const challenge = await this.issueChallenge(input);
      if (!challenge.active) return challenge;
      const deadline = Date.now() + approvalWaitMs;
      do {
        const row = await safeStore(() => store.findByControlId(challenge.controlId));
        if (row?.state === 'approved') {
          return this.consume({
            controlId: challenge.controlId,
            challengeId: challenge.challengeId,
            binding: input,
          });
        }
        if (row?.state === 'consumed') {
          throw controlError('voice_classifier_qa_control_replayed', 409);
        }
        if (!row || ['cleared', 'expired'].includes(row.state)) {
          throw controlError('voice_classifier_qa_control_unavailable');
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw controlError('voice_classifier_qa_parent_unavailable');
    },

    async clear(input) {
      const active = currentAuthority();
      if (!active) throw controlError('voice_classifier_qa_controls_disabled');
      const normalized = normalizeArmBinding(input, active);
      const identity = armIdentity(normalized, active);
      return {
        cleared: await safeStore(() =>
          store.clear({
            armBindingHash: identity.armBindingHash,
            clearedAt: canonicalTimestamp(now()),
          }),
        ),
      };
    },

    async cleanup(input) {
      if (!CONTROL_ID.test(input.controlId) || !HASH.test(input.receiptDigest)) {
        throw controlError('voice_classifier_qa_cleanup_invalid', 400);
      }
      return {
        removed: await safeStore(() =>
          store.removeConsumed({
            controlId: input.controlId,
            receiptDigest: input.receiptDigest,
          }),
        ),
      };
    },
  };
  return Object.freeze(control);
}

export const VOICE_CLASSIFIER_FAULT_TIMING = Object.freeze({
  armTtlMs: ARM_TTL_MS,
  challengeTtlMs: CHALLENGE_TTL_MS,
  approvalWaitMs: MAX_APPROVAL_WAIT_MS,
  replayNonceTtlMs: REPLAY_TTL_MS,
  receiptTtlMs: RECEIPT_TTL_MS,
  purgeTtlMs: PURGE_TTL_MS,
});
