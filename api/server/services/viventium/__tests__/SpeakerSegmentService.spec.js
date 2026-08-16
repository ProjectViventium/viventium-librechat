/* === VIVENTIUM START ===
 * Feature: SpeakerSegmentV1 contract tests
 * Purpose: Keep voice attribution additive, privacy-safe, and reversible.
 * === VIVENTIUM END === */

const {
  legacySpeakerLabel,
  listSpeakerSegments,
  normalizeSpeakerSegments,
  persistSpeakerSessionState,
  persistSpeakerSegments,
  projectSpeakerSegmentRevisionsToMessages,
  voiceTurnAuthority,
} = require('../SpeakerSegmentService');
const { Message, ViventiumCallSession, ViventiumVoiceSpeakerSegment } = require('~/db/models');

describe('SpeakerSegmentService', () => {
  test('normalizes the frozen V1 shape and strips untrusted fields', () => {
    const [segment] = normalizeSpeakerSegments(
      [
        {
          version: 1,
          segmentId: 'seg-1',
          callSessionId: 'spoofed-call',
          turnId: 'turn-1',
          sequence: 3,
          revision: 1,
          text: ' Hello there ',
          isFinal: true,
          speaker: {
            key: 'track:human-1',
            label: 'Owner One',
            source: 'participant_track',
            attribution: 'verified',
            actorTrust: 'owner_participant',
            participantIdentity: 'human-1',
            secret: 'must-not-survive',
          },
          ignored: 'must-not-survive',
        },
      ],
      { callSessionId: 'call-1', ownerParticipantIdentity: 'human-1' },
    );

    expect(segment).toEqual({
      version: 1,
      segmentId: 'seg-1',
      callSessionId: 'call-1',
      turnId: 'turn-1',
      sequence: 3,
      revision: 1,
      text: 'Hello there',
      isFinal: true,
      speaker: {
        key: 'track:human-1',
        label: 'Owner One',
        source: 'participant_track',
        attribution: 'verified',
        actorTrust: 'owner_participant',
        participantIdentity: 'human-1',
      },
      overlap: false,
      uncertain: false,
    });
  });

  test('never trusts provider diarization as an owner identity', () => {
    const [segment] = normalizeSpeakerSegments(
      [
        {
          version: 1,
          segmentId: 'seg-provider',
          turnId: 'turn-provider',
          sequence: 1,
          revision: 0,
          text: 'shared microphone speech',
          isFinal: true,
          speaker: {
            key: 'provider:A',
            label: 'Speaker 1',
            source: 'provider_diarization',
            attribution: 'verified',
            actorTrust: 'owner_participant',
            providerSpeakerId: 'A',
          },
        },
      ],
      { callSessionId: 'call-1' },
    );

    expect(segment.speaker.attribution).toBe('unverified');
    expect(segment.speaker.actorTrust).toBe('shared_mic_unverified');
    expect(voiceTurnAuthority([segment])).toEqual({
      actorTrust: 'shared_mic_unverified',
      canAuthorizeSideEffects: false,
      deferDurableMemory: true,
    });
  });

  test('keeps a persisted shared-mic tombstone authoritative after worker restart', () => {
    const [segment] = normalizeSpeakerSegments(
      [
        {
          version: 1,
          segmentId: 'segment-after-reconnect',
          turnId: 'turn-after-reconnect',
          sequence: 10,
          revision: 0,
          text: 'first speech after reconnect',
          isFinal: true,
          speaker: {
            key: 'track:owner',
            label: 'Owner',
            source: 'hybrid',
            attribution: 'verified',
            actorTrust: 'owner_participant',
            participantIdentity: 'owner',
            trackSid: 'owner-track',
          },
        },
      ],
      {
        callSessionId: 'call-1',
        ownerParticipantIdentity: 'owner',
        ownerTrackSid: 'owner-track',
        speakerAttributionState: 'shared_mic_unverified',
      },
    );

    expect(segment.speaker).toMatchObject({
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    });
    expect(
      voiceTurnAuthority([segment], {
        speakerAttributionState: 'shared_mic_unverified',
      }),
    ).toEqual({
      actorTrust: 'shared_mic_unverified',
      canAuthorizeSideEffects: false,
      deferDurableMemory: true,
    });
  });

  test('rejects spoofed participant-track owner trust without the signed call binding', () => {
    const [spoofed] = normalizeSpeakerSegments(
      [
        {
          version: 1,
          segmentId: 'segment-spoofed',
          turnId: 'turn-spoofed',
          sequence: 1,
          revision: 0,
          text: 'authorize this action',
          isFinal: true,
          speaker: {
            key: 'track:spoofed',
            label: 'Owner',
            source: 'participant_track',
            attribution: 'verified',
            actorTrust: 'owner_participant',
            participantIdentity: 'spoofed-participant',
            trackSid: 'spoofed-track',
          },
        },
      ],
      {
        callSessionId: 'call-1',
        ownerParticipantIdentity: 'actual-owner',
        ownerTrackSid: 'actual-track',
      },
    );

    expect(spoofed.speaker).toMatchObject({ attribution: 'unverified', actorTrust: 'unknown' });
    expect(voiceTurnAuthority([spoofed]).canAuthorizeSideEffects).toBe(false);
  });

  test.each([{ uncertain: true }, { overlap: true }])(
    'abstains from owner authority for uncertain or overlapping speech: %o',
    (flags) => {
      const [segment] = normalizeSpeakerSegments(
        [
          {
            version: 1,
            segmentId: `segment-${Object.keys(flags)[0]}`,
            turnId: 'turn-owner',
            sequence: 1,
            revision: 0,
            text: 'owner speech',
            isFinal: true,
            ...flags,
            speaker: {
              key: 'track:owner',
              label: 'Owner',
              source: 'participant_track',
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner',
              trackSid: 'owner-track',
            },
          },
        ],
        {
          callSessionId: 'call-1',
          ownerParticipantIdentity: 'owner',
          ownerTrackSid: 'owner-track',
        },
      );
      expect(voiceTurnAuthority([segment]).canAuthorizeSideEffects).toBe(false);
    },
  );

  test('preserves verified-owner hybrid attribution only when the signed track binding matches', () => {
    const input = {
      version: 1,
      segmentId: 'seg-hybrid',
      turnId: 'turn-hybrid',
      sequence: 1,
      revision: 0,
      text: 'owner speech',
      isFinal: true,
      speaker: {
        key: 'track:owner',
        label: 'Owner',
        source: 'hybrid',
        attribution: 'verified',
        actorTrust: 'owner_participant',
        participantIdentity: 'owner-participant',
        trackSid: 'track-owner',
        providerSpeakerId: 'A',
      },
    };

    const [verified] = normalizeSpeakerSegments([input], {
      callSessionId: 'call-1',
      ownerParticipantIdentity: 'owner-participant',
      ownerTrackSid: 'track-owner',
    });
    const [unbound] = normalizeSpeakerSegments([input], { callSessionId: 'call-1' });

    expect(verified.speaker.actorTrust).toBe('owner_participant');
    expect(verified.speaker.attribution).toBe('verified');
    expect(unbound.speaker.actorTrust).toBe('shared_mic_unverified');
    expect(unbound.speaker.attribution).toBe('unverified');
  });

  test('preserves signed non-owner hybrid attribution only on authenticated ambient ingress', () => {
    const input = {
      version: 1,
      segmentId: 'seg-guest',
      turnId: 'turn-guest',
      sequence: 1,
      revision: 0,
      text: 'guest speech',
      isFinal: true,
      speaker: {
        key: 'track:guest',
        label: 'Guest',
        source: 'hybrid',
        attribution: 'verified',
        actorTrust: 'authenticated_participant',
        participantIdentity: 'guest-participant',
        trackSid: 'track-guest',
        providerSpeakerId: 'A',
      },
    };

    const [ambient] = normalizeSpeakerSegments([input], {
      callSessionId: 'call-1',
      ambientIngress: true,
    });
    const [ordinary] = normalizeSpeakerSegments([input], { callSessionId: 'call-1' });

    expect(ambient.speaker).toMatchObject({
      source: 'hybrid',
      attribution: 'verified',
      actorTrust: 'authenticated_participant',
    });
    expect(voiceTurnAuthority([ambient]).canAuthorizeSideEffects).toBe(false);
    expect(ordinary.speaker).toMatchObject({
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    });
  });

  test('projects one legacy label but marks mixed turns as multiple', () => {
    const segments = normalizeSpeakerSegments(
      [
        {
          version: 1,
          segmentId: 'seg-a',
          turnId: 'turn-1',
          sequence: 1,
          revision: 0,
          text: 'first',
          isFinal: true,
          speaker: { key: 'a', label: 'Speaker 1', source: 'provider_diarization' },
        },
        {
          version: 1,
          segmentId: 'seg-b',
          turnId: 'turn-1',
          sequence: 2,
          revision: 0,
          text: 'second',
          isFinal: true,
          speaker: { key: 'b', label: 'Speaker 2', source: 'provider_diarization' },
        },
      ],
      { callSessionId: 'call-1' },
    );

    expect(legacySpeakerLabel(segments)).toBe('multiple');
  });

  test('keeps the highest payload revision under concurrent and reordered persistence', async () => {
    let stored = null;
    const conditionalUpdate = jest
      .spyOn(ViventiumVoiceSpeakerSegment, 'findOneAndUpdate')
      .mockImplementation(async (filter, update) => {
        await Promise.resolve();
        const incomingRevision = update.$set.revision;
        if (stored && stored.revision < incomingRevision) {
          stored = { ...stored, ...update.$set };
          return stored;
        }
        return null;
      });
    const create = jest
      .spyOn(ViventiumVoiceSpeakerSegment, 'create')
      .mockImplementation(async (document) => {
        await Promise.resolve();
        if (stored) {
          const error = new Error('duplicate');
          error.code = 11000;
          throw error;
        }
        stored = { ...document };
        return stored;
      });
    const findOne = jest.spyOn(ViventiumVoiceSpeakerSegment, 'findOne').mockImplementation(() => ({
      lean: async () => stored,
    }));
    const segmentAt = (revision) => ({
      version: 1,
      segmentId: 'seg-race',
      turnId: 'turn-race',
      sequence: 1,
      revision,
      text: `revision ${revision}`,
      isFinal: true,
      speaker: {
        key: 'provider:A',
        label: 'Speaker 1',
        source: 'provider_diarization',
        attribution: 'unverified',
        actorTrust: 'shared_mic_unverified',
      },
    });

    await Promise.all(
      [2, 1, 3].map((revision) =>
        persistSpeakerSegments({
          callSessionId: 'call-race',
          currentSegments: [segmentAt(revision)],
          revisions: [],
        }),
      ),
    );
    await persistSpeakerSegments({
      callSessionId: 'call-race',
      currentSegments: [segmentAt(1)],
      revisions: [],
    });

    expect(stored.revision).toBe(3);
    expect(stored.payload.text).toBe('revision 3');
    conditionalUpdate.mockRestore();
    create.mockRestore();
    findOne.mockRestore();
  });

  test('returns only the highest call-scoped revision in deterministic order with a 512 cap', async () => {
    const find = jest.spyOn(ViventiumVoiceSpeakerSegment, 'find').mockImplementation((query) => {
      expect(query).toMatchObject({
        callSessionId: 'call-reconnect',
        expiresAt: { $gt: expect.any(Date) },
      });
      const rows = [
        ...Array.from({ length: 520 }, (_, index) => ({
          payload: {
            version: 1,
            segmentId: `segment-${index}`,
            callSessionId: 'call-reconnect',
            turnId: `turn-${index}`,
            sequence: 519 - index,
            revision: 1,
            text: `text ${index}`,
            isFinal: true,
            speaker: {
              key: 'speaker',
              label: 'Speaker',
              source: 'unknown',
              attribution: 'unknown',
              actorTrust: 'unknown',
            },
          },
        })),
        {
          payload: {
            version: 1,
            segmentId: 'segment-0',
            callSessionId: 'call-reconnect',
            turnId: 'turn-revised',
            sequence: 519,
            revision: 3,
            text: 'latest revision',
            isFinal: true,
            speaker: {
              key: 'speaker',
              label: 'Speaker',
              source: 'unknown',
              attribution: 'unknown',
              actorTrust: 'unknown',
            },
          },
        },
        { payload: { version: 1, segmentId: 'foreign', callSessionId: 'call-other' } },
      ];
      return {
        select: () => ({ lean: async () => rows }),
      };
    });

    const result = await listSpeakerSegments({ callSessionId: 'call-reconnect', limit: 999 });

    expect(result).toHaveLength(512);
    expect(result[0].sequence).toBe(8);
    expect(result.at(-1).sequence).toBe(519);
    expect(result.find((segment) => segment.segmentId === 'segment-0')).toMatchObject({
      revision: 3,
      text: 'latest revision',
    });
    find.mockRestore();
  });

  test('paginates more than 512 segments without duplicates or lost latest revisions', async () => {
    const rows = Array.from({ length: 700 }, (_, index) => ({
      payload: {
        version: 1,
        segmentId: `segment-${index}`,
        callSessionId: 'call-page',
        turnId: `turn-${index}`,
        sequence: index,
        revision: 1,
        text: `text ${index}`,
        isFinal: true,
        speaker: {
          key: 'speaker',
          label: 'Speaker',
          source: 'unknown',
          attribution: 'unknown',
          actorTrust: 'unknown',
        },
      },
    }));
    rows.push({
      payload: { ...rows[620].payload, revision: 3, text: 'latest revision 620' },
    });
    const find = jest.spyOn(ViventiumVoiceSpeakerSegment, 'find').mockImplementation((query) => {
      expect(query.callSessionId).toBe('call-page');
      return { select: () => ({ lean: async () => rows }) };
    });

    const newest = await listSpeakerSegments({
      callSessionId: 'call-page',
      limit: 512,
      page: true,
    });
    const oldest = await listSpeakerSegments({
      callSessionId: 'call-page',
      limit: 512,
      beforeSequence: newest.nextBeforeSequence,
      page: true,
    });
    const all = [...oldest.segments, ...newest.segments];

    expect(newest).toMatchObject({ hasMore: true, nextBeforeSequence: 188 });
    expect(oldest).toMatchObject({ hasMore: false });
    expect(all).toHaveLength(700);
    expect(new Set(all.map((segment) => segment.segmentId)).size).toBe(700);
    expect(all.find((segment) => segment.segmentId === 'segment-620')).toMatchObject({
      revision: 3,
      text: 'latest revision 620',
    });
    find.mockRestore();
  });

  test('projects a late speaker downgrade into message/export metadata while retaining scalar compatibility', async () => {
    const ownerSegment = {
      version: 1,
      segmentId: 'segment-owner',
      callSessionId: 'call-project',
      turnId: 'turn-1',
      sequence: 1,
      revision: 0,
      text: 'initial owner words',
      isFinal: true,
      speaker: {
        key: 'track:owner',
        label: 'Owner',
        source: 'hybrid',
        attribution: 'verified',
        actorTrust: 'owner_participant',
      },
    };
    const downgraded = {
      ...ownerSegment,
      revision: 1,
      speaker: {
        key: 'provider:A',
        label: 'Speaker 1',
        source: 'provider_diarization',
        attribution: 'unverified',
        actorTrust: 'shared_mic_unverified',
      },
    };
    const find = jest.spyOn(Message, 'find').mockImplementation(() => ({
      select: () => ({
        lean: async () => [
          {
            _id: 'message-object-id',
            metadata: { viventium: { speakerLabel: 'Owner', speakerSegments: [ownerSegment] } },
          },
        ],
      }),
    }));
    const updateOne = jest.spyOn(Message, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await expect(
      projectSpeakerSegmentRevisionsToMessages({
        callSessionId: 'call-project',
        segments: [downgraded],
      }),
    ).resolves.toEqual({ matched: 1, updated: 1 });
    expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'message-object-id' }), {
      $set: {
        'metadata.viventium.speakerSegments': [downgraded],
        'metadata.viventium.speakerLabel': 'Speaker 1',
      },
    });
    expect(updateOne.mock.calls[0][1].$set['metadata.viventium.speakerLabel']).toBeTruthy();
    find.mockRestore();
    updateOne.mockRestore();
  });

  test('persists a monotonic shared-mic session tombstone that can never revert', async () => {
    let stored = {
      callSessionId: 'call-tombstone',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      speakerSessionRevision: 0,
      speakerAttributionState: 'single_speaker',
      speakerDetectedAt: new Date('2026-08-09T10:00:00.000Z'),
      speakerSourceTrackSid: 'track-owner',
    };
    const findOne = jest.spyOn(ViventiumCallSession, 'findOne').mockImplementation(() => ({
      lean: async () => ({ ...stored }),
    }));
    const findOneAndUpdate = jest
      .spyOn(ViventiumCallSession, 'findOneAndUpdate')
      .mockImplementation((query, update) => ({
        lean: async () => {
          if (
            stored.speakerAttributionState === 'shared_mic_unverified' &&
            update.$set.speakerAttributionState !== 'shared_mic_unverified'
          ) {
            return null;
          }
          if (Number(stored.speakerSessionRevision) >= Number(update.$set.speakerSessionRevision)) {
            return null;
          }
          stored = { ...stored, ...update.$set };
          return { ...stored };
        },
      }));

    const shared = await persistSpeakerSessionState({
      callSessionId: 'call-tombstone',
      state: {
        version: 1,
        callSessionId: 'spoofed-call',
        revision: 1,
        attributionState: 'shared_mic_unverified',
        detectedAt: '2026-08-09T10:01:00.000Z',
        sourceTrackSid: 'track-owner',
      },
    });
    const staleReplay = await persistSpeakerSessionState({
      callSessionId: 'call-tombstone',
      state: {
        version: 1,
        callSessionId: 'call-tombstone',
        revision: 0,
        attributionState: 'single_speaker',
        detectedAt: '2026-08-09T10:00:00.000Z',
      },
    });
    const attemptedRevert = await persistSpeakerSessionState({
      callSessionId: 'call-tombstone',
      state: {
        version: 1,
        callSessionId: 'call-tombstone',
        revision: 2,
        attributionState: 'single_speaker',
        detectedAt: '2026-08-09T10:02:00.000Z',
      },
    });

    expect(shared).toMatchObject({
      accepted: true,
      state: { revision: 1, attributionState: 'shared_mic_unverified' },
    });
    expect(staleReplay).toMatchObject({
      accepted: false,
      state: { revision: 1, attributionState: 'shared_mic_unverified' },
    });
    expect(attemptedRevert).toMatchObject({
      accepted: false,
      state: { revision: 1, attributionState: 'shared_mic_unverified' },
    });
    expect(stored.speakerAttributionState).toBe('shared_mic_unverified');
    findOne.mockRestore();
    findOneAndUpdate.mockRestore();
  });
});
