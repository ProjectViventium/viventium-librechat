/* === VIVENTIUM START ===
 * Feature: SpeakerSegmentV1
 * Purpose: Validate speaker attribution at the authenticated LibreChat boundary, preserve safe
 * legacy projections, and persist monotonic call-scoped revisions before turn coalescing.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { Message, ViventiumCallSession, ViventiumVoiceSpeakerSegment } = require('~/db/models');

const SOURCES = new Set([
  'participant_track',
  'provider_diarization',
  'hybrid',
  'local_diarization',
  'unknown',
]);
const ATTRIBUTIONS = new Set(['verified', 'unverified', 'unknown']);
const ACTOR_TRUST = new Set([
  'owner_participant',
  'authenticated_participant',
  'shared_mic_unverified',
  'unknown',
]);
const MAX_SEGMENTS_PER_REQUEST = 128;
const MAX_SHARED_TRACKS_PER_SESSION = 64;
const MAX_SHARED_PARTICIPANTS_PER_SESSION = 64;
const SPEAKER_ATTRIBUTION_STATES = new Set(['single_speaker', 'shared_mic_unverified']);

function boundedText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeSharedTrackSids(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return [
    ...new Set(
      value
        .slice(0, MAX_SHARED_TRACKS_PER_SESSION)
        .map((item) => boundedText(item, 160))
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeSharedParticipantIdentities(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return [
    ...new Set(
      value
        .slice(0, MAX_SHARED_PARTICIPANTS_PER_SESSION)
        .map((item) => boundedText(item, 160))
        .filter(Boolean),
    ),
  ].sort();
}

function sharedMicAppliesToTrack({
  speakerAttributionState,
  sharedParticipantIdentities,
  participantIdentity,
} = {}) {
  if (speakerAttributionState !== 'shared_mic_unverified') {
    return false;
  }
  const scopedParticipants = normalizeSharedParticipantIdentities(sharedParticipantIdentities);
  if (!scopedParticipants || scopedParticipants.length === 0) {
    return true;
  }
  const normalizedParticipantIdentity = boundedText(participantIdentity, 160);
  return (
    !normalizedParticipantIdentity || scopedParticipants.includes(normalizedParticipantIdentity)
  );
}

function speakerSessionStateFromDocument(document) {
  if (!document || !SPEAKER_ATTRIBUTION_STATES.has(document.speakerAttributionState)) {
    return null;
  }
  const detectedAt = new Date(document.speakerDetectedAt || 0);
  if (!Number.isFinite(detectedAt.getTime())) {
    return null;
  }
  const state = {
    version: 1,
    callSessionId: String(document.callSessionId),
    revision: finiteNonNegative(document.speakerSessionRevision),
    attributionState: document.speakerAttributionState,
    detectedAt: detectedAt.toISOString(),
  };
  const sourceTrackSid = boundedText(document.speakerSourceTrackSid, 160);
  if (sourceTrackSid) {
    state.sourceTrackSid = sourceTrackSid;
  }
  const sharedTrackSids = normalizeSharedTrackSids(document.speakerSharedTrackSids);
  if (sharedTrackSids) {
    state.sharedTrackSids = sharedTrackSids;
  }
  const sourceParticipantIdentity = boundedText(document.speakerSourceParticipantIdentity, 160);
  if (sourceParticipantIdentity) {
    state.sourceParticipantIdentity = sourceParticipantIdentity;
  }
  const sharedParticipantIdentities = normalizeSharedParticipantIdentities(
    document.speakerSharedParticipantIdentities,
  );
  if (sharedParticipantIdentities) {
    state.sharedParticipantIdentities = sharedParticipantIdentities;
  }
  return state;
}

function normalizeSpeakerSessionState(input, callSessionId) {
  if (!input || typeof input !== 'object' || Number(input.version) !== 1) {
    return null;
  }
  const attributionState = SPEAKER_ATTRIBUTION_STATES.has(input.attributionState)
    ? input.attributionState
    : '';
  const detectedAt = new Date(input.detectedAt || 0);
  if (!callSessionId || !attributionState || !Number.isFinite(detectedAt.getTime())) {
    return null;
  }
  const state = {
    version: 1,
    callSessionId: String(callSessionId),
    revision: finiteNonNegative(input.revision),
    attributionState,
    detectedAt: detectedAt.toISOString(),
  };
  const sourceTrackSid = boundedText(input.sourceTrackSid, 160);
  if (sourceTrackSid) {
    state.sourceTrackSid = sourceTrackSid;
  }
  const requestedSharedTrackSids = normalizeSharedTrackSids(input.sharedTrackSids);
  const sourceParticipantIdentity = boundedText(input.sourceParticipantIdentity, 160);
  if (sourceParticipantIdentity) {
    state.sourceParticipantIdentity = sourceParticipantIdentity;
  }
  const requestedSharedParticipantIdentities = normalizeSharedParticipantIdentities(
    input.sharedParticipantIdentities,
  );
  if (attributionState === 'shared_mic_unverified') {
    const sharedTrackSids = [
      ...new Set([
        ...(sourceTrackSid ? [sourceTrackSid] : []),
        ...(requestedSharedTrackSids || []),
      ]),
    ]
      .slice(0, MAX_SHARED_TRACKS_PER_SESSION)
      .sort();
    if (sharedTrackSids.length > 0) {
      state.sharedTrackSids = sharedTrackSids;
    }
    const sharedParticipantIdentities = [
      ...new Set([
        ...(sourceParticipantIdentity ? [sourceParticipantIdentity] : []),
        ...(requestedSharedParticipantIdentities || []),
      ]),
    ]
      .slice(0, MAX_SHARED_PARTICIPANTS_PER_SESSION)
      .sort();
    if (sharedParticipantIdentities.length > 0) {
      state.sharedParticipantIdentities = sharedParticipantIdentities;
    }
  }
  return state;
}

async function invalidateVoiceMemoryFinalization(callSessionId) {
  /* === VIVENTIUM START ===
   * Feature: Durable post-call voice-memory finalization
   * Purpose: Any later speaker-session evidence invalidates a previously finalized memory
   * classification before the new evidence can become authoritative. A hardener run may
   * re-finalize only after it has reconciled the complete terminal session and segment ledgers.
   * === VIVENTIUM END === */
  await Message.updateMany(
    { 'metadata.viventium.callSessionId': callSessionId },
    { $unset: { 'metadata.viventium.memoryFinalization': '' } },
  );
}

