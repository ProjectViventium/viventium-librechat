/* === VIVENTIUM START ===
 * Feature: Final owner-only Wing action authority.
 * Purpose: Bind semantic approval to current session mode and finalized persisted owner evidence.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

export interface VoiceEngagementAuthorityDependencies {
  getCallSession(callSessionId: string): Promise<unknown>;
  listSpeakerSegments(input: { callSessionId: string; limit: number }): Promise<unknown>;
  voiceTurnAuthority(segments: unknown[], options: UnknownRecord): unknown;
  verifyVoiceEngagementAttestation(value: unknown, options: UnknownRecord): boolean;
}

export interface LatestPersistedVoiceTurnAuthorityInput {
  session?: unknown;
  userId?: unknown;
  turnId?: unknown;
  expectedSegments?: unknown;
}

const ENGAGEMENT_KEYS = new Set([
  'version',
  'callSessionId',
  'turnId',
  'participantIdentity',
  'segmentIds',
  'directlyAddressed',
  'source',
  'revision',
  'issuedAtMs',
  'expiresAtMs',
  'attestation',
]);

export interface PersistedVoiceTurnAuthority {
  session: UnknownRecord;
  segments: UnknownRecord[];
  complete: boolean;
  revisionChanged: boolean;
}

function recordFrom(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function recordsFrom(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(recordFrom) : [];
}

function normalizeVoiceTurnText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function canonicalVoiceSessionMode(session: unknown): 'call' | 'wing' | 'listen_only' {
  const value = recordFrom(session);
  if (value.mode === 'call' || value.mode === 'wing' || value.mode === 'listen_only') {
    return value.mode;
  }
  if (value.listenOnlyModeEnabled === true) return 'listen_only';
  if (value.wingModeEnabled === true || value.shadowModeEnabled === true) return 'wing';
  return 'call';
}

export function canonicalVoiceOwnerUtterance(segments: unknown): string | null {
  const values = recordsFrom(segments);
  if (values.length === 0 || values.some((segment) => typeof segment.text !== 'string')) {
    return null;
  }
  return normalizeVoiceTurnText(values.map((segment) => segment.text).join(' ')) || null;
}

export function matchesCanonicalVoiceOwnerUtterance(
  segments: unknown,
  utterance: unknown,
): boolean {
  const expected = canonicalVoiceOwnerUtterance(segments);
  const actual = normalizeVoiceTurnText(utterance);
  if (!expected || !actual) return false;
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = crypto.createHash('sha256').update(actual, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

export function createVoiceEngagementAuthorityService(deps: VoiceEngagementAuthorityDependencies) {
  function finalizedOwnerSpeakerAuthority(segments: unknown, session: unknown): boolean {
    const values = recordsFrom(segments);
    const sessionRecord = recordFrom(session);
    const expectedOwner = String(sessionRecord.ownerParticipantIdentity || '');
    const authority = recordFrom(
      deps.voiceTurnAuthority(values, {
        speakerAttributionState: sessionRecord.speakerAttributionState,
        sharedTrackSids: sessionRecord.sharedTrackSids,
        sharedParticipantIdentities: sessionRecord.sharedParticipantIdentities,
      }),
    );
    return Boolean(
      expectedOwner &&
      values.length > 0 &&
      authority.canAuthorizeSideEffects === true &&
      values.every((segment) => {
        const speaker = recordFrom(segment.speaker);
        return (
          segment.isFinal === true &&
          speaker.participantIdentity === expectedOwner &&
          speaker.attribution === 'verified' &&
          speaker.actorTrust === 'owner_participant' &&
          segment.overlap !== true &&
          segment.uncertain !== true
        );
      }),
    );
  }

  function exactVoiceEngagementAuthority(
    engagement: unknown,
    session: unknown,
    segments: unknown,
    utterance: unknown = canonicalVoiceOwnerUtterance(segments),
  ): boolean {
    const value = recordFrom(engagement);
    const sessionRecord = recordFrom(session);
    const values = recordsFrom(segments);
    const segmentIds = Array.isArray(value.segmentIds) ? value.segmentIds : null;
    if (
      value.version !== 1 ||
      value.callSessionId !== sessionRecord.callSessionId ||
      value.participantIdentity !== sessionRecord.ownerParticipantIdentity ||
      value.directlyAddressed !== true ||
      value.source !== 'semantic_model' ||
      values.length < 1 ||
      !segmentIds ||
      segmentIds.length !== values.length ||
      values.some(
        (segment, index) =>
          segment.turnId !== value.turnId || segment.segmentId !== segmentIds[index],
      ) ||
      value.revision !== Math.max(...values.map((segment) => Number(segment.revision || 0))) ||
      !finalizedOwnerSpeakerAuthority(values, sessionRecord) ||
      !matchesCanonicalVoiceOwnerUtterance(values, utterance)
    ) {
      return false;
    }
    return deps.verifyVoiceEngagementAttestation(value, {
      utterance: canonicalVoiceOwnerUtterance(values),
    });
  }

  async function latestPersistedVoiceTurnAuthority({
    session,
    userId,
    turnId,
    expectedSegments,
  }: LatestPersistedVoiceTurnAuthorityInput): Promise<PersistedVoiceTurnAuthority | null> {
    const sessionRecord = recordFrom(session);
    const callSessionId = String(sessionRecord.callSessionId || '');
    if (!callSessionId || !userId) return null;
    const expected = recordsFrom(expectedSegments);
    const normalizedTurnId = String(turnId || '');
    const requiresSegments = Boolean(normalizedTurnId || expected.length);
    const [sessionResult, storedResult] = await Promise.all([
      deps.getCallSession(callSessionId),
      requiresSegments
        ? deps.listSpeakerSegments({ callSessionId, limit: 512 })
        : Promise.resolve([]),
    ]);
    const currentSession = recordFrom(sessionResult);
    if (
      !Object.keys(currentSession).length ||
      currentSession.callSessionId !== callSessionId ||
      String(currentSession.userId || '') !== String(userId) ||
      currentSession.status === 'ended' ||
      currentSession.status === 'failed' ||
      (sessionRecord.ownerParticipantIdentity &&
        currentSession.ownerParticipantIdentity !== sessionRecord.ownerParticipantIdentity) ||
      (sessionRecord.agentId && currentSession.agentId !== sessionRecord.agentId)
    ) {
      return null;
    }

    const latestBySegmentId = new Map<string, UnknownRecord>();
    for (const segment of recordsFrom(storedResult)) {
      if (
        segment.callSessionId !== callSessionId ||
        !segment.segmentId ||
        (normalizedTurnId && segment.turnId !== normalizedTurnId)
      ) {
        continue;
      }
      const segmentId = String(segment.segmentId);
      const previous = latestBySegmentId.get(segmentId);
      if (!previous || Number(segment.revision || 0) > Number(previous.revision || 0)) {
        latestBySegmentId.set(segmentId, segment);
      }
    }
    const segments = expected.length
      ? expected
          .map((segment) => latestBySegmentId.get(String(segment.segmentId || '')))
          .filter((segment): segment is UnknownRecord => Boolean(segment))
      : Array.from(latestBySegmentId.values()).sort(
          (left, right) =>
            Number(left.sequence || 0) - Number(right.sequence || 0) ||
            String(left.segmentId).localeCompare(String(right.segmentId)),
        );
    const complete = expected.length === 0 || segments.length === expected.length;
    const revisionChanged =
      complete &&
      expected.some(
        (segment, index) =>
          Number(segment.revision || 0) !== Number(segments[index]?.revision || 0) ||
          segment.turnId !== segments[index]?.turnId,
      );
    return { session: currentSession, segments, complete, revisionChanged };
  }

  async function verifyPersistedVoiceEngagement(input: {
    body?: unknown;
    session?: unknown;
    userId?: unknown;
  }): Promise<UnknownRecord | null> {
    const body = recordFrom(input.body);
    const engagement = recordFrom(body.engagement);
    const turnId = typeof engagement.turnId === 'string' ? engagement.turnId.trim() : '';
    if (
      Object.keys(body).sort().join(',') !== 'engagement,version' ||
      body.version !== 1 ||
      !turnId ||
      turnId.length > 160 ||
      Object.keys(engagement).length !== ENGAGEMENT_KEYS.size ||
      Object.keys(engagement).some((key) => !ENGAGEMENT_KEYS.has(key))
    ) {
      return null;
    }
    const current = await latestPersistedVoiceTurnAuthority({
      session: input.session,
      userId: input.userId,
      turnId,
    });
    if (
      !current ||
      canonicalVoiceSessionMode(current.session) !== 'wing' ||
      !exactVoiceEngagementAuthority(engagement, current.session, current.segments)
    ) {
      return null;
    }
    return {
      version: 1,
      callSessionId: current.session.callSessionId,
      turnId,
      verified: true,
    };
  }

  return {
    exactVoiceEngagementAuthority,
    finalizedOwnerSpeakerAuthority,
    latestPersistedVoiceTurnAuthority,
    verifyPersistedVoiceEngagement,
  };
}

/* === VIVENTIUM END === */
