/* === VIVENTIUM START ===
 * Feature: Current owner voice action authority.
 * Purpose: Bind typed participant input or finalized audio evidence to the current call authority.
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

export interface VoiceTypedInputV1 {
  version: 1;
  kind: 'participant_text';
  callSessionId: string;
  participantIdentity: string;
  sourceEventId: string;
  textSha256: string;
}

interface VoiceTurnAuthorityInput {
  session: unknown;
  segments: unknown[];
  typedInput?: unknown;
  sourceEventId?: unknown;
  text?: unknown;
  engagement?: unknown;
}

const TYPED_INPUT_KEYS = new Set([
  'version',
  'kind',
  'callSessionId',
  'participantIdentity',
  'sourceEventId',
  'textSha256',
]);

/** Only the authenticated gateway may supply participant provenance; no audio evidence is implied. */
export function normalizeVoiceTypedInput(
  input: unknown,
  { session, sourceEventId, text, segments }: VoiceTurnAuthorityInput,
): VoiceTypedInputV1 | null {
  const value = recordFrom(input);
  const current = recordFrom(session);
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  if (
    Object.keys(value).length !== TYPED_INPUT_KEYS.size ||
    Object.keys(value).some((key) => !TYPED_INPUT_KEYS.has(key)) ||
    value.version !== 1 ||
    value.kind !== 'participant_text' ||
    !current.ownerParticipantIdentity ||
    value.callSessionId !== current.callSessionId ||
    value.participantIdentity !== current.ownerParticipantIdentity ||
    typeof sourceEventId !== 'string' ||
    !sourceEventId ||
    sourceEventId.length > 160 ||
    value.sourceEventId !== sourceEventId ||
    !normalizedText ||
    segments.length > 0 ||
    value.textSha256 !== crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex')
  )
    return null;
  return {
    version: 1,
    kind: 'participant_text',
    callSessionId: String(current.callSessionId),
    participantIdentity: String(current.ownerParticipantIdentity),
    sourceEventId,
    textSha256: String(value.textSha256),
  };
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

/** Server-created evidence only; never accept this binding from a client or model argument. */
export interface VoiceWorkAuthorityBinding {
  version: 1;
  callSessionId: string;
  userId: string;
  kind: 'audio' | 'participant_text';
  fingerprint: string;
  turnIds: string[];
  expiresAtMs?: number;
}

export function createVoiceWorkAuthorityBinding(input: {
  session: unknown;
  segments: unknown;
  typedInput?: unknown;
  engagement?: unknown;
}): VoiceWorkAuthorityBinding | null {
  const session = recordFrom(input.session);
  const mode = canonicalVoiceSessionMode(session);
  const kind = input.typedInput ? 'participant_text' : 'audio';
  const modeRevision = Number(session.revision ?? session.callModeRevision ?? 0);
  const speakerRevision = Number(session.speakerSessionRevision ?? 0);
  const segments = recordsFrom(input.segments)
    .map((segment) => ({
      segmentId: segment.segmentId,
      turnId: segment.turnId,
      revision: Number(segment.revision ?? 0),
      final: segment.isFinal === true,
      overlap: segment.overlap === true,
      uncertain: segment.uncertain === true,
      participant: recordFrom(segment.speaker).participantIdentity,
      attribution: recordFrom(segment.speaker).attribution,
      actorTrust: recordFrom(segment.speaker).actorTrust,
    }))
    .sort((a, b) => String(a.segmentId).localeCompare(String(b.segmentId)));
  const expiresAtMs = Number(recordFrom(input.engagement).expiresAtMs);
  if (
    !session.callSessionId ||
    !session.userId ||
    !session.ownerParticipantIdentity ||
    session.status === 'ended' ||
    session.status === 'failed' ||
    mode === 'listen_only' ||
    !Number.isSafeInteger(modeRevision) ||
    modeRevision < 0 ||
    !Number.isSafeInteger(speakerRevision) ||
    speakerRevision < 0 ||
    (kind === 'audio' &&
      (!segments.length ||
        segments.some(
          (segment) =>
            !segment.segmentId ||
            !segment.turnId ||
            !Number.isSafeInteger(segment.revision) ||
            segment.revision < 0 ||
            !segment.final ||
            segment.overlap ||
            segment.uncertain ||
            segment.participant !== session.ownerParticipantIdentity ||
            segment.attribution !== 'verified' ||
            segment.actorTrust !== 'owner_participant',
        ))) ||
    (kind === 'participant_text' && (mode !== 'call' || segments.length > 0)) ||
    (mode === 'wing' && !Number.isFinite(expiresAtMs))
  )
    return null;
  return {
    version: 1,
    callSessionId: String(session.callSessionId),
    userId: String(session.userId),
    kind,
    turnIds: [...new Set(segments.map((segment) => String(segment.turnId)))].sort(),
    fingerprint: crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          mode,
          modeRevision,
          speakerRevision,
          owner: session.ownerParticipantIdentity,
          segments,
        }),
        'utf8',
      )
      .digest('hex'),
    ...(mode === 'wing' ? { expiresAtMs } : {}),
  };
}