const MEMORY_FINALIZATION_LEASE_WAIT_MS = 6_000;
const MEMORY_FINALIZATION_LEASE_POLL_MS = 25;

async function advanceVoiceMemoryEvidenceEpoch(callSessionId) {
  /* === VIVENTIUM START ===
   * Feature: voice-memory speaker evidence epoch
   * Purpose: Fence the hardener on both sides of every speaker mutation. A hardener snapshot
   * taken while a revision is in flight can never publish a final marker for the resulting epoch.
   * === VIVENTIUM END === */
  const deadline = Date.now() + MEMORY_FINALIZATION_LEASE_WAIT_MS;
  while (true) {
    const now = new Date();
    const result = await ViventiumCallSession.updateOne(
      {
        callSessionId,
        expiresAt: { $gt: now },
        $or: [
          { memoryFinalizationLeaseId: null },
          { memoryFinalizationLeaseId: { $exists: false } },
          { memoryFinalizationLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $inc: { speakerEvidenceEpoch: 1 },
        $unset: {
          memoryFinalizationLeaseId: '',
          memoryFinalizationLeaseExpiresAt: '',
          memoryFinalizedEvidenceEpoch: '',
          memoryFinalizedAt: '',
        },
      },
    );
    const matched = Number(result?.matchedCount ?? result?.n ?? 0);
    if (matched === 1) break;
    const session = await ViventiumCallSession.findOne({
      callSessionId,
      expiresAt: { $gt: now },
    })
      .select('_id memoryFinalizationLeaseExpiresAt')
      .lean();
    if (!session) {
      const error = new Error('Unknown or expired call session');
      error.status = 404;
      throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error('Voice memory finalization is still reconciling speaker evidence');
      error.status = 503;
      error.code = 'speaker_evidence_finalization_busy';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, MEMORY_FINALIZATION_LEASE_POLL_MS));
  }
  await invalidateVoiceMemoryFinalization(callSessionId);
}

async function persistSpeakerSessionState({ callSessionId, state } = {}) {
  const normalized = normalizeSpeakerSessionState(state, callSessionId);
  if (!normalized) {
    const error = new Error('Invalid SpeakerSessionStateV1');
    error.status = 400;
    throw error;
  }
  const now = new Date();
  let currentDocument = await ViventiumCallSession.findOne({
    callSessionId: normalized.callSessionId,
    expiresAt: { $gt: now },
  }).lean();
  if (!currentDocument) {
    const error = new Error('Unknown or expired call session');
    error.status = 404;
    throw error;
  }
  await advanceVoiceMemoryEvidenceEpoch(normalized.callSessionId);
  const current = speakerSessionStateFromDocument(currentDocument);
  const scopedSharedParticipants =
    normalized.attributionState === 'shared_mic_unverified' &&
    Array.isArray(normalized.sharedParticipantIdentities) &&
    normalized.sharedParticipantIdentities.length > 0
      ? normalized.sharedParticipantIdentities
      : null;
  if (scopedSharedParticipants) {
    const currentHasScopedParticipants = Array.isArray(
      currentDocument.speakerSharedParticipantIdentities,
    );
    if (current?.attributionState === 'shared_mic_unverified' && !currentHasScopedParticipants) {
      return { accepted: false, state: current };
    }
    const currentParticipants =
      normalizeSharedParticipantIdentities(currentDocument.speakerSharedParticipantIdentities) ||
      [];
    if (scopedSharedParticipants.every((identity) => currentParticipants.includes(identity))) {
      return { accepted: false, state: current };
    }
    const scopedSharedTracks = normalized.sharedTrackSids || [];
    const addToSet = {
      speakerSharedParticipantIdentities: { $each: scopedSharedParticipants },
      ...(scopedSharedTracks.length > 0
        ? { speakerSharedTrackSids: { $each: scopedSharedTracks } }
        : {}),
    };
    const updated = await ViventiumCallSession.findOneAndUpdate(
      {
        callSessionId: normalized.callSessionId,
        expiresAt: { $gt: now },
        $and: [
          {
            $or: [
              { speakerAttributionState: { $ne: 'shared_mic_unverified' } },
              { speakerSharedParticipantIdentities: { $exists: true } },
            ],
          },
          {
            speakerSharedParticipantIdentities: {
              $not: { $all: scopedSharedParticipants },
            },
          },
        ],
      },
      {
        $addToSet: addToSet,
        $max: { speakerSessionRevision: normalized.revision },
        $set: {
          speakerAttributionState: 'shared_mic_unverified',
          speakerDetectedAt: new Date(normalized.detectedAt),
          speakerSourceTrackSid: normalized.sourceTrackSid || scopedSharedTracks[0] || null,
          speakerSourceParticipantIdentity:
            normalized.sourceParticipantIdentity || scopedSharedParticipants[0],
        },
      },
      { new: true },
    ).lean();
    if (updated) {
      await advanceVoiceMemoryEvidenceEpoch(normalized.callSessionId);
      return { accepted: true, state: speakerSessionStateFromDocument(updated) };
    }
    currentDocument = await ViventiumCallSession.findOne({
      callSessionId: normalized.callSessionId,
      expiresAt: { $gt: now },
    }).lean();
    return { accepted: false, state: speakerSessionStateFromDocument(currentDocument) };
  }
  if (
    current &&
    (current.revision >= normalized.revision ||
      (current.attributionState === 'shared_mic_unverified' &&
        normalized.attributionState !== 'shared_mic_unverified'))
  ) {
    return { accepted: false, state: current };
  }

  const query = {
    callSessionId: normalized.callSessionId,
    expiresAt: { $gt: now },
    $or: [
      { speakerSessionRevision: { $exists: false } },
      { speakerSessionRevision: null },
      { speakerSessionRevision: { $lt: normalized.revision } },
    ],
  };
  if (normalized.attributionState !== 'shared_mic_unverified') {
    query.speakerAttributionState = { $ne: 'shared_mic_unverified' };
  }
  const update = {
    $set: {
      speakerSessionRevision: normalized.revision,
      speakerAttributionState: normalized.attributionState,
      speakerDetectedAt: new Date(normalized.detectedAt),
      speakerSourceTrackSid: normalized.sourceTrackSid || null,
      speakerSourceParticipantIdentity: normalized.sourceParticipantIdentity || null,
    },
  };
  if (normalized.attributionState === 'shared_mic_unverified') {
    update.$unset = {
      speakerSharedTrackSids: '',
      speakerSharedParticipantIdentities: '',
    };
  }
  const updated = await ViventiumCallSession.findOneAndUpdate(query, update, { new: true }).lean();
  if (updated) {
    await advanceVoiceMemoryEvidenceEpoch(normalized.callSessionId);
    return { accepted: true, state: speakerSessionStateFromDocument(updated) };
  }
  currentDocument = await ViventiumCallSession.findOne({
    callSessionId: normalized.callSessionId,
    expiresAt: { $gt: now },
  }).lean();
  return { accepted: false, state: speakerSessionStateFromDocument(currentDocument) };
}

function normalizeSpeakerSegment(
  input,
  {
    callSessionId,
    ownerParticipantIdentity,
    ownerTrackSid,
    ambientIngress = false,
    speakerAttributionState,
    sharedParticipantIdentities,
  } = {},
) {
  if (!input || typeof input !== 'object' || Number(input.version) !== 1) {
    return null;
  }
  const segmentId = boundedText(input.segmentId, 160);
  const turnId = boundedText(input.turnId, 160);
  const text = boundedText(input.text, 20000);
  const speakerInput = input.speaker && typeof input.speaker === 'object' ? input.speaker : {};
  if (!segmentId || !turnId || !text || !callSessionId) {
    return null;
  }

  const source = SOURCES.has(speakerInput.source) ? speakerInput.source : 'unknown';
  let attribution = ATTRIBUTIONS.has(speakerInput.attribution)
    ? speakerInput.attribution
    : 'unknown';
  let actorTrust = ACTOR_TRUST.has(speakerInput.actorTrust) ? speakerInput.actorTrust : 'unknown';

  const participantIdentity = boundedText(speakerInput.participantIdentity, 160);
  const trackSid = boundedText(speakerInput.trackSid, 160);
  const participantOwnerBound =
    source === 'participant_track' &&
    attribution === 'verified' &&
    actorTrust === 'owner_participant' &&
    Boolean(ownerParticipantIdentity || ownerTrackSid) &&
    (!ownerParticipantIdentity || participantIdentity === ownerParticipantIdentity) &&
    (!ownerTrackSid || trackSid === ownerTrackSid);
  const participantAuthenticatedBound =
    source === 'participant_track' &&
    attribution === 'verified' &&
    actorTrust === 'authenticated_participant' &&
    ambientIngress === true &&
    Boolean(participantIdentity) &&
    Boolean(trackSid);
  const hybridOwnerBound =
    source === 'hybrid' &&
    attribution === 'verified' &&
    actorTrust === 'owner_participant' &&
    Boolean(ownerParticipantIdentity || ownerTrackSid) &&
    (!ownerParticipantIdentity || participantIdentity === ownerParticipantIdentity) &&
    (!ownerTrackSid || trackSid === ownerTrackSid);
  const hybridAuthenticatedParticipantBound =
    source === 'hybrid' &&
    attribution === 'verified' &&
    actorTrust === 'authenticated_participant' &&
    ambientIngress === true &&
    Boolean(participantIdentity) &&
    Boolean(trackSid);

  // Diarization alone distinguishes voices, never identity or authority. A hybrid segment may
  // preserve the signed participant authority only when the authenticated gateway supplies the
  // matching call-scoped participant/track binding.
  if (
    !participantOwnerBound &&
    !participantAuthenticatedBound &&
    !hybridOwnerBound &&
    !hybridAuthenticatedParticipantBound
  ) {
    attribution = attribution === 'unknown' ? 'unknown' : 'unverified';
    actorTrust =
      source === 'provider_diarization' || source === 'hybrid'
        ? 'shared_mic_unverified'
        : 'unknown';
  } else if (attribution !== 'verified') {
    actorTrust = 'unknown';
  }
  if (actorTrust === 'owner_participant' && !participantOwnerBound && !hybridOwnerBound) {
    actorTrust = 'unknown';
  }
  if (
    sharedMicAppliesToTrack({
      speakerAttributionState,
      sharedParticipantIdentities,
      participantIdentity,
    })
  ) {
    attribution = 'unverified';
    actorTrust = 'shared_mic_unverified';
  }

  const speaker = {
    key: boundedText(speakerInput.key, 160, 'unknown'),
    label: boundedText(speakerInput.label, 120, 'Unknown'),
    source,
    attribution,
    actorTrust,
  };
  const optionalSpeakerFields = {
    participantIdentity,
    participantName: boundedText(speakerInput.participantName, 120),
    trackSid,
    providerSpeakerId: boundedText(speakerInput.providerSpeakerId, 120),
  };
  for (const [key, value] of Object.entries(optionalSpeakerFields)) {
    if (value) {
      speaker[key] = value;
    }
  }

  const normalized = {
    version: 1,
    segmentId,
    callSessionId: String(callSessionId),
    turnId,
    sequence: finiteNonNegative(input.sequence),
    revision: finiteNonNegative(input.revision),
    text,
    isFinal: input.isFinal === true,
    speaker,
    overlap: input.overlap === true,
    uncertain: input.uncertain === true,
  };
  for (const key of ['startTimeMs', 'endTimeMs']) {
    if (Number.isFinite(Number(input[key])) && Number(input[key]) >= 0) {
      normalized[key] = Number(input[key]);
    }
  }
  return normalized;
}

function normalizeSpeakerSegments(inputs, context) {
  if (!Array.isArray(inputs)) {
    return [];
  }
  return inputs
    .slice(0, MAX_SEGMENTS_PER_REQUEST)
    .map((input) => normalizeSpeakerSegment(input, context))
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.segmentId.localeCompare(right.segmentId),
    );
}

