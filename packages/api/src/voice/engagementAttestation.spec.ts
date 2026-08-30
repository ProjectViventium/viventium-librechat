import crypto from 'node:crypto';
import { createVoiceEngagementAttestationService } from './engagementAttestation';

describe('voice engagement attestation', () => {
  const nowMs = 1_787_659_200_000;
  const utterance = 'Please launch the requested worker.';

  function service(transportSecret = 'configured') {
    return createVoiceEngagementAttestationService({
      getTransportSecret: () => transportSecret,
      signingKey: Buffer.alloc(32, 7),
    });
  }

  function signed(directlyAddressed = true) {
    return service().createVoiceEngagementAttestation({
      callSessionId: 'call_owner_1',
      turnId: 'turn_000004',
      participantIdentity: 'owner-participant',
      segmentIds: ['segment_000004'],
      directlyAddressed,
      revision: 2,
      utterance,
      nowMs,
    });
  }

  test('returns exactly the 11-field, 30-second, base64url SHA-256 contract', () => {
    const attestation = signed();

    expect(Object.keys(attestation).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(attestation.expiresAtMs - attestation.issuedAtMs).toBe(30_000);
    expect(attestation.attestation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      service().verifyVoiceEngagementAttestation(attestation, { nowMs: nowMs + 1, utterance }),
    ).toBe(true);
  });

  test('authenticates both positive and negative semantic verdicts', () => {
    const verifier = service();
    for (const directlyAddressed of [true, false]) {
      const attestation = signed(directlyAddressed);
      expect(
        verifier.verifyVoiceEngagementAttestation(attestation, {
          nowMs: nowMs + 1,
          utterance,
        }),
      ).toBe(true);
    }
  });

  test('rejects any changed authority field, utterance, or expiry', () => {
    const verifier = service();
    const attestation = signed();
    for (const forged of [
      { ...attestation, callSessionId: 'another-call' },
      { ...attestation, turnId: 'another-turn' },
      { ...attestation, participantIdentity: 'guest' },
      { ...attestation, segmentIds: ['another-segment'] },
      { ...attestation, directlyAddressed: false },
      { ...attestation, source: 'browser' },
      { ...attestation, revision: 3 },
      { ...attestation, attestation: '*'.repeat(43) },
    ]) {
      expect(
        verifier.verifyVoiceEngagementAttestation(forged, { nowMs: nowMs + 1, utterance }),
      ).toBe(false);
    }
    expect(
      verifier.verifyVoiceEngagementAttestation(attestation, {
        nowMs: attestation.expiresAtMs,
        utterance,
      }),
    ).toBe(false);
    expect(
      verifier.verifyVoiceEngagementAttestation(attestation, {
        nowMs: nowMs + 1,
        utterance: 'Create an unrelated external reminder.',
      }),
    ).toBe(false);
  });

  test('does not use the gateway transport secret as its signing key', () => {
    const attestation = signed(false);
    const forged = { ...attestation, directlyAddressed: true };
    const utteranceDigest = crypto.createHash('sha256').update(utterance).digest('base64url');
    forged.attestation = crypto
      .createHmac('sha256', 'configured')
      .update(
        JSON.stringify([
          forged.version,
          forged.callSessionId,
          forged.turnId,
          forged.participantIdentity,
          forged.segmentIds,
          forged.directlyAddressed,
          forged.source,
          forged.revision,
          forged.issuedAtMs,
          forged.expiresAtMs,
          utteranceDigest,
        ]),
      )
      .digest('base64url');

    expect(
      service().verifyVoiceEngagementAttestation(forged, { nowMs: nowMs + 1, utterance }),
    ).toBe(false);
  });

  test('fails closed when the Core transport secret is not configured', () => {
    expect(() => service('').createVoiceEngagementAttestation({})).toThrow(
      'A complete trusted voice-engagement decision is required',
    );
    expect(service('').verifyVoiceEngagementAttestation(signed(), { nowMs, utterance })).toBe(
      false,
    );
  });
});
