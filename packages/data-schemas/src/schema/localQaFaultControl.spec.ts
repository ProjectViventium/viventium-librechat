import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLocalQaCortexFaultControlModel } from '~/models/localQaCortexFaultControl';

const HASH = `sha256:${'a'.repeat(64)}`;
const SECOND_HASH = `sha256:${'b'.repeat(64)}`;
const CAPABILITY_KEY = `sha256:${'c'.repeat(64)}`;
const COMPONENT_ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;
const base = {
  schemaVersion: 1,
  controlId: 'emo048_00000000-0000-4000-8000-000000000001',
  capabilityKey: CAPABILITY_KEY,
  caseTokenHash: HASH,
  componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
  boundary: 'cortex_ledger_first_write',
  ownerScopeHash: HASH,
  conversationScopeHash: HASH,
  parentScopeHash: HASH,
  syntheticScope: true,
  state: 'armed',
  armedAt: new Date('2026-08-23T12:00:00.000Z'),
  expiresAt: new Date('2026-08-23T12:15:00.000Z'),
  purgeAt: new Date('2026-08-24T12:15:00.000Z'),
  audit: [{ sequence: 1, event: 'armed', at: new Date('2026-08-23T12:00:00.000Z') }],
};

function transitionFilter(
  control = base,
  state: 'consumed' | 'cleared' | 'expired' = 'consumed',
  at = new Date('2026-08-23T12:00:01.000Z'),
) {
  return {
    schemaVersion: 1,
    controlId: control.controlId,
    capabilityKey: control.capabilityKey,
    caseTokenHash: control.caseTokenHash,
    componentArtifactDigest: control.componentArtifactDigest,
    boundary: control.boundary,
    ownerScopeHash: control.ownerScopeHash,
    conversationScopeHash: control.conversationScopeHash,
    parentScopeHash: control.parentScopeHash,
    syntheticScope: true,
    state: 'armed',
    armedAt: control.armedAt,
    expiresAt: {
      $eq: control.expiresAt,
      ...(state === 'expired' ? { $lte: at } : { $gt: at }),
    },
    purgeAt: control.purgeAt,
  };
}