function legacySpeakerLabel(segments) {
  const labels = new Set(
    (segments || []).map((segment) => segment?.speaker?.label).filter(Boolean),
  );
  if (labels.size === 1) {
    return [...labels][0];
  }
  return labels.size > 1 ? 'multiple' : 'room';
}

function voiceTurnAuthority(
  segments,
  { speakerAttributionState, sharedParticipantIdentities } = {},
) {
  const valid = Array.isArray(segments) ? segments.filter(Boolean) : [];
  const trusts = new Set(valid.map((segment) => segment?.speaker?.actorTrust || 'unknown'));
  const ownerOnly =
    valid.length > 0 &&
    trusts.size === 1 &&
    trusts.has('owner_participant') &&
    valid.every(
      (segment) =>
        segment?.speaker?.attribution === 'verified' &&
        !sharedMicAppliesToTrack({
          speakerAttributionState,
          sharedParticipantIdentities,
          participantIdentity: segment?.speaker?.participantIdentity,
        }) &&
        segment?.overlap !== true &&
        segment?.uncertain !== true,
    );
  return {
    actorTrust: ownerOnly ? 'owner_participant' : trusts.size === 1 ? [...trusts][0] : 'unknown',
    canAuthorizeSideEffects: ownerOnly,
    deferDurableMemory: true,
  };
}

