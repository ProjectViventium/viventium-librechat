import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createFeelingStateMethods } from './feelingState';
import feelingStateSchema from '~/schema/feelingState';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createFeelingStateMethods>;

const band = (baseline: number) => ({
  baseline,
  current: baseline,
  halfLifeMinutes: 60,
  enabled: true,
  updatedAt: new Date('2026-07-09T12:00:00.000Z'),
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  if (!mongoose.models.FeelingState) {
    mongoose.model('FeelingState', feelingStateSchema);
  }
  methods = createFeelingStateMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

test('atomically commits terminal health, typed state, and persisted stimulus idempotency', async () => {
  const userId = new mongoose.Types.ObjectId();
  await mongoose.models.FeelingState.create({
    userId,
    enabled: true,
    bands: {
      energy: band(56),
      mood: band(58),
      drive: band(62),
      curiosity: band(66),
      vigilance: band(68),
      care: band(74),
      connection: band(52),
      openness: band(55),
      play: band(48),
    },
    reactionInstruction: 'React naturally.',
    reactionActivationMode: 'always',
    version: 0,
  });

  const health = {
    status: 'healthy' as const,
    lastDurationMs: 12,
    requestedProvider: 'openai',
    requestedModel: 'gpt-5.6-terra',
    requestedServiceTier: 'priority',
  };
  const trailEntry = {
    timestamp: new Date('2026-07-09T12:00:01.000Z'),
    band: 'energy' as const,
    direction: 'up' as const,
    strength: 'slight' as const,
    cause: 'progress' as const,
    sourceType: 'user_turn' as const,
    before: 56,
    after: 59,
  };
  const committed = await methods.commitFeelingReaction({
    userId: userId.toString(),
    expectedVersion: 0,
    set: {
      'bands.energy': { ...band(56), current: 59 },
      innerState: {
        text: 'I feel a little more alive and ready to continue.',
        generatedAt: new Date('2026-07-09T12:00:01.000Z'),
      },
    },
    trailEntries: [trailEntry],
    stimulusKey: 'synthetic-stimulus-key',
    health,
  });

  expect(committed).toEqual(
    expect.objectContaining({
      version: 1,
      processedStimulusKeys: ['synthetic-stimulus-key'],
      reactionHealth: expect.objectContaining(health),
    }),
  );
  expect(committed?.bands.energy.current).toBe(59);
  expect(committed?.innerState?.text).toBe('I feel a little more alive and ready to continue.');
  expect(committed?.trail).toHaveLength(1);

  await expect(
    methods.commitFeelingReaction({
      userId: userId.toString(),
      expectedVersion: 1,
      set: {},
      stimulusKey: 'synthetic-stimulus-key',
      health,
    }),
  ).resolves.toBeNull();
  await expect(methods.deleteFeelingState(userId.toString(), 0)).resolves.toBe(false);
  await expect(methods.deleteFeelingState(userId.toString(), 1)).resolves.toBe(true);
});

test('keeps a bounded ninety-entry typed trail for lane motion history', async () => {
  const userId = new mongoose.Types.ObjectId();
  const bands = {
    energy: band(56),
    mood: band(58),
    drive: band(62),
    curiosity: band(66),
    vigilance: band(68),
    care: band(74),
    connection: band(52),
    openness: band(55),
    play: band(48),
  };
  await mongoose.models.FeelingState.create({
    userId,
    enabled: true,
    bands,
    reactionInstruction: 'React naturally.',
    reactionActivationMode: 'always',
    version: 0,
  });

  const trailEntries = Array.from({ length: 95 }, (_, index) => ({
    timestamp: new Date(1_720_527_200_000 + index * 1000),
    band: 'mood' as const,
    direction: index % 2 === 0 ? ('up' as const) : ('down' as const),
    strength: 'slight' as const,
    cause: 'other' as const,
    sourceType: 'user_turn' as const,
    before: 50,
    after: 53,
  }));
  const updated = await methods.updateFeelingState({
    userId: userId.toString(),
    expectedVersion: 0,
    set: {},
    trailEntries,
  });

  expect(updated?.trail).toHaveLength(90);
});

test('upgrades a legacy seven-band record without requiring a destructive migration', async () => {
  const userId = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('feelingstates').insertOne({
    userId,
    enabled: true,
    bands: {
      energy: band(56),
      drive: band(62),
      curiosity: band(66),
      vigilance: band(68),
      care: band(74),
      connection: band(52),
      play: band(48),
    },
    reactionInstruction: 'React naturally.',
    reactionActivationMode: 'always',
    version: 0,
    trail: [],
    processedStimulusKeys: [],
  });

  const updated = await methods.updateFeelingState({
    userId: userId.toString(),
    expectedVersion: 0,
    set: {
      'bands.mood': band(58),
      'bands.openness': band(55),
      innerState: null,
    },
  });

  expect(updated).toEqual(
    expect.objectContaining({
      version: 1,
      innerState: null,
      bands: expect.objectContaining({
        energy: expect.objectContaining({ baseline: 56 }),
        mood: expect.objectContaining({ baseline: 58 }),
        openness: expect.objectContaining({ baseline: 55 }),
        play: expect.objectContaining({ baseline: 48 }),
      }),
    }),
  );
});

test('persists bounded range-prompt overrides without touching the band decay clock', async () => {
  const userId = new mongoose.Types.ObjectId();
  const bands = {
    energy: band(56),
    mood: band(58),
    drive: band(62),
    curiosity: band(66),
    vigilance: band(68),
    care: band(74),
    connection: band(52),
    openness: band(55),
    play: band(48),
  };
  await mongoose.models.FeelingState.create({
    userId,
    enabled: true,
    bands,
    reactionInstruction: 'React naturally.',
    reactionActivationMode: 'always',
    version: 0,
  });

  const updated = await methods.updateFeelingState({
    userId: userId.toString(),
    expectedVersion: 0,
    set: {
      rangePromptOverrides: {
        play: {
          level_4: 'Everything wants to become a ridiculous game.',
        },
      },
      innerState: null,
    },
  });

  expect(updated?.rangePromptOverrides).toEqual({
    play: { level_4: 'Everything wants to become a ridiculous game.' },
  });
  expect(updated?.bands.play.updatedAt).toEqual(bands.play.updatedAt);
  await expect(
    mongoose.models.FeelingState.updateOne(
      { userId },
      { $set: { 'rangePromptOverrides.play.level_4': 'x'.repeat(1201) } },
      { runValidators: true },
    ),
  ).rejects.toThrow();
});
