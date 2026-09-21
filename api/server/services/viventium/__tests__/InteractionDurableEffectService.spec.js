/* === VIVENTIUM START === Provider-neutral durable interaction-effect owner tests. === */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
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
