/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { agentSchema } = require('@librechat/data-schemas');

const {
  compactVoiceRouteState,
  createCallSession,
  getCallSession,
  getCallSessionVoiceSettings,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
  updateCallSessionConversationId,
  claimVoiceSession,
  claimDispatch,
  confirmDispatch,
  assertVoiceGatewayAuth,
} = require('../CallSessionService');

describe('CallSessionService', () => {
  let mongoServer;
  let ViventiumCallSession;
  let User;
  let Agent;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ ViventiumCallSession, User } = require('~/db/models'));
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
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = 'claude-opus-4-7';
    delete process.env.OPENAI_API_KEY;
    await ViventiumCallSession.deleteMany({});
    await User.deleteMany({});
    await Agent.deleteMany({});
  });

  test('createCallSession persists and getCallSession returns it', async () => {
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

    const fetched = await getCallSession(created.callSessionId);
    expect(fetched).toMatchObject({
      callSessionId: created.callSessionId,
      userId: user._id.toString(),
      agentId: 'agent_1',
      conversationId: 'new',
      roomName: created.roomName,
    });
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

  test('createCallSession seeds wing mode from the canonical default env', async () => {
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

    expect(created.wingModeEnabled).toBe(true);
    expect(created.shadowModeEnabled).toBe(true);
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

    const updated = await syncCallSessionState({
      callSessionId: created.callSessionId,
      touch: true,
      wingModeEnabled: true,
    });

    expect(updated.expiresAtMs).toBeGreaterThan(created.expiresAtMs);
    expect(updated.wingModeEnabled).toBe(true);
    expect(updated.shadowModeEnabled).toBe(true);
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

    const claimAgain = await claimDispatch({
      callSessionId: created.callSessionId,
      roomName: created.roomName,
      agentName: 'librechat-voice-gateway',
    });
    expect(claimAgain.status).toBe('already');
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
        primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
        voiceCallLlm: null,
        fallbackLlm: null,
        voiceFallbackLlm: null,
        effective: { provider: 'anthropic', model: 'claude-opus-4-7' },
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
      fallback_llm_model: 'gpt-5.4-mini',
      voice_fallback_llm_provider: 'anthropic',
      voice_fallback_llm_model: 'claude-haiku-4-5',
      author: user._id.toString(),
      versions: [],
    });

    const created = await createCallSession({
      userId: user._id.toString(),
      agentId: 'agent_viventium_main_95aeb3',
      conversationId: 'new',
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
        primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
        voiceCallLlm: { provider: 'openAI', model: 'gpt-5.4' },
        fallbackLlm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        voiceFallbackLlm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        effective: { provider: 'openAI', model: 'gpt-5.4' },
        inheritsPrimary: false,
      },
    });
  });
});