describe('LocalQaCortexFaultControl model', () => {
  let mongoServer: MongoMemoryServer;
  const database = new mongoose.Mongoose();
  const Control = createLocalQaCortexFaultControlModel(database);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await database.connect(mongoServer.getUri());
    await Control.syncIndexes();
  });

  afterEach(async () => {
    await Promise.all([
      Control.collection.deleteMany({}),
      database.connection.collection('local_qa_cortex_fault_issuances').deleteMany({}),
      database.connection.collection('local_qa_cortex_fault_terminal_receipts').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  test('has one bounded TTL audit row per case, boundary, and hashed synthetic scope', () => {
    expect(Control.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ purgeAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
        [
          {
            caseTokenHash: 1,
            componentArtifactDigest: 1,
            boundary: 1,
            ownerScopeHash: 1,
            conversationScopeHash: 1,
            parentScopeHash: 1,
          },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });

  test('rejects malformed, unbound, or overlong audit controls', async () => {
    await expect(Control.create({ ...base, syntheticScope: false })).rejects.toThrow();
    await expect(Control.create({ ...base, caseTokenHash: 'raw-case-token' })).rejects.toThrow();
    await expect(
      Control.create({
        ...base,
        audit: Array.from({ length: 4 }, (_, index) => ({
          sequence: index + 1,
          event: 'armed',
          at: base.armedAt,
        })),
      }),
    ).rejects.toThrow();
  });

  test('allows only atomic projection plus append-only audit transitions', async () => {
    await Control.create(base);
    await expect(
      Control.findOneAndUpdate(
        transitionFilter(),
        {
          $set: { state: 'consumed', consumedAt: new Date('2026-08-23T12:00:01.000Z') },
          $push: {
            audit: {
              sequence: 2,
              event: 'consumed',
              at: new Date('2026-08-23T12:00:01.000Z'),
            },
          },
        },
        { new: true, runValidators: true },
      ),
    ).resolves.toMatchObject({ state: 'consumed' });
    await expect(
      Control.updateOne({ controlId: base.controlId }, { $set: { audit: [] } }),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
    await expect(
      Control.updateOne({ controlId: base.controlId }, { $set: { ownerScopeHash: HASH } }),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
    await expect(
      Control.updateOne(
        { controlId: base.controlId, state: 'armed' },
        {
          $set: { state: 'consumed', consumedAt: new Date('2026-08-23T12:00:02.000Z') },
          $push: {
            audit: {
              sequence: 2,
              event: 'cleared',
              at: new Date('2026-08-23T12:00:02.000Z'),
            },
          },
        },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
  });

  test('rejects updateMany even when its transition shape is otherwise valid', async () => {
    await Control.create([
      base,
      {
        ...base,
        controlId: 'emo048_00000000-0000-4000-8000-000000000002',
        boundary: 'web_replay_persistence',
        parentScopeHash: SECOND_HASH,
      },
    ]);
    const transitionAt = new Date('2026-08-23T12:00:01.000Z');

    await expect(
      Control.updateMany(
        { state: 'armed' },
        {
          $set: { state: 'cleared', clearedAt: transitionAt },
          $push: { audit: { sequence: 2, event: 'cleared', at: transitionAt } },
        },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
    await expect(Control.countDocuments({ state: 'armed' })).resolves.toBe(2);
  });

  test('rejects missing identity and terminal-state transition filters', async () => {
    await Control.create(base);
    const consumedAt = new Date('2026-08-23T12:00:01.000Z');
    await Control.findOneAndUpdate(transitionFilter(), {
      $set: { state: 'consumed', consumedAt },
      $push: { audit: { sequence: 2, event: 'consumed', at: consumedAt } },
    });
    const clearedAt = new Date('2026-08-23T12:00:02.000Z');

    await expect(
      Control.updateOne(
        { controlId: base.controlId },
        {
          $set: { state: 'cleared', clearedAt },
          $push: { audit: { sequence: 2, event: 'cleared', at: clearedAt } },
        },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
    await expect(
      Control.updateOne(
        { controlId: base.controlId, state: 'consumed' },
        {
          $set: { state: 'cleared', clearedAt },
          $push: { audit: { sequence: 2, event: 'cleared', at: clearedAt } },
        },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
  });

  test('rejects model bulkWrite lifecycle mutations', async () => {
    await Control.create(base);
    const consumedAt = new Date('2026-08-23T12:00:01.000Z');

    await expect(
      Control.bulkWrite([
        {
          updateOne: {
            filter: { controlId: base.controlId, state: 'armed' },
            update: {
              $set: { state: 'consumed', consumedAt },
              $push: { audit: { sequence: 2, event: 'consumed', at: consumedAt } },
            },
          },
        },
      ]),
    ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
    await expect(Control.findOne({ controlId: base.controlId }).lean()).resolves.toMatchObject({
      state: 'armed',
      audit: [expect.objectContaining({ sequence: 1, event: 'armed' })],
    });
  });

  test('keeps issuance authority monotonic and rejects every normal model deletion path', async () => {
    const Issuance = database.model('LocalQaCortexFaultIssuance');
    const authority = {
      schemaVersion: 1,
      controlId: base.controlId,
      capabilityKey: base.capabilityKey,
      caseTokenHash: base.caseTokenHash,
      componentArtifactDigest: base.componentArtifactDigest,
      boundary: base.boundary,
      ownerScopeHash: base.ownerScopeHash,
      conversationScopeHash: base.conversationScopeHash,
      parentScopeHash: base.parentScopeHash,
      syntheticScope: true,
      authorityState: 'armed',
      armedAt: base.armedAt,
      expiresAt: base.expiresAt,
      purgeAt: base.purgeAt,
    };
    await Issuance.create(authority);

    await expect(Issuance.deleteOne({ capabilityKey: base.capabilityKey })).rejects.toThrow(
      'local_qa_cortex_fault_issuance_delete_rejected',
    );
    await expect(Issuance.deleteMany({})).rejects.toThrow(
      'local_qa_cortex_fault_issuance_delete_rejected',
    );
    await expect(Issuance.findOneAndDelete({ capabilityKey: base.capabilityKey })).rejects.toThrow(
      'local_qa_cortex_fault_issuance_delete_rejected',
    );
    const issuance = await Issuance.findOne({ capabilityKey: base.capabilityKey }).orFail();
    await expect(issuance.deleteOne()).rejects.toThrow(
      'local_qa_cortex_fault_issuance_delete_rejected',
    );
    await expect(Issuance.countDocuments({})).resolves.toBe(1);
  });

  test('allows only one exact armed-to-terminal issuance CAS and rejects rearm paths', async () => {
    const Issuance = database.model('LocalQaCortexFaultIssuance');
    const authority = {
      schemaVersion: 1,
      controlId: base.controlId,
      capabilityKey: base.capabilityKey,
      caseTokenHash: base.caseTokenHash,
      componentArtifactDigest: base.componentArtifactDigest,
      boundary: base.boundary,
      ownerScopeHash: base.ownerScopeHash,
      conversationScopeHash: base.conversationScopeHash,
      parentScopeHash: base.parentScopeHash,
      syntheticScope: true,
      authorityState: 'armed',
      armedAt: base.armedAt,
      expiresAt: base.expiresAt,
      purgeAt: base.purgeAt,
    };
    await Issuance.create(authority);
    const consumedAt = new Date('2026-08-23T12:00:01.000Z');
    const exactFilter = {
      schemaVersion: 1,
      controlId: base.controlId,
      capabilityKey: base.capabilityKey,
      caseTokenHash: base.caseTokenHash,
      componentArtifactDigest: base.componentArtifactDigest,
      boundary: base.boundary,
      ownerScopeHash: base.ownerScopeHash,
      conversationScopeHash: base.conversationScopeHash,
      parentScopeHash: base.parentScopeHash,
      syntheticScope: true,
      authorityState: 'armed',
      armedAt: base.armedAt,
      expiresAt: { $eq: base.expiresAt, $gt: consumedAt },
      purgeAt: base.purgeAt,
    };

    const consumed = await Issuance.findOneAndUpdate(
      exactFilter,
      { $set: { authorityState: 'consumed', terminalAt: consumedAt } },
      { new: true, runValidators: true },
    ).orFail();
    expect(consumed).toMatchObject({ authorityState: 'consumed', terminalAt: consumedAt });
    await expect(
      Issuance.findOneAndUpdate(
        exactFilter,
        { $set: { authorityState: 'consumed', terminalAt: consumedAt } },
        { new: true, runValidators: true },
      ),
    ).resolves.toBeNull();

    consumed.authorityState = 'armed';
    consumed.terminalAt = undefined;
    await expect(consumed.save()).rejects.toThrow('local_qa_cortex_fault_issuance_update_rejected');
    await expect(
      Issuance.updateOne(
        { capabilityKey: base.capabilityKey },
        { $set: { authorityState: 'armed', terminalAt: null } },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_issuance_update_rejected');
    await expect(
      Issuance.replaceOne(
        { capabilityKey: base.capabilityKey },
        { ...authority, authorityState: 'armed' },
      ),
    ).rejects.toThrow('local_qa_cortex_fault_issuance_update_rejected');
    await expect(Issuance.findOne({}).lean()).resolves.toMatchObject({
      authorityState: 'consumed',
      terminalAt: consumedAt,
    });
  });

  test('rejects document-save state and audit rollback after a control is consumed', async () => {
    await Control.create(base);
    const firstConsumedAt = new Date('2026-08-23T12:00:01.000Z');
    await Control.findOneAndUpdate(
      transitionFilter(base, 'consumed', firstConsumedAt),
      {
        $set: { state: 'consumed', consumedAt: firstConsumedAt },
        $push: {
          audit: { sequence: 2, event: 'consumed', at: firstConsumedAt },
        },
      },
      { new: true, runValidators: true },
    );

    const consumed = await Control.findOne({ controlId: base.controlId }).orFail();
    consumed.state = 'armed';
    consumed.audit = [{ sequence: 1, event: 'armed', at: base.armedAt }];
    await expect(consumed.save()).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');

    const secondConsumedAt = new Date('2026-08-23T12:00:02.000Z');
    await expect(
      Control.findOneAndUpdate(
        transitionFilter(base, 'consumed', secondConsumedAt),
        {
          $set: { state: 'consumed', consumedAt: secondConsumedAt },
          $push: {
            audit: { sequence: 2, event: 'consumed', at: secondConsumedAt },
          },
        },
        { new: true, runValidators: true },
      ),
    ).resolves.toBeNull();
    await expect(Control.findOne({ controlId: base.controlId }).lean()).resolves.toMatchObject({
      state: 'consumed',
      audit: [
        expect.objectContaining({ sequence: 1, event: 'armed' }),
        expect.objectContaining({ sequence: 2, event: 'consumed' }),
      ],
    });
  });

  test.each([
    ['consumed', 'consumedAt'],
    ['cleared', 'clearedAt'],
    ['expired', ''],
  ] as const)(
    'allows a valid armed-to-%s service transition and unchanged save',
    async (state, timestampField) => {
      const control = await Control.create(base);
      await expect(control.save()).resolves.toMatchObject({ state: 'armed' });

      const transitionAt =
        state === 'expired' ? base.expiresAt : new Date('2026-08-23T12:00:01.000Z');
      const set = {
        state,
        ...(timestampField ? { [timestampField]: transitionAt } : {}),
      };
      const transitioned = await Control.findOneAndUpdate(
        transitionFilter(base, state, transitionAt),
        {
          $set: set,
          $push: { audit: { sequence: 2, event: state, at: transitionAt } },
        },
        { new: true, runValidators: true },
      ).orFail();

      await expect(transitioned.save()).resolves.toMatchObject({ state });
    },
  );
});