async function persistOne(segment, expiresAt) {
  const filter = { callSessionId: segment.callSessionId, segmentId: segment.segmentId };
  const update = await ViventiumVoiceSpeakerSegment.findOneAndUpdate(
    { ...filter, revision: { $lt: segment.revision } },
    { $set: { revision: segment.revision, payload: segment, expiresAt } },
    { upsert: false, new: true, timestamps: true },
  );
  if (update) {
    return { accepted: true, effectiveSegment: update.payload || segment };
  }
  try {
    await ViventiumVoiceSpeakerSegment.create({
      ...filter,
      revision: segment.revision,
      payload: segment,
      expiresAt,
    });
    return { accepted: true, effectiveSegment: segment };
  } catch (error) {
    if (Number(error?.code) !== 11000) {
      throw error;
    }
  }
  const retry = await ViventiumVoiceSpeakerSegment.findOneAndUpdate(
    { ...filter, revision: { $lt: segment.revision } },
    { $set: { revision: segment.revision, payload: segment, expiresAt } },
    { upsert: false, new: true, timestamps: true },
  );
  if (retry) {
    return { accepted: true, effectiveSegment: retry.payload || segment };
  }
  const current = await ViventiumVoiceSpeakerSegment.findOne(filter).lean();
  return { accepted: false, effectiveSegment: current?.payload || segment };
}

