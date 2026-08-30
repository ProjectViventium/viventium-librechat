/* === VIVENTIUM START ===
 * Feature: Signed voice-engagement authority.
 * Purpose: Mint and verify a short-lived model verdict bound to one authenticated owner turn.
 * The gateway transport secret is a configuration gate, never the signing key.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';

const VOICE_ENGAGEMENT_ATTESTATION_TTL_MS = 30_000;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface VoiceEngagementAttestation {
  version: 1;
  callSessionId: string;
  turnId: string;
  participantIdentity: string;
  segmentIds: string[];
  directlyAddressed: boolean;
  source: 'semantic_model';
  revision: number;
  issuedAtMs: number;
  expiresAtMs: number;
  attestation: string;
}

export interface CreateVoiceEngagementAttestationInput {
  callSessionId?: unknown;
  turnId?: unknown;
  participantIdentity?: unknown;
  segmentIds?: unknown;
  directlyAddressed?: unknown;
  revision?: unknown;
  utterance?: unknown;
  nowMs?: unknown;
}

export interface VerifyVoiceEngagementAttestationOptions {
  nowMs?: unknown;
  utterance?: unknown;
}

export interface VoiceEngagementAttestationServiceOptions {
  getTransportSecret(): unknown;
  signingKey?: Uint8Array;
}

function voiceEngagementUtteranceDigest(utterance: unknown): string | null {
  const normalized = typeof utterance === 'string' ? utterance.trim() : '';
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('base64url');
}

function voiceEngagementSignedValues(
  value: Omit<VoiceEngagementAttestation, 'attestation'>,
  utteranceDigest: string,
): unknown[] {
  return [
    value.version,
    value.callSessionId,
    value.turnId,
    value.participantIdentity,
    value.segmentIds,
    value.directlyAddressed,
    value.source,
    value.revision,
    value.issuedAtMs,
    value.expiresAtMs,
    utteranceDigest,
  ];
}

function normalizeVoiceEngagementSegmentIds(segmentIds: unknown): string[] | null {
  if (!Array.isArray(segmentIds) || segmentIds.length < 1 || segmentIds.length > 32) return null;
  const normalized = segmentIds.map((value) => (typeof value === 'string' ? value.trim() : ''));
  if (
    normalized.some((value) => !value || value.length > 160) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
}

function recordFrom(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function trustedDecisionError(hasTransportSecret: boolean): Error & { status?: number } {
  return Object.assign(new Error('A complete trusted voice-engagement decision is required'), {
    status: hasTransportSecret ? 400 : 503,
  });
}

export function createVoiceEngagementAttestationService({
  getTransportSecret,
  signingKey,
}: VoiceEngagementAttestationServiceOptions) {
  if (typeof getTransportSecret !== 'function') {
    throw new TypeError('getTransportSecret is required');
  }
  const privateSigningKey = signingKey ? Buffer.from(signingKey) : crypto.randomBytes(32);
  if (privateSigningKey.length < 32) {
    throw new TypeError('voice engagement signing key must contain at least 32 bytes');
  }

  function hasTransportSecret(): boolean {
    return Boolean(String(getTransportSecret() || '').trim());
  }

  function createVoiceEngagementAttestation(
    input: CreateVoiceEngagementAttestationInput = {},
  ): VoiceEngagementAttestation {
    const transportConfigured = hasTransportSecret();
    const normalizedSegmentIds = normalizeVoiceEngagementSegmentIds(input.segmentIds);
    const utteranceDigest = voiceEngagementUtteranceDigest(input.utterance);
    const callSessionId = typeof input.callSessionId === 'string' ? input.callSessionId.trim() : '';
    const turnId = typeof input.turnId === 'string' ? input.turnId.trim() : '';
    const participantIdentity =
      typeof input.participantIdentity === 'string' ? input.participantIdentity.trim() : '';
    const nowMs = input.nowMs === undefined ? Date.now() : input.nowMs;
    if (
      !transportConfigured ||
      !callSessionId ||
      !turnId ||
      !participantIdentity ||
      !normalizedSegmentIds ||
      typeof input.directlyAddressed !== 'boolean' ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) <= 0 ||
      !utteranceDigest ||
      !Number.isSafeInteger(nowMs)
    ) {
      throw trustedDecisionError(transportConfigured);
    }
    const value: Omit<VoiceEngagementAttestation, 'attestation'> = {
      version: 1 as const,
      callSessionId,
      turnId,
      participantIdentity,
      segmentIds: normalizedSegmentIds,
      directlyAddressed: input.directlyAddressed,
      source: 'semantic_model',
      revision: Number(input.revision),
      issuedAtMs: Number(nowMs),
      expiresAtMs: Number(nowMs) + VOICE_ENGAGEMENT_ATTESTATION_TTL_MS,
    };
    return {
      ...value,
      attestation: crypto
        .createHmac('sha256', privateSigningKey)
        .update(JSON.stringify(voiceEngagementSignedValues(value, utteranceDigest)))
        .digest('base64url'),
    };
  }

  function verifyVoiceEngagementAttestation(
    candidate: unknown,
    options: VerifyVoiceEngagementAttestationOptions = {},
  ): boolean {
    const value = recordFrom(candidate);
    const candidateSegmentIds = Array.isArray(value.segmentIds) ? value.segmentIds : null;
    const normalizedSegmentIds = normalizeVoiceEngagementSegmentIds(candidateSegmentIds);
    const utteranceDigest = voiceEngagementUtteranceDigest(options.utterance);
    const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
    if (
      !hasTransportSecret() ||
      !utteranceDigest ||
      value.version !== 1 ||
      typeof value.callSessionId !== 'string' ||
      !value.callSessionId ||
      typeof value.turnId !== 'string' ||
      !value.turnId ||
      typeof value.participantIdentity !== 'string' ||
      !value.participantIdentity ||
      !candidateSegmentIds ||
      !normalizedSegmentIds ||
      normalizedSegmentIds.some(
        (segmentId, index) => segmentId !== candidateSegmentIds[index],
      ) ||
      typeof value.directlyAddressed !== 'boolean' ||
      value.source !== 'semantic_model' ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) <= 0 ||
      !Number.isSafeInteger(value.issuedAtMs) ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      Number(value.expiresAtMs) <= Number(value.issuedAtMs) ||
      Number(value.expiresAtMs) - Number(value.issuedAtMs) > VOICE_ENGAGEMENT_ATTESTATION_TTL_MS ||
      !Number.isSafeInteger(nowMs) ||
      Number(nowMs) < Number(value.issuedAtMs) - 5_000 ||
      Number(nowMs) >= Number(value.expiresAtMs) ||
      typeof value.attestation !== 'string' ||
      !BASE64URL_SHA256_PATTERN.test(value.attestation)
    ) {
      return false;
    }
    const signedValue = {
      version: 1 as const,
      callSessionId: value.callSessionId,
      turnId: value.turnId,
      participantIdentity: value.participantIdentity,
      segmentIds: normalizedSegmentIds,
      directlyAddressed: value.directlyAddressed,
      source: 'semantic_model' as const,
      revision: Number(value.revision),
      issuedAtMs: Number(value.issuedAtMs),
      expiresAtMs: Number(value.expiresAtMs),
    };
    const expected = crypto
      .createHmac('sha256', privateSigningKey)
      .update(JSON.stringify(voiceEngagementSignedValues(signedValue, utteranceDigest)))
      .digest();
    const actual = Buffer.from(value.attestation, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
  }

  return { createVoiceEngagementAttestation, verifyVoiceEngagementAttestation };
}

/* === VIVENTIUM END === */