export function createVoiceEngagementAuthorityService(deps: VoiceEngagementAuthorityDependencies) {
  function resolveVoiceTurnAuthority(input: VoiceTurnAuthorityInput) {
    const session = recordFrom(input.session);
    const mode = canonicalVoiceSessionMode(session);
    if (input.typedInput != null) {
      const typed = normalizeVoiceTypedInput(input.typedInput, input);
      const allowed = Boolean(
        typed && mode === 'call' && session.status !== 'ended' && session.status !== 'failed',
      );
      return {
        actorTrust: allowed ? 'owner_participant' : 'unknown',
        canAuthorizeSideEffects: allowed,
        directWingEngagement: false,
      };
    }
    const authority = recordFrom(
      deps.voiceTurnAuthority(input.segments, {
        speakerAttributionState: session.speakerAttributionState,
        sharedTrackSids: session.sharedTrackSids,
        sharedParticipantIdentities: session.sharedParticipantIdentities,
      }),
    );
    const directWingEngagement =
      mode === 'wing' &&
      exactVoiceEngagementAuthority(input.engagement, session, input.segments, input.text);
    return {
      actorTrust: authority.actorTrust || 'unknown',
      directWingEngagement,
      canAuthorizeSideEffects:
        finalizedOwnerSpeakerAuthority(input.segments, session) &&
        mode !== 'listen_only' &&
        (mode !== 'wing' || directWingEngagement),
    };
  }
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

  async function assertVoiceWorkAuthority(
    binding: VoiceWorkAuthorityBinding | undefined,
    userId: string,
  ) {
    const stale = () =>
      Object.assign(new Error('voice_work_authority_stale'), {
        code: 'voice_work_authority_stale',
        status: 409,
        retryable: false,
      });
    if (
      !binding ||
      binding.version !== 1 ||
      binding.userId !== userId ||
      !binding.callSessionId ||
      !Array.isArray(binding.turnIds) ||
      !['audio', 'participant_text'].includes(binding.kind)
    )
      throw stale();
    const session = recordFrom(await deps.getCallSession(binding.callSessionId));
    if (
      String(session.userId || '') !== userId ||
      String(session.callSessionId || '') !== binding.callSessionId
    )
      throw stale();
    const stored =
      binding.kind === 'audio'
        ? await deps.listSpeakerSegments({ callSessionId: binding.callSessionId, limit: 512 })
        : [];
    // Bind the accepted turn, not later unrelated conversation audio. The exact turn IDs are
    // retained separately from the hash so a new utterance does not revoke accepted authority.
    const current = createVoiceWorkAuthorityBinding({
      session,
      segments: recordsFrom(stored).filter((segment) =>
        binding.turnIds.includes(String(segment.turnId || '')),
      ),
      typedInput: binding.kind === 'participant_text',
      engagement: { expiresAtMs: binding.expiresAtMs },
    });
    if (
      !current ||
      current.fingerprint !== binding.fingerprint ||
      (binding.expiresAtMs !== undefined &&
        (!Number.isFinite(binding.expiresAtMs) || binding.expiresAtMs <= Date.now()))
    )
      throw stale();
  }

  return {
    assertVoiceWorkAuthority,
    resolveVoiceTurnAuthority,
    exactVoiceEngagementAuthority,
    finalizedOwnerSpeakerAuthority,
    latestPersistedVoiceTurnAuthority,
    verifyPersistedVoiceEngagement,
  };
}

/* === VIVENTIUM END === */