async function persistSpeakerSegments({
  callSessionId,
  currentSegments,
  revisions,
  expiresAtMs,
  ownerParticipantIdentity,
  ownerTrackSid,
  ambientIngress = false,
  speakerAttributionState,
  sharedTrackSids,
  sharedParticipantIdentities,
}) {
  const context = {
    callSessionId,
    ownerParticipantIdentity,
    ownerTrackSid,
    ambientIngress,
    speakerAttributionState,
    sharedTrackSids,
    sharedParticipantIdentities,
  };
  const normalizedCurrent = normalizeSpeakerSegments(currentSegments, context);
  const normalizedRevisions = normalizeSpeakerSegments(revisions, context);
  const candidates = [...normalizedCurrent, ...normalizedRevisions];
  if (candidates.length > 0) {
    await advanceVoiceMemoryEvidenceEpoch(callSessionId);
  }
  const expiresAt = new Date(
    Number.isFinite(Number(expiresAtMs)) && Number(expiresAtMs) > Date.now()
      ? Number(expiresAtMs)
      : Date.now() + 24 * 60 * 60 * 1000,
  );
  const accepted = [];
  const ignored = [];
  const effectiveSegments = [];
  for (const segment of candidates) {
    try {
      const result = await persistOne(segment, expiresAt);
      if (result.accepted) {
        accepted.push(segment.segmentId);
      } else {
        ignored.push(segment.segmentId);
      }
      if (result.effectiveSegment) {
        effectiveSegments.push(result.effectiveSegment);
      }
    } catch (error) {
      if (Number(error?.code) === 11000) {
        ignored.push(segment.segmentId);
        continue;
      }
      throw error;
    }
  }
  logger.debug?.('[VIVENTIUM][SpeakerSegment] revisions persisted', {
    callSessionId,
    accepted: accepted.length,
    ignored: ignored.length,
  });
  if (accepted.length > 0) {
    await advanceVoiceMemoryEvidenceEpoch(callSessionId);
  }
  return { accepted, ignored, currentSegments: normalizedCurrent, effectiveSegments };
}

