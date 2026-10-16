/* === VIVENTIUM START === Real BSON overflow retains all Agent history and usable configuration saves. === */
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
  getMCPServerTools: jest.fn(),
}));
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Agent, AgentVersion } = require('~/db/models');
const { createAgentVersionMethods, agentVersionCount } = require('@librechat/data-schemas');
const {
  createAgent,
  getAgent,
  getAgentVersion,
  updateAgent,
  revertAgentVersion,
  deleteAgent,
  deleteUserAgents,
} = require('./Agent');

const digest = (snapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const history = createAgentVersionMethods(Agent, AgentVersion);
let replica;

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Agent.init(), AgentVersion.init()]);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Agent.deleteMany({}), AgentVersion.deleteMany({})]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});

async function largeLegacyAgent() {
  const instructions = 'context '.repeat(60000);
  const versions = Array.from({ length: 33 }, (_, index) => ({
    name: 'Synthetic history ' + index,
    instructions,
    provider: 'openai',
    model: 'synthetic-model',
    model_parameters: { model: 'synthetic-model', reasoning_effort: 'high' },
    updatedAt: new Date(1700000000000 + index),
    conversation_starters: ['Synthetic ' + index],
    tool_resources: { file_search: { file_ids: ['synthetic-file-' + index] } },
  }));
  return Agent.create({
    id: 'agent-synthetic-history',
    name: 'Synthetic current',
    author: new mongoose.Types.ObjectId(),
    provider: 'openai',
    model: 'synthetic-model',
    model_parameters: { model: 'synthetic-model', reasoning_effort: 'high' },
    instructions,
    versions,
  });
}

it('ordinary standalone-compatible saves retain the existing embedded route', async () => {
  const agent = await createAgent({
    id: 'agent-small',
    name: 'Synthetic',
    author: new mongoose.Types.ObjectId(),
    provider: 'openai',
    model: 'synthetic-model',
  });
  const archive = jest.spyOn(AgentVersion, 'createCollection');
  const updated = await updateAgent(
    { id: agent.id },
    { description: 'New synthetic description.' },
  );
  expect(updated.description).toBe('New synthetic description.');
  expect(updated.versions).toHaveLength(2);
  expect(updated.version_count).toBeUndefined();
  expect(archive).not.toHaveBeenCalled();
});

it('an overflowing normal save atomically archives every old snapshot and the new version', async () => {
  const initial = await largeLegacyAgent();
  const oldHashes = initial.versions.map(digest);
  const saved = await updateAgent(
    { id: initial.id },
    { model_parameters: { reasoning_effort: 'low' } },
  );
  expect(saved.model_parameters.reasoning_effort).toBe('low');
  expect(agentVersionCount(saved)).toBe(34);
  expect(saved.versions || []).toHaveLength(0);
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(34);
  const expanded = await getAgent({ id: initial.id }, { includeVersions: true });
  expect(expanded.versions.slice(0, 33).map(digest)).toEqual(oldHashes);
  expect(expanded.versions[33].model_parameters.reasoning_effort).toBe('low');
  const current = await getAgent({ id: initial.id });
  expect(current.versions || []).toHaveLength(0);
  expect(agentVersionCount(current)).toBe(34);
});

it('subsequent saves and indexed reverts preserve the full stable history', async () => {
  const initial = await largeLegacyAgent();
  await updateAgent({ id: initial.id }, { description: 'First new save.' });
  await updateAgent({ id: initial.id }, { description: 'Second new save.' });
  expect(agentVersionCount(await getAgent({ id: initial.id }))).toBe(35);
  const old = await getAgentVersion({ id: initial.id }, 7);
  expect(old.name).toBe('Synthetic history 7');
  const reverted = await revertAgentVersion({ id: initial.id }, 7);
  expect(reverted.name).toBe(old.name);
  expect(reverted.instructions).toBe(old.instructions);
  expect(reverted.tool_resources).toEqual(old.tool_resources);
  expect(agentVersionCount(reverted)).toBe(35);
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(35);
  await expect(revertAgentVersion({ id: initial.id }, 100)).rejects.toThrow(
    'Version 100 not found',
  );
});

