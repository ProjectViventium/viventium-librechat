const express = require('express');
const request = require('supertest');

const mockGetFeelingState = jest.fn();
const mockCreateFeelingStateIfMissing = jest.fn();
const mockUpdateFeelingState = jest.fn();
const mockDeleteFeelingState = jest.fn();
const mockLoadFeelingsReadContext = jest.fn();
const mockCreateInitialFeelingState = jest.fn();
const mockPrepareManualFeelingPatch = jest.fn();
const mockClearFeelingsReadCache = jest.fn();
const mockResolveConfig = jest.fn();

const definitions = [
  { id: 'energy', name: 'Energy' },
  { id: 'mood', name: 'Mood' },
  { id: 'drive', name: 'Drive' },
  { id: 'curiosity', name: 'Curiosity' },
  { id: 'vigilance', name: 'Vigilance' },
  { id: 'care', name: 'Care' },
  { id: 'connection', name: 'Connection' },
  { id: 'openness', name: 'Openness' },
  { id: 'play', name: 'Play' },
];

const snapshot = {
  available: true,
  enabled: false,
  agentScope: 'all_agents',
  version: 0,
  asOf: '2026-07-09T12:00:00.000Z',
  capsule: '',
  snapshotHash: 'synthetic-hash',
  reactionInstruction: 'React naturally.',
  reactionActivationMode: 'always',
  innerState: null,
  bands: { energy: { baseline: 56, current: 56, halfLifeMinutes: 240, enabled: true } },
  trail: [],
  reactionHealth: { status: 'never' },
};

jest.mock('@librechat/api', () => ({
  FEELING_BANDS: definitions,
  FEELING_BAND_IDS: definitions.map((definition) => definition.id),
  DEFAULT_REACTION_INSTRUCTION: 'React naturally from the current state.',
  loadFeelingsReadContext: (...args) => mockLoadFeelingsReadContext(...args),
  createInitialFeelingState: (...args) => mockCreateInitialFeelingState(...args),
  prepareManualFeelingPatch: (...args) => mockPrepareManualFeelingPatch(...args),
  clearFeelingsReadCache: (...args) => mockClearFeelingsReadCache(...args),
  resolveFeelingsRuntimeConfig: (...args) => mockResolveConfig(...args),
}));

jest.mock('~/models', () => ({
  getFeelingState: (...args) => mockGetFeelingState(...args),
  createFeelingStateIfMissing: (...args) => mockCreateFeelingStateIfMissing(...args),
  updateFeelingState: (...args) => mockUpdateFeelingState(...args),
  deleteFeelingState: (...args) => mockDeleteFeelingState(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: '507f191e810c19729de860ea' };
    req.id = 'synthetic-request';
    next();
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('/api/viventium/feelings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadFeelingsReadContext.mockResolvedValue(snapshot);
    mockResolveConfig.mockReturnValue({
      available: true,
      agentScope: 'all_agents',
      reaction: { provider: 'openai', model: 'gpt-5.6-terra' },
    });
    mockCreateInitialFeelingState.mockReturnValue({
      ...snapshot,
      bands: snapshot.bands,
      reactionHealth: { status: 'never' },
    });
    mockCreateFeelingStateIfMissing.mockResolvedValue({ version: 0 });
    mockUpdateFeelingState.mockResolvedValue({ version: 1 });
    mockDeleteFeelingState.mockResolvedValue(true);
    mockPrepareManualFeelingPatch.mockReturnValue({
      band: { baseline: 56, current: 80, halfLifeMinutes: 240, enabled: true },
      trail: [],
    });
  });

  function createApp() {
    const router = require('../feelings');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/feelings', router);
    return app;
  }

  test('returns the authenticated user snapshot and approved definitions', async () => {
    const response = await request(createApp()).get('/api/viventium/feelings').expect(200);

    expect(response.body.state.snapshotHash).toBe('synthetic-hash');
    expect(response.body.definitions.map((item) => item.id)).toEqual(
      definitions.map((item) => item.id),
    );
    expect(response.body.config.reaction.defaultInstruction).toBe(
      'React naturally from the current state.',
    );
    expect(mockLoadFeelingsReadContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '507f191e810c19729de860ea',
        getFeelingState: expect.any(Function),
      }),
    );
  });

  test('creates missing state and updates profile with optimistic versioning', async () => {
    await request(createApp())
      .patch('/api/viventium/feelings/profile')
      .send({ expectedVersion: 0, enabled: true, reactionActivationMode: 'classified' })
      .expect(200);

    expect(mockCreateFeelingStateIfMissing).toHaveBeenCalledTimes(1);
    expect(mockUpdateFeelingState).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '507f191e810c19729de860ea',
        expectedVersion: 0,
        set: { enabled: true, reactionActivationMode: 'classified', innerState: null },
      }),
    );
    expect(mockClearFeelingsReadCache).toHaveBeenCalledWith('507f191e810c19729de860ea');
  });

  test('validates the reaction instruction boundary', async () => {
    await request(createApp())
      .patch('/api/viventium/feelings/profile')
      .send({ expectedVersion: 0, reactionInstruction: 'x'.repeat(4001) })
      .expect(422);
    expect(mockUpdateFeelingState).not.toHaveBeenCalled();
  });

  test('updates one band without allowing unknown keys', async () => {
    await request(createApp())
      .patch('/api/viventium/feelings/bands/energy')
      .send({ expectedVersion: 0, current: 80 })
      .expect(200);

    expect(mockPrepareManualFeelingPatch).toHaveBeenCalledWith(
      expect.objectContaining({ bandId: 'energy', change: { current: 80 } }),
    );
    expect(mockUpdateFeelingState).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          'bands.energy': expect.any(Object),
          innerState: null,
        }),
      }),
    );

    await request(createApp())
      .patch('/api/viventium/feelings/bands/unknown')
      .send({ expectedVersion: 0, current: 80 })
      .expect(404);
  });

  test('returns structured 409 when the expected version is stale', async () => {
    mockUpdateFeelingState.mockResolvedValueOnce(null);
    const response = await request(createApp())
      .patch('/api/viventium/feelings/profile')
      .send({ expectedVersion: 4, enabled: true })
      .expect(409);

    expect(response.body.error.code).toBe('FEELINGS_VERSION_CONFLICT');
  });

  test('rejects hidden mutations when the operator feature is unavailable', async () => {
    mockResolveConfig.mockReturnValue({
      available: false,
      agentScope: 'all_agents',
      reaction: { provider: 'openai', model: 'gpt-5.6-terra' },
    });

    const response = await request(createApp())
      .patch('/api/viventium/feelings/profile')
      .send({ expectedVersion: 0, enabled: true })
      .expect(503);

    expect(response.body.error.code).toBe('FEELINGS_UNAVAILABLE');
    expect(mockCreateFeelingStateIfMissing).not.toHaveBeenCalled();
    expect(mockUpdateFeelingState).not.toHaveBeenCalled();
  });

  test('deletes only the authenticated user state at the expected version', async () => {
    await request(createApp())
      .delete('/api/viventium/feelings')
      .send({ expectedVersion: 0 })
      .expect(200);
    expect(mockDeleteFeelingState).toHaveBeenCalledWith('507f191e810c19729de860ea', 0);
  });

  test('rejects a stale erase instead of deleting newer state', async () => {
    mockDeleteFeelingState.mockResolvedValueOnce(false);
    const response = await request(createApp())
      .delete('/api/viventium/feelings')
      .send({ expectedVersion: 4 })
      .expect(409);

    expect(response.body.error.code).toBe('FEELINGS_VERSION_CONFLICT');
  });
});
