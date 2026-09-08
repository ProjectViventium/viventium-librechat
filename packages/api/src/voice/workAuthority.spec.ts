import {
  createVoiceEngagementAuthorityService,
  createVoiceWorkAuthorityBinding,
} from './engagementAuthority';

const session = {
  callSessionId: 'call-1',
  userId: 'owner-1',
  ownerParticipantIdentity: 'owner',
  mode: 'call',
  status: 'active',
  revision: 1,
  speakerSessionRevision: 2,
};
const segment = {
  segmentId: 'segment-1',
  turnId: 'turn-1',
  revision: 1,
  isFinal: true,
  speaker: {
    participantIdentity: 'owner',
    attribution: 'verified',
    actorTrust: 'owner_participant',
  },
};
function setup(current = session, segments = [segment]) {
  const deps = {
    getCallSession: jest.fn(async () => current),
    listSpeakerSegments: jest.fn(async () => segments),
    voiceTurnAuthority: jest.fn(),
    verifyVoiceEngagementAttestation: jest.fn(),
  };
  return { ...createVoiceEngagementAuthorityService(deps), deps };
}
const binding = () => createVoiceWorkAuthorityBinding({ session, segments: [segment] })!;

test('retains trusted voice authority and contains no utterance or raw speaker identity', async () => {
  await expect(setup().assertVoiceWorkAuthority(binding(), 'owner-1')).resolves.toBeUndefined();
  expect(JSON.stringify(binding())).not.toContain('participantIdentity');
  expect(JSON.stringify(binding())).not.toContain('speaker');
});

test.each([
  { mode: 'listen_only' },
  { mode: 'wing' },
  { status: 'ended' },
  { status: 'failed' },
  { revision: 2 },
  { speakerSessionRevision: 3 },
  { ownerParticipantIdentity: 'replacement' },
  { userId: 'other-owner' },
  { callSessionId: 'other-call' },
])('rejects changed current call authority: %j', async (change) => {
  await expect(
    setup({ ...session, ...change }).assertVoiceWorkAuthority(binding(), 'owner-1'),
  ).rejects.toMatchObject({ code: 'voice_work_authority_stale', status: 409, retryable: false });
});

test('rejects revised or missing accepted audio, but does not bind unrelated audio', async () => {
  await expect(
    setup(session, [{ ...segment, revision: 2 }]).assertVoiceWorkAuthority(binding(), 'owner-1'),
  ).rejects.toMatchObject({ code: 'voice_work_authority_stale' });
  await expect(setup(session, []).assertVoiceWorkAuthority(binding(), 'owner-1')).rejects.toThrow();
  await expect(
    setup(session, [
      segment,
      { ...segment, segmentId: 'segment-2', turnId: 'turn-2' },
    ]).assertVoiceWorkAuthority(binding(), 'owner-1'),
  ).resolves.toBeUndefined();
});

test('rejects missing, wrong-owner and expired Wing authority', async () => {
  const wing = { ...session, mode: 'wing' };
  const old = createVoiceWorkAuthorityBinding({
    session: wing,
    segments: [segment],
    engagement: { expiresAtMs: Date.now() - 1 },
  })!;
  await expect(setup(wing).assertVoiceWorkAuthority(old, 'owner-1')).rejects.toThrow();
  await expect(setup().assertVoiceWorkAuthority(undefined, 'owner-1')).rejects.toThrow();
  await expect(setup().assertVoiceWorkAuthority(binding(), 'other-owner')).rejects.toThrow();
});

test('preserves authorized participant text without fabricating audio evidence', async () => {
  const typed = createVoiceWorkAuthorityBinding({ session, segments: [], typedInput: true })!;
  const service = setup();
  await expect(service.assertVoiceWorkAuthority(typed, 'owner-1')).resolves.toBeUndefined();
  expect(service.deps.listSpeakerSegments).not.toHaveBeenCalled();
  await expect(
    setup({ ...session, revision: 2 }).assertVoiceWorkAuthority(typed, 'owner-1'),
  ).rejects.toThrow();
});
