/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { agentSchema } = require('@librechat/data-schemas');

const {
  abandonVoiceSessionClaim,
  compactVoiceRouteState,
  createCallSession,
  createCallBrowserLaunch,
  exchangeCallBrowserLaunch,
  getCallSession,
  getCallSessionVoiceSettings,
  heartbeatCallSession,
  markVoiceSessionReady,
  reportVoiceSessionFailure,
  resolveUserVoiceRoute,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
  claimOrReplaceCallSessionConversationId,
  updateCallSessionConversationId,
  claimVoiceSession,
  claimDispatch,
  confirmDispatch,
  getDispatchStatus,
  assertVoiceGatewayAuth,
  assertCallBrowserCapability,
} = require('../CallSessionService');
const { persistSpeakerSessionState } = require('../SpeakerSegmentService');

describe('CallSessionService', () => {
  let mongoServer;
  let ViventiumCallSession;
  let ViventiumVoiceSpeakerSegment;
  let User;
  let Agent;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ ViventiumCallSession, ViventiumVoiceSpeakerSegment, User } = require('~/db/models'));
    Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'secret';
    process.env.VIVENTIUM_WING_MODE_DEFAULT_ENABLED = 'false';
    process.env.VIVENTIUM_SHADOW_MODE_DEFAULT_ENABLED = 'false';
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = 'anthropic';
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = 'claude-opus-5';
    delete process.env.OPENAI_API_KEY;
    process.env.VIVENTIUM_STT_PROVIDER = 'assemblyai';
    delete process.env.VIVENTIUM_STT_MODEL;
    delete process.env.STT_PROVIDER;
    delete process.env.LOCAL_WHISPER_MODEL_NAME;
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
    await ViventiumCallSession.deleteMany({});
    await ViventiumVoiceSpeakerSegment.deleteMany({});
    await User.deleteMany({});
    await Agent.deleteMany({});
  });

  test('createCallSession persists and getCallSession returns it', async () => {
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'configured-voice-gateway';
    const user = await User.create({
      name: 'Call User',
      email: 'call-user@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    expect(created.callSessionId).toBeDefined();
    expect(created.roomName).toBeDefined();
    expect(created.gatewayAgentName).toBe('configured-voice-gateway');
    expect(created.ownerParticipantIdentity).toMatch(/^owner-[a-f0-9-]{36}$/);
    expect(created.browserCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const persisted = await ViventiumCallSession.findOne({
      callSessionId: created.callSessionId,
    })
      .select(
        '+browserCapabilityHash +browserCapabilityExpiresAt +browserCapabilityVersion +browserCapabilityScope',
      )
      .lean();
    expect(persisted.browserCapabilityHash).toBe(
      crypto.createHash('sha256').update(created.browserCapability).digest('hex'),
    );
    expect(JSON.stringify(persisted)).not.toContain(created.browserCapability);
    expect(persisted.browserCapabilityVersion).toBe(1);
    expect(persisted.browserCapabilityScope).toBe('call_browser_v1');

    const fetched = await getCallSession(created.callSessionId);
    expect(fetched).toMatchObject({
      callSessionId: created.callSessionId,
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
      roomName: created.roomName,
      gatewayAgentName: 'configured-voice-gateway',
      ownerParticipantIdentity: created.ownerParticipantIdentity,
    });
    expect(fetched).not.toHaveProperty('browserCapability');
    expect(fetched).not.toHaveProperty('browserCapabilityHash');
  });

  test('dual-reads scoped track state while preserving legacy scalar fail-closed state', async () => {
    const user = await User.create({
      name: 'Speaker State User',
      email: 'speaker-state@example.com',
      provider: 'local',
    });
    const scoped = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_scoped',
      conversationId: 'new',
    });
    await ViventiumCallSession.updateOne(
      { callSessionId: scoped.callSessionId },
      {
        $set: {
          speakerSessionRevision: 1,
          speakerAttributionState: 'shared_mic_unverified',
          speakerDetectedAt: new Date('2026-08-09T10:01:00.000Z'),
          speakerSourceTrackSid: 'guest-track',
          speakerSharedTrackSids: ['guest-track'],
          speakerSourceParticipantIdentity: 'guest',
          speakerSharedParticipantIdentities: ['guest'],
        },
      },
    );

    const restoredScoped = await getCallSession(scoped.callSessionId);
    expect(restoredScoped.sharedTrackSids).toEqual(['guest-track']);
    expect(restoredScoped.sharedParticipantIdentities).toEqual(['guest']);
    expect(restoredScoped.speakerSessionState).toMatchObject({
      attributionState: 'shared_mic_unverified',
      sharedTrackSids: ['guest-track'],
      sharedParticipantIdentities: ['guest'],
    });

    const legacy = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_legacy',
      conversationId: 'new',
    });
    await ViventiumCallSession.updateOne(
      { callSessionId: legacy.callSessionId },
      {
        $set: {
          speakerSessionRevision: 4,
          speakerAttributionState: 'shared_mic_unverified',
          speakerDetectedAt: new Date('2026-08-09T10:02:00.000Z'),
          speakerSourceTrackSid: 'legacy-track',
        },
        $unset: {
          speakerSharedTrackSids: '',
          speakerSharedParticipantIdentities: '',
        },
      },
    );

    const restoredLegacy = await getCallSession(legacy.callSessionId);
    expect(restoredLegacy.sharedTrackSids).toBeNull();
    expect(restoredLegacy.speakerSessionState).toMatchObject({
      attributionState: 'shared_mic_unverified',
      sourceTrackSid: 'legacy-track',
    });
    expect(restoredLegacy.speakerSessionState).not.toHaveProperty('sharedTrackSids');
  });

  test('atomically unions shared participant identities and survives track replacement', async () => {
    const user = await User.create({
      name: 'Shared Track Union User',
      email: 'shared-track-union@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_union',
      conversationId: 'new',
    });
    const stateFor = (trackSid, participantIdentity) => ({
      version: 1,
      callSessionId: created.callSessionId,
      revision: 1,
      attributionState: 'shared_mic_unverified',
      detectedAt: '2026-08-09T10:01:00.000Z',
      sourceTrackSid: trackSid,
      sharedTrackSids: [trackSid],
      sourceParticipantIdentity: participantIdentity,
      sharedParticipantIdentities: [participantIdentity],
    });

    const [first, second] = await Promise.all([
      persistSpeakerSessionState({
        callSessionId: created.callSessionId,
        state: stateFor('guest-track-1', 'guest-1'),
      }),
      persistSpeakerSessionState({
        callSessionId: created.callSessionId,
        state: stateFor('guest-track-2', 'guest-2'),
      }),
    ]);
    const replay = await persistSpeakerSessionState({
      callSessionId: created.callSessionId,
      state: stateFor('guest-track-reconnected', 'guest-1'),
    });
    const restored = await getCallSession(created.callSessionId);

    expect([first.accepted, second.accepted].filter(Boolean)).toHaveLength(2);
    expect(replay.accepted).toBe(false);
    expect(restored.speakerSessionRevision).toBe(1);
    expect(restored.sharedTrackSids).toEqual(['guest-track-1', 'guest-track-2']);
    expect(restored.speakerSessionState.sharedTrackSids).toEqual([
      'guest-track-1',
      'guest-track-2',
    ]);
    expect(restored.sharedParticipantIdentities).toEqual(['guest-1', 'guest-2']);
    expect(restored.speakerSessionState.sharedParticipantIdentities).toEqual([
      'guest-1',
      'guest-2',
    ]);
  });

  test('browser capability is exact-session scoped and ended/expired sessions fail terminally', async () => {
    const user = await User.create({
      name: 'Browser Capability User',
      email: 'browser-capability@example.com',
      provider: 'local',
    });
    const first = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const second = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    await expect(
      assertCallBrowserCapability(first.callSessionId, first.browserCapability),
    ).resolves.toMatchObject({ callSessionId: first.callSessionId, userId: user._id.toString() });
    await expect(
      assertCallBrowserCapability(first.callSessionId, second.browserCapability),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      assertCallBrowserCapability(first.callSessionId, 'A'.repeat(43)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(assertCallBrowserCapability(first.callSessionId, '')).rejects.toMatchObject({
      status: 401,
    });

    for (const mutation of [
      { $set: { browserCapabilityVersion: 2 } },
      { $unset: { browserCapabilityVersion: 1 } },
      { $set: { browserCapabilityScope: 'different_scope' } },
      { $unset: { browserCapabilityScope: 1 } },
    ]) {
      await ViventiumCallSession.updateOne({ callSessionId: first.callSessionId }, mutation);
      await expect(
        assertCallBrowserCapability(first.callSessionId, first.browserCapability),
      ).rejects.toMatchObject({ status: 410 });
      await ViventiumCallSession.updateOne(
        { callSessionId: first.callSessionId },
        { $set: { browserCapabilityVersion: 1, browserCapabilityScope: 'call_browser_v1' } },
      );
    }

    await ViventiumCallSession.updateOne(
      { callSessionId: first.callSessionId },
      { $set: { callStatus: 'ended' } },
    );
    await expect(
      assertCallBrowserCapability(first.callSessionId, first.browserCapability),
    ).rejects.toMatchObject({ status: 410 });

    await ViventiumCallSession.updateOne(
      { callSessionId: second.callSessionId },
      { $set: { browserCapabilityExpiresAt: new Date(Date.now() - 1) } },
    );
    await expect(
      assertCallBrowserCapability(second.callSessionId, second.browserCapability),
    ).rejects.toMatchObject({ status: 410 });
  });

  test('exchanges a Telegram launch bearer once, rotates browser authority, and stores only hashes', async () => {
    const user = await User.create({
      name: 'Telegram Launch User',
      email: 'telegram-launch@example.com',
      provider: 'local',
    });
    const first = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const second = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const launch = await createCallBrowserLaunch(first.callSessionId);
    const idempotencyCapability = 'I'.repeat(43);
    expect(launch.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const storedLaunch = await ViventiumCallSession.findOne({
      callSessionId: first.callSessionId,
    })
      .select(
        '+browserLaunchCapabilityHash +browserLaunchCapabilityExpiresAt +browserLaunchCapabilityVersion +browserLaunchCapabilityScope +browserLaunchCapabilityUsedAt',
      )
      .lean();
    expect(storedLaunch.browserLaunchCapabilityHash).toBe(
      crypto.createHash('sha256').update(launch.capability).digest('hex'),
    );
    expect(storedLaunch.browserLaunchCapabilityVersion).toBe(1);
    expect(storedLaunch.browserLaunchCapabilityScope).toBe('call_browser_launch_v1');
    expect(storedLaunch.browserLaunchCapabilityUsedAt).toBeNull();
    expect(JSON.stringify(storedLaunch)).not.toContain(launch.capability);

    await expect(
      exchangeCallBrowserLaunch(second.callSessionId, launch.capability, idempotencyCapability),
    ).rejects.toMatchObject({ status: 410 });
    const exchanged = await exchangeCallBrowserLaunch(
      first.callSessionId,
      launch.capability,
      idempotencyCapability,
    );
    expect(exchanged.browserCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanged.browserCapability).not.toBe(first.browserCapability);
    await expect(
      assertCallBrowserCapability(first.callSessionId, first.browserCapability),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      assertCallBrowserCapability(first.callSessionId, exchanged.browserCapability),
    ).resolves.toMatchObject({ callSessionId: first.callSessionId });
    await expect(
      exchangeCallBrowserLaunch(first.callSessionId, launch.capability, idempotencyCapability),
    ).resolves.toMatchObject({ browserCapability: exchanged.browserCapability });
    await expect(
      exchangeCallBrowserLaunch(first.callSessionId, launch.capability, 'J'.repeat(43)),
    ).rejects.toMatchObject({ status: 410 });
  });

  test('atomically permits only one launch exchange and rejects expired or ended sessions', async () => {
    const user = await User.create({
      name: 'Atomic Telegram Launch User',
      email: 'atomic-telegram-launch@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const launch = await createCallBrowserLaunch(created.callSessionId);
    const idempotencyCapability = 'I'.repeat(43);
    const outcomes = await Promise.allSettled([
      exchangeCallBrowserLaunch(created.callSessionId, launch.capability, idempotencyCapability),
      exchangeCallBrowserLaunch(created.callSessionId, launch.capability, idempotencyCapability),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    const capabilities = outcomes
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value.browserCapability);
    expect(new Set(capabilities).size).toBe(1);

    const expired = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const expiredLaunch = await createCallBrowserLaunch(expired.callSessionId);
    await ViventiumCallSession.updateOne(
      { callSessionId: expired.callSessionId },
      { $set: { browserLaunchCapabilityExpiresAt: new Date(Date.now() - 1) } },
    );
    await expect(
      exchangeCallBrowserLaunch(
        expired.callSessionId,
        expiredLaunch.capability,
        idempotencyCapability,
      ),
    ).rejects.toMatchObject({ status: 410 });

    const ended = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const endedLaunch = await createCallBrowserLaunch(ended.callSessionId);
    await ViventiumCallSession.updateOne(
      { callSessionId: ended.callSessionId },
      { $set: { callStatus: 'ended' } },
    );
    await expect(
      exchangeCallBrowserLaunch(ended.callSessionId, endedLaunch.capability, idempotencyCapability),
    ).rejects.toMatchObject({ status: 410 });
  });

  test('createCallSession ignores browser-supplied route and persists the configured user route', async () => {
    process.env.VIVENTIUM_STT_PROVIDER = 'assemblyai';
    process.env.VIVENTIUM_TTS_PROVIDER = 'openai';
    const user = await User.create({
      name: 'Canonical Route User',
      email: 'canonical-route@example.com',
      provider: 'local',
      viventiumVoicePreferences: {
        livekitPlayground: {
          stt: { provider: 'pywhispercpp', variant: 'small' },
          tts: { provider: 'cartesia', variant: 'sonic-3' },
        },
      },
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_route',
      conversationId: 'new',
      requestedVoiceRoute: {
        stt: { provider: 'attacker-stt', variant: 'override' },
        tts: { provider: 'attacker-tts', variant: 'override' },
      },
    });

    expect(created.requestedVoiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'small' },
      tts: { provider: 'cartesia', variant: 'sonic-3' },
    });
  });

  test('createCallSession fails with no_route before persistence when STT or TTS is unconfigured', async () => {
    delete process.env.VIVENTIUM_STT_PROVIDER;
    delete process.env.STT_PROVIDER;
    const user = await User.create({
      name: 'Unconfigured Voice Route',
      email: 'no-voice-route@example.com',
      provider: 'local',
    });

    await expect(
      createCallSession({
        userId: user._id.toString(),
        agentId: 'agent_1',
        conversationId: 'new',
      }),
    ).rejects.toMatchObject({
      code: 'no_route',
      status: 400,
      retryable: false,
    });
    await expect(ViventiumCallSession.countDocuments({})).resolves.toBe(0);
  });

  test('getCallSession returns null for expired sessions', async () => {
    await ViventiumCallSession.create({
      callSessionId: 'expired',
      userId: 'user_1',
      agentId: 'agent_1',
      conversationId: 'new',
      roomName: 'lc-expired',
      expiresAt: new Date(Date.now() - 1000),
    });

    const fetched = await getCallSession('expired');
    expect(fetched).toBeNull();
  });

  test('updateCallSessionConversationId updates the stored session', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'call-user-update@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const updated = await updateCallSessionConversationId(created.callSessionId, 'convo_123');
    expect(updated.conversationId).toBe('convo_123');
  });

  test('claimOrReplaceCallSessionConversationId atomically replaces only the expected stale id', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'call-user-claim@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'stale-provider-convo',
    });

    const claimed = await claimOrReplaceCallSessionConversationId(
      created.callSessionId,
      'fresh-listen-only-convo',
      { expectedConversationId: 'stale-provider-convo' },
    );
    const losingClaim = await claimOrReplaceCallSessionConversationId(
      created.callSessionId,
      'split-convo',
      { expectedConversationId: 'stale-provider-convo' },
    );

    expect(claimed.conversationId).toBe('fresh-listen-only-convo');
    expect(losingClaim.conversationId).toBe('fresh-listen-only-convo');
    const fetched = await getCallSession(created.callSessionId);
    expect(fetched.conversationId).toBe('fresh-listen-only-convo');
  });

  test('createCallSession always starts in Call even when a legacy Wing default remains configured', async () => {
    process.env.VIVENTIUM_WING_MODE_DEFAULT_ENABLED = 'true';
    const user = await User.create({
      name: 'Call User',
      email: 'wing-default@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    expect(created).toMatchObject({
      mode: 'call',
      wingModeEnabled: false,
      shadowModeEnabled: false,
      listenOnlyModeEnabled: false,
    });
  });

  test('syncCallSessionState refreshes ttl and keeps wing aliases aligned', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'sync-state@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    // The service uses millisecond timestamps; keep this assertion stable on fast CI workers.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: true,
      wingModeEnabled: true,
    });

    expect(updated.expiresAtMs).toBeGreaterThan(created.expiresAtMs);
    expect(updated.wingModeEnabled).toBe(true);
    expect(updated.shadowModeEnabled).toBe(true);
  });

  test('syncCallSessionState makes Listen-Only mutually exclusive with Wing Mode', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'listen-only-state@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const listenOnly = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: true,
      listenOnlyModeEnabled: true,
    });

    expect(listenOnly.listenOnlyModeEnabled).toBe(true);
    expect(listenOnly.wingModeEnabled).toBe(false);
    expect(listenOnly.shadowModeEnabled).toBe(false);

    const wingMode = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: true,
      wingModeEnabled: true,
    });

    expect(wingMode.listenOnlyModeEnabled).toBe(false);
    expect(wingMode.wingModeEnabled).toBe(true);
    expect(wingMode.shadowModeEnabled).toBe(true);
  });

  test('VoiceCallStateV1 exposes one canonical mode while preserving legacy booleans', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'voice-state-v1@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    expect(created).toMatchObject({
      version: 1,
      mode: 'call',
      status: 'created',
      wingModeEnabled: false,
      listenOnlyModeEnabled: false,
    });

    const wing = await syncCallSessionState({
      callSessionId: created.callSessionId,
      mode: 'wing',
    });
    expect(wing).toMatchObject({
      version: 1,
      mode: 'wing',
      wingModeEnabled: true,
      listenOnlyModeEnabled: false,
    });

    const listenOnly = await syncCallSessionState({
      callSessionId: created.callSessionId,
      mode: 'listen_only',
    });
    expect(listenOnly).toMatchObject({
      version: 1,
      mode: 'listen_only',
      wingModeEnabled: false,
      listenOnlyModeEnabled: true,
    });
  });

  test('ended status is terminal against delayed keepalive and mode packets', async () => {
    const user = await User.create({
      name: 'Terminal Call User',
      email: 'terminal-call@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const ended = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: false,
      status: 'ended',
    });
    const delayed = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: true,
      status: 'listening',
      mode: 'wing',
    });

    expect(ended.status).toBe('ended');
    expect(delayed).toMatchObject({ status: 'ended', mode: 'call' });
    expect(delayed.expiresAtMs).toBe(ended.expiresAtMs);
  });

  test('ended calls retain speaker evidence through the next daily memory hardener run', async () => {
    const user = await User.create({
      name: 'Post-call Evidence User',
      email: 'post-call-evidence@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await ViventiumVoiceSpeakerSegment.create({
      callSessionId: created.callSessionId,
      segmentId: 'segment-post-call-evidence',
      revision: 0,
      payload: { segmentId: 'segment-post-call-evidence' },
      expiresAt: new Date(created.expiresAtMs),
    });
    const endedAtMs = Date.now();

    const ended = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: false,
      nowMs: endedAtMs,
      status: 'ended',
    });
    const segment = await ViventiumVoiceSpeakerSegment.findOne({
      callSessionId: created.callSessionId,
      segmentId: 'segment-post-call-evidence',
    }).lean();

    expect(ended.expiresAtMs).toBeGreaterThanOrEqual(endedAtMs + 34 * 24 * 60 * 60 * 1000);
    expect(segment.expiresAt.getTime()).toBe(ended.expiresAtMs);
  });

  test('keepalives extend speaker segments and ended retains them only for post-call hardening', async () => {
    const user = await User.create({
      name: 'Long Call User',
      email: 'long-call@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const startMs = created.createdAtMs;
    await ViventiumVoiceSpeakerSegment.create({
      callSessionId: created.callSessionId,
      segmentId: 'early-segment',
      revision: 0,
      payload: {
        version: 1,
        segmentId: 'early-segment',
        callSessionId: created.callSessionId,
      },
      expiresAt: new Date(startMs + 11 * 60 * 1000),
    });

    const first = await syncCallSessionState({
      callSessionId: created.callSessionId,
      nowMs: startMs + 10 * 60 * 1000,
      status: 'listening',
    });
    const frequent = await syncCallSessionState({
      callSessionId: created.callSessionId,
      nowMs: startMs + 10.5 * 60 * 1000,
      status: 'listening',
    });
    const afterFrequentKeepalive = await ViventiumVoiceSpeakerSegment.findOne({
      callSessionId: created.callSessionId,
      segmentId: 'early-segment',
    }).lean();
    expect(frequent.expiresAtMs).toBe(startMs + 25.5 * 60 * 1000);
    expect(new Date(afterFrequentKeepalive.expiresAt).getTime()).toBe(first.expiresAtMs);
    const second = await syncCallSessionState({
      callSessionId: created.callSessionId,
      nowMs: startMs + 20 * 60 * 1000,
      status: 'listening',
    });
    const afterKeepalives = await ViventiumVoiceSpeakerSegment.findOne({
      callSessionId: created.callSessionId,
      segmentId: 'early-segment',
    }).lean();
    expect(first.expiresAtMs).toBe(startMs + 25 * 60 * 1000);
    expect(second.expiresAtMs).toBe(startMs + 35 * 60 * 1000);
    expect(new Date(afterKeepalives.expiresAt).getTime()).toBe(second.expiresAtMs);

    const ended = await syncCallSessionState({
      callSessionId: created.callSessionId,
      nowMs: startMs + 21 * 60 * 1000,
      touch: false,
      status: 'ended',
    });
    const delayed = await syncCallSessionState({
      callSessionId: created.callSessionId,
      nowMs: startMs + 22 * 60 * 1000,
      status: 'listening',
    });
    const terminalSegment = await ViventiumVoiceSpeakerSegment.findOne({
      callSessionId: created.callSessionId,
      segmentId: 'early-segment',
    }).lean();
    expect(ended.status).toBe('ended');
    expect(delayed.status).toBe('ended');
    expect(new Date(terminalSegment.expiresAt).getTime()).toBe(ended.expiresAtMs);
    expect(
      await ViventiumVoiceSpeakerSegment.exists({
        callSessionId: created.callSessionId,
        expiresAt: { $gt: new Date(second.expiresAtMs + 1) },
      }),
    ).not.toBeNull();
  });

  test('low-write heartbeat sustains a 120-minute silent call and its early speaker ledger', async () => {
    const user = await User.create({
      name: 'Silent Soak User',
      email: 'silent-soak@example.com',
      provider: 'local',
    });
    let current = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const browserCapability = current.browserCapability;
    const startMs = current.createdAtMs;
    await ViventiumVoiceSpeakerSegment.create({
      callSessionId: current.callSessionId,
      segmentId: 'silent-soak-early',
      revision: 0,
      payload: { version: 1, segmentId: 'silent-soak-early', callSessionId: current.callSessionId },
      expiresAt: new Date(current.expiresAtMs),
    });
    const sessionWrite = jest.spyOn(ViventiumCallSession, 'findOneAndUpdate');
    const ledgerWrite = jest.spyOn(ViventiumVoiceSpeakerSegment, 'updateMany');

    for (let minute = 1; minute <= 120; minute += 1) {
      current = await heartbeatCallSession({
        callSessionId: current.callSessionId,
        currentSession: current,
        nowMs: startMs + minute * 60 * 1000,
      });
      expect(current).not.toBeNull();
    }

    const heartbeatWrites = sessionWrite.mock.calls.length;
    expect(heartbeatWrites).toBeGreaterThan(0);
    expect(heartbeatWrites).toBeLessThanOrEqual(16);
    expect(ledgerWrite.mock.calls.length).toBe(heartbeatWrites);
    const early = await ViventiumVoiceSpeakerSegment.findOne({
      callSessionId: current.callSessionId,
      segmentId: 'silent-soak-early',
    }).lean();
    expect(new Date(early.expiresAt).getTime()).toBe(current.expiresAtMs);
    expect(current.expiresAtMs).toBeGreaterThan(startMs + 120 * 60 * 1000);
    const capabilityRow = await ViventiumCallSession.findOne({
      callSessionId: current.callSessionId,
    })
      .select('+browserCapabilityExpiresAt')
      .lean();
    expect(new Date(capabilityRow.browserCapabilityExpiresAt).getTime()).toBe(current.expiresAtMs);
    await expect(
      assertCallBrowserCapability(current.callSessionId, browserCapability),
    ).resolves.toMatchObject({ callSessionId: current.callSessionId });

    const ended = await syncCallSessionState({
      callSessionId: current.callSessionId,
      nowMs: startMs + 120 * 60 * 1000,
      touch: false,
      status: 'ended',
    });
    const writesAfterEnd = sessionWrite.mock.calls.length;
    const afterEnd = await heartbeatCallSession({
      callSessionId: current.callSessionId,
      currentSession: ended,
      nowMs: startMs + 121 * 60 * 1000,
    });
    expect(afterEnd.status).toBe('ended');
    await expect(
      assertCallBrowserCapability(current.callSessionId, browserCapability),
    ).rejects.toMatchObject({ status: 410 });
    expect(sessionWrite.mock.calls.length).toBe(writesAfterEnd);
    sessionWrite.mockRestore();
    ledgerWrite.mockRestore();
  });

  test('claimVoiceSession enforces single active job', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'claim-voice@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const claimed = await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_1',
      workerId: 'worker_a',
      leaseDurationMs: 1000,
    });
    expect(claimed.activeJobId).toBe('job_1');

    const rejected = await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_2',
      workerId: 'worker_b',
      leaseDurationMs: 1000,
    });
    expect(rejected).toBeNull();
  });

  test('abandons only the exact active job and worker so another gateway can claim immediately', async () => {
    const user = await User.create({
      name: 'Abandon Claim User',
      email: 'abandon-claim@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_owner',
      workerId: 'worker_owner',
      leaseDurationMs: 60000,
    });

    await expect(
      abandonVoiceSessionClaim({
        callSessionId: created.callSessionId,
        jobId: 'job_wrong',
        workerId: 'worker_owner',
      }),
    ).resolves.toBe(false);
    await expect(
      abandonVoiceSessionClaim({
        callSessionId: created.callSessionId,
        jobId: 'job_owner',
        workerId: 'worker_wrong',
      }),
    ).resolves.toBe(false);
    expect((await getCallSession(created.callSessionId)).activeJobId).toBe('job_owner');

    await expect(
      abandonVoiceSessionClaim({
        callSessionId: created.callSessionId,
        jobId: 'job_owner',
        workerId: 'worker_owner',
      }),
    ).resolves.toBe(true);
    await expect(
      abandonVoiceSessionClaim({
        callSessionId: created.callSessionId,
        jobId: 'job_owner',
        workerId: 'worker_owner',
      }),
    ).resolves.toBe(false);
    await expect(
      claimVoiceSession({
        callSessionId: created.callSessionId,
        jobId: 'job_replacement',
        workerId: 'worker_replacement',
        leaseDurationMs: 60000,
      }),
    ).resolves.toMatchObject({
      activeJobId: 'job_replacement',
      activeWorkerId: 'worker_replacement',
    });
  });

  test('preserves a retryable failure across abandon/reclaim until the exact new owner reports ready', async () => {
    const user = await User.create({
      name: 'Provider Failure User',
      email: 'provider-failure@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_provider',
      workerId: 'worker_provider',
      leaseDurationMs: 60000,
    });

    await expect(
      reportVoiceSessionFailure({
        callSessionId: created.callSessionId,
        jobId: 'job_provider',
        workerId: 'worker_wrong',
        classification: 'provider_failure',
        modality: 'stt',
        provider: 'assemblyai',
        phase: 'initialization',
        fatal: true,
      }),
    ).resolves.toBeNull();
    const failed = await reportVoiceSessionFailure({
      callSessionId: created.callSessionId,
      jobId: 'job_provider',
      workerId: 'worker_provider',
      classification: 'provider_failure',
      modality: 'stt',
      provider: 'assemblyai',
      phase: 'initialization',
      fatal: true,
    });

    expect(failed).toMatchObject({
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
    expect(JSON.stringify(failed)).not.toContain('api_key');
    await expect(
      markVoiceSessionReady({
        callSessionId: created.callSessionId,
        jobId: 'job_provider',
        workerId: 'worker_wrong',
      }),
    ).resolves.toBeNull();
    const genericListening = await syncCallSessionState({
      callSessionId: created.callSessionId,
      status: 'listening',
      touch: false,
    });
    expect(genericListening).toMatchObject({ status: 'listening', error: failed.error });

    await abandonVoiceSessionClaim({
      callSessionId: created.callSessionId,
      jobId: 'job_provider',
      workerId: 'worker_provider',
    });
    const reclaimed = await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_recovered',
      workerId: 'worker_recovered',
      leaseDurationMs: 60000,
    });
    expect(reclaimed).toMatchObject({ status: 'listening', error: failed.error });

    const listening = await markVoiceSessionReady({
      callSessionId: created.callSessionId,
      jobId: 'job_recovered',
      workerId: 'worker_recovered',
    });
    expect(listening).toMatchObject({ status: 'listening' });
    expect(listening).not.toHaveProperty('error');
  });

  test('ready cannot clear failure or reopen an ended call', async () => {
    const user = await User.create({
      name: 'Ready Terminal User',
      email: 'ready-terminal@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_ready_terminal',
      workerId: 'worker_ready_terminal',
    });
    await syncCallSessionState({
      callSessionId: created.callSessionId,
      status: 'ended',
      touch: false,
    });

    await expect(
      markVoiceSessionReady({
        callSessionId: created.callSessionId,
        jobId: 'job_ready_terminal',
        workerId: 'worker_ready_terminal',
      }),
    ).resolves.toBeNull();
    await expect(getCallSession(created.callSessionId)).resolves.toMatchObject({ status: 'ended' });
  });

  test('provider failure reporting cannot reopen an ended call', async () => {
    const user = await User.create({
      name: 'Ended Failure User',
      email: 'ended-provider-failure@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_ended_failure',
      workerId: 'worker_ended_failure',
    });
    await syncCallSessionState({
      callSessionId: created.callSessionId,
      status: 'ended',
      touch: false,
    });

    await expect(
      reportVoiceSessionFailure({
        callSessionId: created.callSessionId,
        jobId: 'job_ended_failure',
        workerId: 'worker_ended_failure',
        classification: 'gateway_down',
        phase: 'runtime',
        fatal: true,
      }),
    ).resolves.toBeNull();
    await expect(getCallSession(created.callSessionId)).resolves.toMatchObject({ status: 'ended' });
  });

  test('ended is terminal for lease claim, gateway auth, and dispatch while remaining readable', async () => {
    const user = await User.create({
      name: 'Ended Call User',
      email: 'ended-voice@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await syncCallSessionState({
      callSessionId: created.callSessionId,
      status: 'ended',
      touch: false,
    });
    const headers = {
      'x-viventium-call-session': created.callSessionId,
      'x-viventium-call-secret': 'secret',
      'x-viventium-job-id': 'job_after_end',
      'x-viventium-worker-id': 'worker_after_end',
    };

    expect(
      await claimVoiceSession({
        callSessionId: created.callSessionId,
        jobId: 'job_after_end',
        workerId: 'worker_after_end',
      }),
    ).toBeNull();
    await expect(
      assertVoiceGatewayAuth({ get: (name) => headers[name.toLowerCase()] || '' }),
    ).rejects.toMatchObject({ status: 410, message: 'Call session has ended' });
    await expect(
      claimDispatch({
        callSessionId: created.callSessionId,
        roomName: created.roomName,
        agentName: created.gatewayAgentName,
      }),
    ).resolves.toMatchObject({ status: 'expired', session: null });
    await expect(getCallSession(created.callSessionId)).resolves.toMatchObject({ status: 'ended' });
  });

  test('gateway auth renews a two-hour five-second poll lease only near the half-life threshold', async () => {
    process.env.VIVENTIUM_CALL_SESSION_LEASE_MS = '60000';
    try {
      const user = await User.create({
        name: 'Lease Soak User',
        email: 'lease-soak@example.com',
        provider: 'local',
      });
      const created = await createCallSession({
        userId: user._id.toString(),
        agentId: 'agent_1',
        conversationId: 'new',
      });
      const startMs = created.createdAtMs;
      await ViventiumCallSession.updateOne(
        { callSessionId: created.callSessionId },
        { $set: { expiresAt: new Date(startMs + 3 * 60 * 60 * 1000) } },
      );
      await claimVoiceSession({
        callSessionId: created.callSessionId,
        jobId: 'job_soak',
        workerId: 'worker_soak',
        leaseDurationMs: 60000,
      });
      const leaseWrites = jest.spyOn(ViventiumCallSession, 'findOneAndUpdate');
      const headers = {
        'x-viventium-call-session': created.callSessionId,
        'x-viventium-call-secret': 'secret',
        'x-viventium-job-id': 'job_soak',
        'x-viventium-worker-id': 'worker_soak',
      };
      const req = { get: (name) => headers[name.toLowerCase()] || '' };

      for (let elapsedMs = 5000; elapsedMs <= 120 * 60 * 1000; elapsedMs += 5000) {
        const authed = await assertVoiceGatewayAuth(req, { nowMs: startMs + elapsedMs });
        expect(authed.activeJobId).toBe('job_soak');
      }

      expect(leaseWrites.mock.calls.length).toBeGreaterThan(0);
      expect(leaseWrites.mock.calls.length).toBeLessThanOrEqual(240);
      leaseWrites.mockRestore();
    } finally {
      delete process.env.VIVENTIUM_CALL_SESSION_LEASE_MS;
    }
  });

  test('assertVoiceGatewayAuth validates session, secret, and job id', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'voice-auth@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const headers = {
      'x-viventium-call-session': created.callSessionId,
      'x-viventium-call-secret': 'secret',
      'x-viventium-job-id': 'job_1',
      'x-viventium-worker-id': 'worker_a',
    };
    const req = {
      get: (name) => headers[name.toLowerCase()] || '',
    };

    const authed = await assertVoiceGatewayAuth(req);
    expect(authed.callSessionId).toBe(created.callSessionId);
    expect(authed.activeJobId).toBe('job_1');
  });

  test('claim and gateway auth require a structurally bound worker identity', async () => {
    const user = await User.create({
      name: 'Worker Required User',
      email: 'worker-required@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    await expect(
      claimVoiceSession({ callSessionId: created.callSessionId, jobId: 'job_without_worker' }),
    ).rejects.toThrow('claimVoiceSession requires workerId');
    await expect(
      assertVoiceGatewayAuth({
        get: (name) =>
          ({
            'x-viventium-call-session': created.callSessionId,
            'x-viventium-call-secret': 'secret',
            'x-viventium-job-id': 'job_without_worker',
          })[name.toLowerCase()] || '',
      }),
    ).rejects.toMatchObject({ status: 401, message: 'Missing voice worker id' });
  });

  test('assertVoiceGatewayAuth rejects a live session owned by another active job', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'voice-auth-owned@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_1',
      workerId: 'worker_a',
      leaseDurationMs: 1000,
    });

    const headers = {
      'x-viventium-call-session': created.callSessionId,
      'x-viventium-call-secret': 'secret',
      'x-viventium-job-id': 'job_2',
      'x-viventium-worker-id': 'worker_b',
    };
    const req = {
      get: (name) => headers[name.toLowerCase()] || '',
    };

    await expect(assertVoiceGatewayAuth(req)).rejects.toMatchObject({
      status: 403,
      message: 'Another worker owns this session',
    });
  });

  test('assertVoiceGatewayAuth does not let another worker reuse the active job id', async () => {
    const user = await User.create({
      name: 'Worker Race User',
      email: 'voice-worker-race@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'job_shared',
      workerId: 'worker_owner',
      leaseDurationMs: 60000,
    });
    const headers = {
      'x-viventium-call-session': created.callSessionId,
      'x-viventium-call-secret': 'secret',
      'x-viventium-job-id': 'job_shared',
      'x-viventium-worker-id': 'worker_other',
    };

    await expect(
      assertVoiceGatewayAuth({ get: (name) => headers[name.toLowerCase()] || '' }),
    ).rejects.toMatchObject({ status: 403, message: 'Unable to claim voice session' });

    delete headers['x-viventium-worker-id'];
    await expect(
      assertVoiceGatewayAuth({ get: (name) => headers[name.toLowerCase()] || '' }),
    ).rejects.toMatchObject({ status: 401, message: 'Missing voice worker id' });
  });

  test('assertVoiceGatewayAuth rejects missing or expired sessions as unauthorized', async () => {
    const headers = {
      'x-viventium-call-session': 'missing-session',
      'x-viventium-call-secret': 'secret',
      'x-viventium-job-id': 'job_1',
      'x-viventium-worker-id': 'worker_a',
    };
    const req = {
      get: (name) => headers[name.toLowerCase()] || '',
    };

    await expect(assertVoiceGatewayAuth(req)).rejects.toMatchObject({
      status: 401,
      message: 'Unknown or expired call session',
    });
  });

  test('claimDispatch + confirmDispatch finalize dispatch state', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'dispatch@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const claim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });
    expect(claim.status).toBe('claimed');
    expect(claim.claimId).toBeDefined();

    const confirmed = await confirmDispatch({
      callSessionId: created.callSessionId,
      claimId: claim.claimId,
      success: true,
    });
    expect(confirmed.dispatchConfirmedAtMs).toBeDefined();
    expect(confirmed.dispatchClaimId).toBe(claim.claimId);

    const workerClaim = await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'dispatch-job-after-confirm',
      workerId: 'dispatch-worker-after-confirm',
      dispatchClaimId: claim.claimId,
    });
    expect(workerClaim.activeJobId).toBe('dispatch-job-after-confirm');
    expect(workerClaim.dispatchClaimId).toBeNull();

    const claimAgain = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });
    expect(claimAgain.status).toBe('already');
  });

  test('worker atomically consumes dispatch authority before browser confirmation', async () => {
    const user = await User.create({
      name: 'Dispatch Ordering User',
      email: 'dispatch-ordering@example.com',
      provider: 'local',
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });
    const claim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });

    await expect(
      getDispatchStatus({ callSessionId: created.callSessionId, claimId: claim.claimId }),
    ).resolves.toEqual({ version: 1, status: 'waiting', isWorkerClaimed: false });

    const workerClaim = await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'dispatch-job-before-confirm',
      workerId: 'dispatch-worker-before-confirm',
      dispatchClaimId: claim.claimId,
    });
    expect(workerClaim.dispatchClaimId).toBeNull();
    await expect(
      getDispatchStatus({ callSessionId: created.callSessionId, claimId: claim.claimId }),
    ).resolves.toEqual({ version: 1, status: 'claimed', isWorkerClaimed: true });
    await expect(
      getDispatchStatus({ callSessionId: created.callSessionId, claimId: 'superseded-claim' }),
    ).resolves.toEqual({ version: 1, status: 'superseded', isWorkerClaimed: false });

    const confirmed = await confirmDispatch({
      callSessionId: created.callSessionId,
      claimId: claim.claimId,
      success: true,
    });
    expect(confirmed.dispatchConfirmedAtMs).toBeDefined();
    expect(confirmed.activeJobId).toBe('dispatch-job-before-confirm');
  });

  test('claimDispatch reclaims a confirmed dispatch when LiveKit needs recreation', async () => {
    const user = await User.create({
      name: 'Call User',
      email: 'dispatch-reclaim@example.com',
      provider: 'local',
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    const firstClaim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });
    expect(firstClaim.status).toBe('claimed');

    await confirmDispatch({
      callSessionId: created.callSessionId,
      claimId: firstClaim.claimId,
      success: true,
    });

    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'expired-original-job',
      workerId: 'expired-original-worker',
      dispatchClaimId: firstClaim.claimId,
    });
    await ViventiumCallSession.updateOne(
      { callSessionId: created.callSessionId },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );

    const normalClaim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });
    expect(normalClaim.status).toBe('already');

    const reclaimResults = await Promise.all([
      claimDispatch({
        callSessionId: created.callSessionId,
        roomName: created.roomName,
        agentName: 'librechat-voice-gateway',
        reclaimConfirmed: true,
      }),
      claimDispatch({
        callSessionId: created.callSessionId,
        roomName: created.roomName,
        agentName: 'librechat-voice-gateway',
        reclaimConfirmed: true,
      }),
    ]);
    expect(reclaimResults.map((result) => result.status).sort()).toEqual(['claimed', 'in_flight']);
    const reclaimed = reclaimResults.find((result) => result.status === 'claimed');
    expect(reclaimed.status).toBe('claimed');
    expect(reclaimed.claimId).toBeDefined();
    expect(reclaimed.claimId).not.toBe(firstClaim.claimId);
    expect(reclaimed.session.dispatchConfirmedAtMs).toBeUndefined();

    await confirmDispatch({
      callSessionId: created.callSessionId,
      claimId: reclaimed.claimId,
      success: true,
    });
    const confirmedButUnconsumedReclaim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
      reclaimConfirmed: true,
    });
    expect(confirmedButUnconsumedReclaim.status).toBe('in_flight');

    await claimVoiceSession({
      callSessionId: created.callSessionId,
      jobId: 'reclaimed-active-job',
      workerId: 'reclaimed-active-worker',
      dispatchClaimId: reclaimed.claimId,
    });
    const activeWorkerReclaim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
      reclaimConfirmed: true,
    });
    expect(activeWorkerReclaim.status).toBe('already');

    await ViventiumCallSession.updateOne(
      { callSessionId: created.callSessionId },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    const expiredWorkerReclaim = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
      reclaimConfirmed: true,
    });
    expect(expiredWorkerReclaim.status).toBe('claimed');
    expect(expiredWorkerReclaim.claimId).not.toBe(reclaimed.claimId);
  });

  test('createCallSession hydrates requestedVoiceRoute from saved user defaults', async () => {
    const user = await User.create({
      name: 'Saved Voice Defaults',
      email: 'saved-defaults@example.com',
      provider: 'local',
      viventiumVoicePreferences: {
        livekitPlayground: {
          stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
          tts: { provider: 'cartesia', variant: 'sonic-2' },
        },
      },
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
    });

    expect(created.requestedVoiceRoute).toEqual({
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'cartesia', variant: 'sonic-2' },
    });
  });

  test('local whisper defaults preserve selected model and do not silently remap saved routes', async () => {
    process.env.VIVENTIUM_STT_PROVIDER = 'whisper_local';
    delete process.env.VIVENTIUM_STT_MODEL;
    delete process.env.LOCAL_WHISPER_MODEL_NAME;

    const user = await User.create({
      name: 'Local Whisper User',
      email: 'local-whisper@example.com',
      provider: 'local',
      viventiumVoicePreferences: {
        livekitPlayground: {
          stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
          tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
        },
      },
    });

    expect(
      compactVoiceRouteState({
        stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      }),
    ).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: null,
    });

    expect(await resolveUserVoiceRoute(user._id.toString())).toMatchObject({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    });
  });

  test('updateCallSessionVoiceSettings persists both session route and saved defaults', async () => {
    const user = await User.create({
      name: 'Voice Settings User',
      email: 'voice-settings@example.com',
      provider: 'local',
    });
    await Agent.create({
      id: 'agent_viventium_main_95aeb3',
      name: 'Main Agent',
      provider: 'openAI',
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
      voice_llm_provider: null,
      voice_llm_model: null,
      author: user._id.toString(),
      versions: [],
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_viventium_main_95aeb3',
      conversationId: 'new',
    });

    const updated = await updateCallSessionVoiceSettings({
      callSessionId: created.callSessionId,
      requestedVoiceRoute: {
        stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
        tts: { provider: 'elevenlabs', variant: 'voice_123' },
      },
    });

    expect(updated).toEqual({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      expiresAtMs: expect.any(Number),
      requestedVoiceRoute: {
        stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
        tts: { provider: 'elevenlabs', variant: 'voice_123' },
      },
      savedVoiceRoute: {
        stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
        tts: { provider: 'elevenlabs', variant: 'voice_123' },
      },
      assistantRoute: {
        primary: { provider: 'anthropic', model: 'claude-opus-5' },
        voiceCallLlm: null,
        fallbackLlm: null,
        voiceFallbackLlm: null,
        effective: { provider: 'anthropic', model: 'claude-opus-5' },
        inheritsPrimary: true,
      },
    });

    const savedUser = await User.findById(user._id).lean();
    expect(savedUser?.viventiumVoicePreferences?.livekitPlayground).toEqual(
      compactVoiceRouteState({
        stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
        tts: { provider: 'elevenlabs', variant: 'voice_123' },
      }),
    );
  });

  test('getCallSessionVoiceSettings returns both saved defaults and session override', async () => {
    const user = await User.create({
      name: 'Voice Settings User',
      email: 'voice-settings-read@example.com',
      provider: 'local',
      viventiumVoicePreferences: {
        livekitPlayground: {
          stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
          tts: { provider: 'cartesia', variant: 'sonic-2' },
        },
      },
    });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    await Agent.create({
      id: 'agent_viventium_main_95aeb3',
      name: 'Main Agent',
      provider: 'openAI',
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
      voice_llm_provider: 'openAI',
      voice_llm_model: 'gpt-5.4',
      fallback_llm_provider: 'openAI',
      fallback_llm_model: 'gpt-5.4',
      voice_fallback_llm_provider: 'anthropic',
      voice_fallback_llm_model: 'claude-haiku-4-5',
      author: user._id.toString(),
      versions: [],
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_viventium_main_95aeb3',
      conversationId: 'new',
    });
    await updateCallSessionVoiceSettings({
      callSessionId: created.callSessionId,
      persistToUserDefaults: false,
      requestedVoiceRoute: {
        stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
    });

    const settings = await getCallSessionVoiceSettings(created.callSessionId);

    expect(settings).toEqual({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      expiresAtMs: expect.any(Number),
      requestedVoiceRoute: {
        stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
      savedVoiceRoute: {
        stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
        tts: { provider: 'cartesia', variant: 'sonic-2' },
      },
      assistantRoute: {
        primary: { provider: 'anthropic', model: 'claude-opus-5' },
        voiceCallLlm: { provider: 'openAI', model: 'gpt-5.4' },
        fallbackLlm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        voiceFallbackLlm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        effective: { provider: 'openAI', model: 'gpt-5.4' },
        inheritsPrimary: false,
      },
    });
  });

  test('keeps a capability-required GlassHive Main in call-session route disclosure', async () => {
    const user = await User.create({
      name: 'Harness Route User',
      email: 'harness-route@example.com',
      provider: 'local',
    });
    await Agent.create({
      id: 'agent_viventium_main_95aeb3',
      name: 'Main Agent',
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      model_parameters: {
        model: 'codex-cli:gpt-5.6-sol',
        reasoning_effort: 'medium',
      },
      author: user._id.toString(),
      versions: [],
    });
    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_viventium_main_95aeb3',
      conversationId: 'new',
    });

    const settings = await getCallSessionVoiceSettings(created.callSessionId, {
      capabilityRequiredProviders: ['glasshive-harness'],
    });

    expect(settings.assistantRoute.primary).toEqual({
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
    });
  });
});