it('a failed archive transaction leaves every old version and current configuration intact', async () => {
  const initial = await largeLegacyAgent();
  const oldHashes = initial.versions.map(digest);
  const insert = jest
    .spyOn(AgentVersion, 'create')
    .mockRejectedValueOnce(new Error('Synthetic archive interruption'));
  await expect(
    updateAgent({ id: initial.id }, { description: 'Must not publish.' }),
  ).rejects.toThrow('Synthetic archive interruption');
  insert.mockRestore();
  const current = await Agent.findById(initial._id).lean();
  expect(current.description).not.toBe('Must not publish.');
  expect(current.versions.map(digest)).toEqual(oldHashes);
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(0);
});

it('overflow fails truthfully without dropping history when transactions are unavailable', async () => {
  const initial = await largeLegacyAgent();
  const oldHashes = initial.versions.map(digest);
  jest
    .spyOn(Agent.db.db, 'admin')
    .mockReturnValue({ command: async () => ({ isWritablePrimary: true }) });
  await expect(
    updateAgent({ id: initial.id }, { description: 'Must not publish.' }),
  ).rejects.toMatchObject({ code: 'agent_history_transactions_required' });
  const current = await Agent.findById(initial._id).lean();
  expect(current.versions.map(digest)).toEqual(oldHashes);
  expect(current.version_count).toBeUndefined();
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(0);
});

it('stale concurrent publication cannot replace another accepted configuration or history', async () => {
  const initial = await largeLegacyAgent();
  await updateAgent({ id: initial.id }, { description: 'Archive first.' });
  const stale = await Agent.findById(initial._id).lean();
  await updateAgent({ id: initial.id }, { description: 'Accepted newer settings.' });
  await expect(
    history.saveArchivedUpdate(stale, { $set: { description: 'Stale overwrite.' } }, null),
  ).rejects.toMatchObject({ code: 'agent_version_conflict' });
  const current = await Agent.findById(initial._id).lean();
  expect(current.description).toBe('Accepted newer settings.');
  expect(current.version_count).toBe(35);
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(35);
});

it('a concurrent history insertion conflict reports reload guidance and preserves the accepted save', async () => {
  const initial = await largeLegacyAgent();
  await updateAgent({ id: initial.id }, { description: 'Archive first.' });
  const stale = await Agent.findById(initial._id).lean();
  await updateAgent({ id: initial.id }, { description: 'Accepted newer settings.' });
  await expect(
    history.saveArchivedUpdate(
      stale,
      { $set: { description: 'Stale overwrite.' } },
      { name: 'Stale synthetic snapshot.' },
    ),
  ).rejects.toMatchObject({ code: 'agent_version_conflict', statusCode: 409 });
  const current = await Agent.findById(initial._id).lean();
  expect(current.description).toBe('Accepted newer settings.');
  expect(current.version_count).toBe(35);
  expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(35);
});

it.each(['single', 'owner'])(
  'explicit %s deletion removes only its archived history',
  async (mode) => {
    const initial = await largeLegacyAgent();
    await updateAgent({ id: initial.id }, { description: 'Archive for deletion.' });
    const otherId = new mongoose.Types.ObjectId();
    await AgentVersion.create({
      _id: otherId.toString() + ':0',
      agentObjectId: otherId,
      index: 0,
      snapshot: { name: 'Other synthetic history.' },
    });
    if (mode === 'single') await deleteAgent({ id: initial.id });
    else await deleteUserAgents(initial.author.toString());
    expect(await Agent.findById(initial._id)).toBeNull();
    expect(await AgentVersion.countDocuments({ agentObjectId: initial._id })).toBe(0);
    expect(await AgentVersion.countDocuments({ agentObjectId: otherId })).toBe(1);
  },
);
/* === VIVENTIUM END === */