async function listSpeakerSegments({
  callSessionId,
  limit = 512,
  now = new Date(),
  beforeSequence,
  beforeSegmentId,
  afterSequence,
  afterSegmentId,
  page = false,
} = {}) {
  const normalizedCallSessionId = boundedText(callSessionId, 160);
  if (!normalizedCallSessionId) {
    return [];
  }
  const boundedLimit = Math.min(Math.max(finiteNonNegative(limit, 512), 1), 512);
  const rows = await ViventiumVoiceSpeakerSegment.find({
    callSessionId: normalizedCallSessionId,
    expiresAt: { $gt: now },
  })
    .select({ payload: 1, revision: 1, _id: 0 })
    .lean();
  const latestBySegmentId = new Map();
  for (const row of rows) {
    const segment = row?.payload;
    if (segment?.version !== 1 || segment.callSessionId !== normalizedCallSessionId) {
      continue;
    }
    const existing = latestBySegmentId.get(segment.segmentId);
    if (!existing || Number(existing.revision || 0) < Number(segment.revision || 0)) {
      latestBySegmentId.set(segment.segmentId, segment);
    }
  }
  const sorted = [...latestBySegmentId.values()].sort(
    (left, right) =>
      Number(left.sequence || 0) - Number(right.sequence || 0) ||
      String(left.segmentId).localeCompare(String(right.segmentId)),
  );
  const hasBoundary = Number.isFinite(Number(beforeSequence)) && Number(beforeSequence) >= 0;
  const boundarySequence = hasBoundary ? Math.floor(Number(beforeSequence)) : null;
  const boundarySegmentId = boundedText(beforeSegmentId, 160);
  const hasAfterBoundary = Number.isFinite(Number(afterSequence)) && Number(afterSequence) >= 0;
  const afterBoundarySequence = hasAfterBoundary ? Math.floor(Number(afterSequence)) : null;
  const afterBoundarySegmentId = boundedText(afterSegmentId, 160);
  const eligible = hasBoundary
    ? sorted.filter((segment) => {
        const sequence = Number(segment.sequence || 0);
        if (sequence < boundarySequence) {
          return true;
        }
        return (
          sequence === boundarySequence &&
          Boolean(boundarySegmentId) &&
          String(segment.segmentId).localeCompare(boundarySegmentId) < 0
        );
      })
    : hasAfterBoundary
      ? sorted.filter((segment) => {
          const sequence = Number(segment.sequence || 0);
          if (sequence > afterBoundarySequence) return true;
          return (
            sequence === afterBoundarySequence &&
            Boolean(afterBoundarySegmentId) &&
            String(segment.segmentId).localeCompare(afterBoundarySegmentId) > 0
          );
        })
      : sorted;
  const segments = hasAfterBoundary
    ? eligible.slice(0, boundedLimit)
    : eligible.slice(-boundedLimit);
  if (page !== true) {
    return segments;
  }
  const hasMore = eligible.length > segments.length;
  const first = segments[0];
  const last = segments.at(-1);
  return {
    segments,
    hasMore,
    ...(hasMore && hasAfterBoundary && last
      ? {
          nextAfterSequence: Number(last.sequence || 0),
          nextAfterSegmentId: String(last.segmentId),
        }
      : hasMore && first
        ? {
            nextBeforeSequence: Number(first.sequence || 0),
            nextBeforeSegmentId: String(first.segmentId),
          }
        : {}),
  };
}

