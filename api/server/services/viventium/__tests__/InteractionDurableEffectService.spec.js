/* === VIVENTIUM START === Provider-neutral durable interaction-effect owner tests. === */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const {
  createVoiceEngagementAuthorityService,
  createVoiceWorkAuthorityBinding,
} = require('@librechat/api');
const {
  createInteractionDurableEffectService,
  createVoiceDurableEffectAuthorityBinding,
} = require('../InteractionDurableEffectService');

describe('InteractionDurableEffectService', () => {
  let mongoServer;
  const database = new mongoose.Mongoose();
  const EffectModel = createModels(database).InteractionDurableEffect;
  let observedAt;
  let job;
  let session;
  let segments;
  let service;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await database.connect(mongoServer.getUri());
    await EffectModel.syncIndexes();
  });

  beforeEach(async () => {
    await EffectModel.deleteMany({});
    observedAt = new Date('2026-09-01T12:00:00.000Z');
    session = {
      callSessionId: 'call-1',
      userId: 'owner-1',
      mode: 'wing',
      revision: 2,
      speakerSessionRevision: 4,
      ownerParticipantIdentity: 'owner-participant-1',
    };
    segments = [
      {
        version: 1,
        callSessionId: 'call-1',
        turnId: 'voice-turn-1',
        segmentId: 'segment-1',
        revision: 7,
        speaker: {
          participantIdentity: 'owner-participant-1',
          attribution: 'verified',
          actorTrust: 'owner_participant',
        },
      },
    ];
    const authority = createVoiceDurableEffectAuthorityBinding({
      session,
      segments,
      engagement: {
        turnId: 'voice-turn-1',
        expiresAtMs: new Date('2026-09-01T12:01:00.000Z').getTime(),
        assertion: 'signed-engagement',
      },
    });
    job = {
      metadata: {
        userId: 'owner-1',
        conversationId: 'conversation-1',
        responseMessageId: 'response-1',
        interactionContext: {
          surface: 'voice',
          conversation_id: 'conversation-1',
          logical_turn_id: 'logical-turn-1',
          revision: 3,
          source_event_id: 'voice:event-1',
        },
        viventiumVoiceEffectAuthority: authority,
      },
    };
    service = createInteractionDurableEffectService({
      EffectModel,
      generationJobManager: { getJob: jest.fn().mockImplementation(async () => job) },
      getCallSession: jest.fn().mockImplementation(async () => session),
      listSpeakerSegments: jest.fn().mockImplementation(async () => segments),
      now: () => new Date(observedAt),
      createClaimToken: () => 'claim-token-fixed-for-test',
      claimDurationMs: 1_000,
    });
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  function input(canonicalArgs = { workRef: 'work-1', action: 'pause' }, overrides = {}) {
    return {
      streamId: 'stream-1',
      userId: 'owner-1',
      effectOrdinal: 0,
      effectOccurrenceRef: `ghbi_${'a'.repeat(64)}`,
      effectKind: 'durable_work_action_accepted',
      adapterId: 'glasshive.work_action.v1',
      routeId: 'active_work_action',
      operation: 'pause',
      canonicalArgs,
      providerIdempotencyKey: 'legacy-provider-key',
      providerIdempotencyMode: 'native_key',
      ...overrides,
    };
  }

  function typedService() {
    session = { ...session, mode: 'call', status: 'active' };
    segments = [];
    delete job.metadata.viventiumVoiceEffectAuthority;
    job.metadata.viventiumCallSessionId = session.callSessionId;
    job.metadata.viventiumVoiceWorkAuthority = createVoiceWorkAuthorityBinding({
      session,
      segments: [],
      typedInput: true,
    });
    const dependencies = {
      getCallSession: jest.fn(async () => session),
      listSpeakerSegments: jest.fn(async () => segments),
      voiceTurnAuthority: jest.fn(),
      verifyVoiceEngagementAttestation: jest.fn(),
    };
    const workAuthority = createVoiceEngagementAuthorityService(dependencies);
    const build = () =>
      createInteractionDurableEffectService({
        EffectModel,
        generationJobManager: { getJob: jest.fn(async () => JSON.parse(JSON.stringify(job))) },
        getCallSession: dependencies.getCallSession,
        listSpeakerSegments: dependencies.listSpeakerSegments,
        assertVoiceWorkAuthority: workAuthority.assertVoiceWorkAuthority,
        now: () => new Date(observedAt),
        createClaimToken: () => 'typed-claim-token',
      });
    service = build();
    return { dependencies, build };
  }

  test.each([
    ['glasshive.worker_delegate.v1', 'durable_work_accepted', 'worker_delegate_once'],
    ['glasshive.work_action.v1', 'durable_work_action_accepted', 'steer'],
    ['mcp.provider_mutation.v1', 'provider_mutation_returned', 'provider_action'],
  ])(
    'typed Call reserves %s under existing WorkAuthority without audio evidence',
    async (adapterId, effectKind, operation) => {
      const { dependencies } = typedService();
      const prepared = await service.prepareDurableEffect(
        input(undefined, {
          adapterId,
          effectKind,
          operation,
        }),
      );
      expect(prepared.decision).toBe('dispatch');
      const row = await EffectModel.findOne({ effectKey: prepared.effectKey }).lean();
      expect(row.voiceAuthorityRef).toMatch(/^voice_authority_[a-f0-9]{64}$/);
      expect(row.voice).toBeUndefined();
      expect(row).toMatchObject({
        ownerId: 'owner-1',
        sourceEventId: 'voice:event-1',
        surface: 'voice',
        adapterId,
        effectKind,
        operation,
      });
      expect(dependencies.listSpeakerSegments).not.toHaveBeenCalled();
    },
  );

  test.each([
    { mode: 'wing' },
    { mode: 'listen_only' },
    { status: 'ended' },
    { status: 'failed' },
    { revision: 3 },
    { speakerSessionRevision: 5 },
    { userId: 'other-owner' },
    { callSessionId: 'other-call' },
    { ownerParticipantIdentity: 'replacement-owner' },
  ])('typed Call rejects changed current authority before creating a row: %j', async (change) => {
    typedService();
    session = { ...session, ...change };
    await expect(service.prepareDurableEffect(input())).rejects.toMatchObject({
      code: 'voice_work_authority_stale',
      status: 409,
      retryable: false,
    });
    expect(await EffectModel.countDocuments({})).toBe(0);
  });

  test.each(['foreign-owner', 'wrong-call', 'forged-fingerprint', 'mixed-audio'])(
    'typed Call rejects an invalid retained binding: %s',
    async (change) => {
      typedService();
      if (change === 'foreign-owner')
        job.metadata.viventiumVoiceWorkAuthority.userId = 'other-owner';
      if (change === 'wrong-call') job.metadata.viventiumCallSessionId = 'other-call';
      if (change === 'forged-fingerprint')
        job.metadata.viventiumVoiceWorkAuthority.fingerprint = 'forged';
      if (change === 'mixed-audio')
        job.metadata.viventiumVoiceEffectAuthority = { version: 1, voice: {} };
      await expect(service.prepareDurableEffect(input())).rejects.toMatchObject({ status: 409 });
      expect(await EffectModel.countDocuments({})).toBe(0);
    },
  );

  test('typed Call rechecks restored job authority before committed replay', async () => {
    const { build } = typedService();
    const prepared = await service.prepareDurableEffect(input());
    await service.commitDurableEffect({
      effectKey: prepared.effectKey,
      claimToken: prepared.claimToken,
      providerReceiptRef: 'worker-action-accepted',
      replayResult: { accepted: true },
    });
    service = build();
    await expect(service.prepareDurableEffect(input())).resolves.toMatchObject({
      decision: 'return_committed',
      providerReceiptRef: 'worker-action-accepted',
    });
    session = { ...session, mode: 'listen_only' };
    await expect(service.prepareDurableEffect(input())).rejects.toMatchObject({
      code: 'voice_work_authority_stale',
    });
    expect(await EffectModel.countDocuments({})).toBe(1);
  });

  test('typed Call records an already accepted provider effect after End without allowing redispatch', async () => {
    typedService();
    const prepared = await service.prepareDurableEffect(input());
    session = { ...session, status: 'ended' };
    await expect(
      service.commitDurableEffect({
        effectKey: prepared.effectKey,
        claimToken: prepared.claimToken,
        providerReceiptRef: 'accepted-before-end',
        replayResult: { accepted: true },
      }),
    ).resolves.toMatchObject({ status: 'committed', providerReceiptRef: 'accepted-before-end' });
    await expect(service.prepareDurableEffect(input())).rejects.toMatchObject({
      code: 'voice_work_authority_stale',
    });
    expect(await EffectModel.countDocuments({})).toBe(1);
  });

  test('a caller carrier cannot replace a missing server-held typed authority', async () => {
    typedService();
    const callerCarrier = job.metadata.viventiumVoiceWorkAuthority;
    delete job.metadata.viventiumVoiceWorkAuthority;
    await expect(
      service.prepareDurableEffect(
        input(undefined, {
          viventiumVoiceWorkAuthority: callerCarrier,
        }),
      ),
    ).rejects.toMatchObject({ code: 'durable_effect_voice_authority_missing', status: 403 });
    expect(await EffectModel.countDocuments({})).toBe(0);
  });

  test('a selected earlier source must belong to this current author revision', async () => {
    job.metadata.interactionContext.source_segments = [
      { source_event_id: 'earlier-owned', authoring_revision: 3 },
      { source_event_id: 'foreign-author', authoring_revision: 2 },
    ];
    const claim = await service.prepareDurableEffect(
      input(undefined, { sourceEventId: 'earlier-owned' }),
    );
    expect(await EffectModel.findOne({ effectKey: claim.effectKey }).lean()).toMatchObject({
      sourceEventId: 'earlier-owned',
      sourceRevision: 3,
    });
    await expect(
      service.prepareDurableEffect(
        input(undefined, {
          sourceEventId: 'foreign-author',
          effectOccurrenceRef: 'distinct-occurrence',
          providerIdempotencyKey: 'distinct-provider-key',
        }),
      ),
    ).rejects.toMatchObject({ code: 'source_mutation_source_not_owned' });
    expect(await EffectModel.countDocuments({})).toBe(1);
  });

  test('typed connected mutation results persist without invented native deduplication', async () => {
    const claim = await service.prepareDurableEffect(
      input(
        { synthetic: true },
        {
          adapterId: 'mcp.provider_mutation.v1',
          effectKind: 'provider_mutation_returned',
          providerIdempotencyMode: 'none',
          routeId: 'connected-service',
          operation: 'typed-write',
        },
      ),
    );
    await service.commitDurableEffect({
      effectKey: claim.effectKey,
      claimToken: claim.claimToken,
      providerReceiptRef: 'core-operation-receipt',
      replayResult: { result: 'returned' },
    });
    expect(await EffectModel.findOne({ effectKey: claim.effectKey }).lean()).toMatchObject({
      status: 'committed',
      providerIdempotencyMode: 'none',
      effectKind: 'provider_mutation_returned',
    });
  });

  test('reserves in Mongo, commits there, and returns the committed replay', async () => {
    const prepared = await service.prepareDurableEffect(input());
    expect(prepared).toMatchObject({
      decision: 'dispatch',
      providerIdempotencyKey: 'legacy-provider-key',
    });
    await expect(
      EffectModel.findOne({ effectKey: prepared.effectKey }).lean(),
    ).resolves.toMatchObject({
      status: 'reserved',
      effectOrdinal: 0,
      effectOccurrenceRef: `ghbi_${'a'.repeat(64)}`,
      providerIdempotencyKey: 'legacy-provider-key',
    });

    const committed = await service.commitDurableEffect({
      effectKey: prepared.effectKey,
      claimToken: prepared.claimToken,
      providerReceiptRef: 'work-action-receipt-1',
      replayResult: { status: 'ok', state: 'paused', access_token: 'must-not-persist' },
    });
    expect(committed).toMatchObject({
      status: 'committed',
      providerReceiptRef: 'work-action-receipt-1',
    });
    expect(committed.replayResult).toEqual({ status: 'ok', state: 'paused' });

    await expect(service.prepareDurableEffect(input())).resolves.toMatchObject({
      decision: 'return_committed',
      providerReceiptRef: 'work-action-receipt-1',
      replayResult: { status: 'ok', state: 'paused' },
    });
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('lets only one concurrent caller dispatch the exact tool-call occurrence', async () => {
    const [left, right] = await Promise.all([
      service.prepareDurableEffect(input()),
      service.prepareDurableEffect(input()),
    ]);
    expect([left.decision, right.decision].sort()).toEqual(['dispatch', 'in_progress']);
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('reserves distinct trusted tool-call occurrences in one logical turn independently', async () => {
    const missionA = input(
      { title: 'Mission A', instruction: 'Build alpha.' },
      {
        effectKind: 'durable_work_accepted',
        adapterId: 'glasshive.worker_delegate.v1',
        routeId: 'worker_delegate_once',
        operation: 'delegate',
        effectOccurrenceRef: `ghbi_${'b'.repeat(64)}`,
        providerIdempotencyKey: 'provider-key-a',
      },
    );
    const missionB = input(
      { title: 'Mission B', instruction: 'Build beta.' },
      {
        effectKind: 'durable_work_accepted',
        adapterId: 'glasshive.worker_delegate.v1',
        routeId: 'worker_delegate_once',
        operation: 'delegate',
        effectOccurrenceRef: `ghbi_${'c'.repeat(64)}`,
        providerIdempotencyKey: 'provider-key-b',
      },
    );

    await expect(service.prepareDurableEffect(missionA)).resolves.toMatchObject({
      decision: 'dispatch',
    });
    await expect(service.prepareDurableEffect(missionB)).resolves.toMatchObject({
      decision: 'dispatch',
    });
    await expect(EffectModel.countDocuments({})).resolves.toBe(2);
  });

  test('rejects changed arguments in the same trusted tool-call occurrence', async () => {
    await service.prepareDurableEffect(input());

    await expect(
      service.prepareDurableEffect(input({ workRef: 'work-1', action: 'resume' })),
    ).rejects.toMatchObject({ code: 'durable_effect_conflict', status: 409 });
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('replays a matching pre-occurrence-ref row without reopening its provider mutation', async () => {
    const prepared = await service.prepareDurableEffect(input());
    await service.commitDurableEffect({
      effectKey: prepared.effectKey,
      claimToken: prepared.claimToken,
      providerReceiptRef: 'legacy-work-action-receipt',
      replayResult: { status: 'ok', state: 'paused' },
    });
    const legacyEffectKey = `effect_${'9'.repeat(64)}`;
    await EffectModel.collection.updateOne(
      { effectKey: prepared.effectKey },
      { $set: { effectKey: legacyEffectKey }, $unset: { effectOccurrenceRef: '' } },
    );

    await expect(service.prepareDurableEffect(input())).resolves.toMatchObject({
      decision: 'return_committed',
      effectKey: legacyEffectKey,
      providerReceiptRef: 'legacy-work-action-receipt',
      replayResult: { status: 'ok', state: 'paused' },
    });
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('fails closed when an occurrence reference is reused across logical turns', async () => {
    await service.prepareDurableEffect(input());
    job = {
      metadata: {
        ...job.metadata,
        responseMessageId: 'response-2',
        interactionContext: {
          ...job.metadata.interactionContext,
          logical_turn_id: 'logical-turn-2',
          revision: 4,
          source_event_id: 'voice:event-2',
        },
      },
    };

    await expect(
      service.prepareDurableEffect(
        input(undefined, { providerIdempotencyKey: 'provider-key-second-turn' }),
      ),
    ).rejects.toMatchObject({ code: 'durable_effect_conflict', status: 409 });
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('fails closed when an occurrence reference is rebound to new Voice authority', async () => {
    await service.prepareDurableEffect(input());
    session = { ...session, revision: session.revision + 1 };
    segments = [{ ...segments[0], revision: segments[0].revision + 1 }];
    job = {
      metadata: {
        ...job.metadata,
        viventiumVoiceEffectAuthority: createVoiceDurableEffectAuthorityBinding({
          session,
          segments,
          engagement: {
            turnId: 'voice-turn-1',
            expiresAtMs: new Date('2026-09-01T12:01:00.000Z').getTime(),
            assertion: 'renewed-signed-engagement',
          },
        }),
      },
    };

    await expect(
      service.prepareDurableEffect(
        input(undefined, { providerIdempotencyKey: 'provider-key-new-voice-authority' }),
      ),
    ).rejects.toMatchObject({ code: 'durable_effect_conflict', status: 409 });
    await expect(EffectModel.countDocuments({})).resolves.toBe(1);
  });

  test('rejects a cross-owner occurrence before touching the durable ledger', async () => {
    await expect(
      service.prepareDurableEffect(
        input(undefined, {
          userId: 'owner-2',
          effectOccurrenceRef: `ghbi_${'d'.repeat(64)}`,
          providerIdempotencyKey: 'provider-key-owner-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'durable_effect_owner_mismatch', status: 403 });
    await expect(EffectModel.countDocuments({})).resolves.toBe(0);
  });

  test('re-reads Voice authority and creates no row when its revision changed', async () => {
    session = { ...session, revision: session.revision + 1 };

    await expect(service.prepareDurableEffect(input())).rejects.toMatchObject({
      code: 'durable_effect_voice_authority_stale',
      status: 409,
    });
    await expect(EffectModel.countDocuments({})).resolves.toBe(0);
  });

  test('recovers an expired uncertain claim with the exact legacy provider key', async () => {
    const prepared = await service.prepareDurableEffect(input());
    await service.settleDurableEffectFailure({
      effectKey: prepared.effectKey,
      claimToken: prepared.claimToken,
      outcome: 'provider_outcome_unknown',
      failureCode: 'provider_timeout',
    });
    observedAt = new Date('2026-09-01T12:00:02.000Z');

    await expect(service.prepareDurableEffect(input())).resolves.toMatchObject({
      decision: 'reconcile',
      providerIdempotencyKey: 'legacy-provider-key',
    });
    await expect(
      EffectModel.findOne({ effectKey: prepared.effectKey }).lean(),
    ).resolves.toMatchObject({
      attemptCount: 2,
      claimRevision: 2,
    });
  });

  test('treats an expired reserved claim as reconciliation, never a fresh-key dispatch', async () => {
    const prepared = await service.prepareDurableEffect(input());
    observedAt = new Date('2026-09-01T12:00:02.000Z');

    await expect(service.prepareDurableEffect(input())).resolves.toMatchObject({
      decision: 'reconcile',
      effectKey: prepared.effectKey,
      providerIdempotencyKey: 'legacy-provider-key',
    });
  });
});

/* === VIVENTIUM END === */
