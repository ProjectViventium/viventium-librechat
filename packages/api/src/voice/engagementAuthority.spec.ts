import { createVoiceEngagementAttestationService } from './engagementAttestation';
import {
  canonicalVoiceOwnerUtterance,
  canonicalVoiceSessionMode,
  createVoiceEngagementAuthorityService,
} from './engagementAuthority';

const session = {
  callSessionId: 'call-1',
  userId: 'owner-1',
  agentId: 'agent-1',
  mode: 'wing',
  status: 'listening',
  ownerParticipantIdentity: 'owner-participant',
  speakerAttributionState: 'owner_verified',
};
const segment = {
  callSessionId: 'call-1',
  turnId: 'turn-1',
  segmentId: 'segment-1',
  sequence: 1,
  revision: 2,
  text: ' Please   help ',
  isFinal: true,
  speaker: {
    participantIdentity: 'owner-participant',
    attribution: 'verified',
    actorTrust: 'owner_participant',
  },
  overlap: false,
  uncertain: false,
};

describe('voice engagement authority', () => {
  const getCallSession = jest.fn();
  const listSpeakerSegments = jest.fn();
  const voiceTurnAuthority = jest.fn(() => ({ canAuthorizeSideEffects: true }));
  const attestation = createVoiceEngagementAttestationService({
    getTransportSecret: () => 'configured',
    signingKey: Buffer.alloc(32, 9),
  });

  function authority() {
    return createVoiceEngagementAuthorityService({
      getCallSession,
      listSpeakerSegments,
      voiceTurnAuthority,
      verifyVoiceEngagementAttestation: attestation.verifyVoiceEngagementAttestation,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    getCallSession.mockResolvedValue(session);
    listSpeakerSegments.mockResolvedValue([segment]);
    voiceTurnAuthority.mockReturnValue({ canAuthorizeSideEffects: true });
  });

  test('normalizes canonical modes and owner speech without semantic matching', () => {
    expect(canonicalVoiceSessionMode({ mode: 'listen_only', wingModeEnabled: true })).toBe(
      'listen_only',
    );
    expect(canonicalVoiceSessionMode({ wingModeEnabled: true })).toBe('wing');
    expect(canonicalVoiceSessionMode({})).toBe('call');
    expect(canonicalVoiceOwnerUtterance([segment, { ...segment, text: 'now.' }])).toBe(
      'Please help now.',
    );
  });

  test('requires final, verified, non-overlapping owner-only speaker evidence', () => {
    const service = authority();
    expect(service.finalizedOwnerSpeakerAuthority([segment], session)).toBe(true);
    for (const changed of [
      { ...segment, isFinal: false },
      { ...segment, overlap: true },
      { ...segment, uncertain: true },
      { ...segment, speaker: { ...segment.speaker, participantIdentity: 'guest' } },
      { ...segment, speaker: { ...segment.speaker, attribution: 'inferred' } },
      { ...segment, speaker: { ...segment.speaker, actorTrust: 'shared_mic_unverified' } },
    ]) {
      expect(service.finalizedOwnerSpeakerAuthority([changed], session)).toBe(false);
    }
  });

  test('preserves a separately verified owner track when the session also has shared tracks', () => {
    const sharedSession = {
      ...session,
      speakerAttributionState: 'shared_mic_unverified',
      sharedTrackSids: ['guest-track'],
      sharedParticipantIdentities: ['guest-participant'],
    };

    expect(authority().finalizedOwnerSpeakerAuthority([segment], sharedSession)).toBe(true);
    expect(voiceTurnAuthority).toHaveBeenCalledWith([segment], {
      speakerAttributionState: 'shared_mic_unverified',
      sharedTrackSids: ['guest-track'],
      sharedParticipantIdentities: ['guest-participant'],
    });
  });

  test('accepts only a signed positive verdict for the exact persisted utterance and revision', () => {
    const engagement = attestation.createVoiceEngagementAttestation({
      callSessionId: session.callSessionId,
      turnId: segment.turnId,
      participantIdentity: session.ownerParticipantIdentity,
      segmentIds: [segment.segmentId],
      directlyAddressed: true,
      revision: segment.revision,
      utterance: 'Please help',
    });
    const service = authority();

    expect(service.exactVoiceEngagementAuthority(engagement, session, [segment])).toBe(true);
    expect(
      service.exactVoiceEngagementAuthority({ ...engagement, directlyAddressed: false }, session, [
        segment,
      ]),
    ).toBe(false);
    expect(
      service.exactVoiceEngagementAuthority(engagement, session, [segment], 'Different action'),
    ).toBe(false);
  });

  test('re-reads current session and the highest persisted segment revision', async () => {
    listSpeakerSegments.mockResolvedValue([{ ...segment, revision: 1, text: 'stale' }, segment]);

    await expect(
      authority().latestPersistedVoiceTurnAuthority({
        session,
        userId: 'owner-1',
        turnId: 'turn-1',
        expectedSegments: [segment],
      }),
    ).resolves.toMatchObject({
      session,
      segments: [segment],
      complete: true,
      revisionChanged: false,
    });
  });

  test('fails closed after owner/session replacement or a changed expected revision', async () => {
    getCallSession.mockResolvedValueOnce({ ...session, userId: 'another-owner' });
    await expect(
      authority().latestPersistedVoiceTurnAuthority({
        session,
        userId: 'owner-1',
        turnId: 'turn-1',
      }),
    ).resolves.toBeNull();

    getCallSession.mockResolvedValueOnce(session);
    await expect(
      authority().latestPersistedVoiceTurnAuthority({
        session,
        userId: 'owner-1',
        turnId: 'turn-1',
        expectedSegments: [{ ...segment, revision: 1 }],
      }),
    ).resolves.toMatchObject({ revisionChanged: true });
  });

  test('verifies only the exact Core-only gateway envelope against fresh persisted authority', async () => {
    const engagement = attestation.createVoiceEngagementAttestation({
      callSessionId: session.callSessionId,
      turnId: segment.turnId,
      participantIdentity: session.ownerParticipantIdentity,
      segmentIds: [segment.segmentId],
      directlyAddressed: true,
      revision: segment.revision,
      utterance: 'Please help',
    });
    const service = authority();

    await expect(
      service.verifyPersistedVoiceEngagement({
        body: { version: 1, engagement },
        session,
        userId: 'owner-1',
      }),
    ).resolves.toEqual({ version: 1, callSessionId: 'call-1', turnId: 'turn-1', verified: true });
    await expect(
      service.verifyPersistedVoiceEngagement({
        body: { version: 1, engagement, bypass: true },
        session,
        userId: 'owner-1',
      }),
    ).resolves.toBeNull();
  });
});
