/* === VIVENTIUM START === Voice durable-effect owner tests. === VIVENTIUM END === */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createInteractionDurableEffectModel } from '~/models/interactionDurableEffect';

describe('InteractionDurableEffect schema', () => {
  let mongoServer: MongoMemoryServer;
  const database = new mongoose.Mongoose();
  const Effect = createInteractionDurableEffectModel(database);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await database.connect(mongoServer.getUri());
    await Effect.syncIndexes();
  });

  afterEach(async () => {
    await Effect.deleteMany({});
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  test('keeps one durable tool-call occurrence and one provider key without a TTL', () => {
    const indexes = Effect.schema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ effectKey: 1 }, expect.objectContaining({ unique: true })],
        [
          { ownerId: 1, effectOccurrenceRef: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { effectOccurrenceRef: { $type: 'string' } },
          }),
        ],
        [{ adapterId: 1, providerIdempotencyKey: 1 }, expect.objectContaining({ unique: true })],
      ]),
    );
    expect(indexes.some(([, options]) => options.expireAfterSeconds != null)).toBe(false);
  });

  test('persists only the declared immutable identity and bounded result fields', async () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    await Effect.create({
      schemaVersion: 1,
      effectKey: `effect_${'a'.repeat(64)}`,
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      logicalTurnId: 'logical-turn-1',
      logicalTurnRevision: 3,
      sourceEventId: 'voice:event-1',
      sourceRevision: 3,
      responseMessageId: 'response-1',
      presentationRevision: 3,
      surface: 'voice',
      effectOrdinal: 0,
      effectOccurrenceRef: `ghbi_${'2'.repeat(64)}`,
      effectKind: 'durable_work_action_accepted',
      adapterId: 'glasshive.work_action.v1',
      routeId: 'active_work_action',
      operation: 'pause',
      canonicalArgsSha256: `sha256:${'b'.repeat(64)}`,
      voiceAuthorityRef: `voice_authority_${'c'.repeat(64)}`,
      voice: {
        callSessionId: 'call-1',
        voiceTurnId: 'turn-1',
        mode: 'wing',
        callModeRevision: 2,
        speakerSessionRevision: 4,
        segmentRevisionDigest: `sha256:${'d'.repeat(64)}`,
        ownerParticipantDigest: `sha256:${'e'.repeat(64)}`,
        engagementDigest: `sha256:${'f'.repeat(64)}`,
        engagementExpiresAt: new Date('2026-09-01T12:01:00.000Z'),
      },
      providerIdempotencyKey: 'legacy-provider-key',
      providerIdempotencyMode: 'native_key',
      status: 'reserved',
      claimRevision: 1,
      claimTokenHash: `sha256:${'1'.repeat(64)}`,
      claimExpiresAt: new Date('2026-09-01T12:00:30.000Z'),
      attemptCount: 1,
      transitionRevision: 1,
      createdAt: now,
      lastTransitionAt: now,
    });

    const row = await Effect.findOne({ ownerId: 'owner-1' }).lean();
    expect(row).toMatchObject({
      effectOrdinal: 0,
      effectOccurrenceRef: `ghbi_${'2'.repeat(64)}`,
      status: 'reserved',
      claimRevision: 1,
    });
    expect(row).not.toHaveProperty('forbiddenPayload');
    expect(Effect.schema.path('rawProviderPayload')).toBeUndefined();
    expect(Effect.schema.path('transcript')).toBeUndefined();
    await expect(
      Effect.create({
        schemaVersion: 1,
        effectKey: `effect_${'9'.repeat(64)}`,
        forbiddenPayload: 'must not persist',
      }),
    ).rejects.toThrow();
  });
});