async function projectSpeakerSegmentRevisionsToMessages({ callSessionId, segments } = {}) {
  const normalizedCallSessionId = boundedText(callSessionId, 160);
  const latestBySegmentId = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.version !== 1 || segment.callSessionId !== normalizedCallSessionId) {
      continue;
    }
    const existing = latestBySegmentId.get(segment.segmentId);
    if (!existing || Number(existing.revision || 0) < Number(segment.revision || 0)) {
      latestBySegmentId.set(segment.segmentId, segment);
    }
  }
  if (!normalizedCallSessionId || latestBySegmentId.size === 0) {
    return { matched: 0, updated: 0 };
  }
  const messageQuery = Message.find({
    'metadata.viventium.callSessionId': normalizedCallSessionId,
    'metadata.viventium.speakerSegments.segmentId': { $in: [...latestBySegmentId.keys()] },
  });
  const messages = await messageQuery
    .select({ _id: 1, 'metadata.viventium.speakerSegments': 1 })
    .lean();
  let updated = 0;
  for (const message of messages) {
    const current = Array.isArray(message?.metadata?.viventium?.speakerSegments)
      ? message.metadata.viventium.speakerSegments
      : [];
    let changed = false;
    const projected = current.map((segment) => {
      const revision = latestBySegmentId.get(segment?.segmentId);
      if (!revision || Number(revision.revision || 0) <= Number(segment?.revision || 0)) {
        return segment;
      }
      changed = true;
      return revision;
    });
    if (!changed) {
      continue;
    }
    const revisionGuards = projected
      .map((segment) => latestBySegmentId.get(segment?.segmentId))
      .filter(Boolean)
      .map((segment) => ({
        'metadata.viventium.speakerSegments': {
          $elemMatch: { segmentId: segment.segmentId, revision: { $lt: segment.revision } },
        },
      }));
    const result = await Message.updateOne(
      { _id: message._id, ...(revisionGuards.length ? { $or: revisionGuards } : {}) },
      {
        $set: {
          'metadata.viventium.speakerSegments': projected,
          'metadata.viventium.speakerLabel': legacySpeakerLabel(projected),
        },
        $unset: { 'metadata.viventium.memoryFinalization': '' },
      },
    );
    updated += Number(result?.modifiedCount || result?.nModified || 0);
  }
  return { matched: messages.length, updated };
}

module.exports = {
  legacySpeakerLabel,
  listSpeakerSegments,
  normalizeSpeakerSegment,
  normalizeSpeakerSegments,
  normalizeSpeakerSessionState,
  persistSpeakerSessionState,
  persistSpeakerSegments,
  projectSpeakerSegmentRevisionsToMessages,
  voiceTurnAuthority,
};
