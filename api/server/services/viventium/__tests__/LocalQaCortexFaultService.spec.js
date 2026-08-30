/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 durable local-QA fault-control adapter tests.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  createLocalQaCortexFaultService,
  createMongoSyntheticScopeVerifier,
} = require('../LocalQaCortexFaultService');

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CASE_TOKEN = 'A'.repeat(43);
const CASE_TOKEN_HASH = `sha256:${crypto
  .createHash('sha256')
  .update(`case-token\u0000${CASE_TOKEN}`)
  .digest('hex')}`;
const COMPONENT_ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;
const SCOPE = {
  ownerId: '64b000000000000000000048',
  conversationId: `emo_uc_048_conversation_${'b'.repeat(32)}`,
  parentMessageId: `emo_uc_048_parent_${'c'.repeat(32)}`,
};
const AUTHORITY_COLLECTION = 'local_qa_cortex_fault_issuances';
const RECEIPT_COLLECTION = 'local_qa_cortex_fault_terminal_receipts';

function scopeHash(kind, value) {
  return `sha256:${crypto.createHash('sha256').update(`${kind}\u0000${value}`).digest('hex')}`;
}

describe('LocalQaCortexFaultService', () => {
  let mongoServer;
  let database;
  let ControlModel;
  let UserModel;
  let ConversationModel;
  let MessageModel;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    const models = createModels(database);
    ControlModel = models.LocalQaCortexFaultControl;
    UserModel = models.User;
    ConversationModel = models.Conversation;
    MessageModel = models.Message;
    await ControlModel.syncIndexes();
  });

  afterEach(async () => {
    await Promise.all([
      ControlModel.collection.deleteMany({}),
      database.connection.collection(AUTHORITY_COLLECTION).deleteMany({}),
      database.connection.collection(RECEIPT_COLLECTION).deleteMany({}),
      UserModel.collection.deleteMany({}),
      ConversationModel.collection.deleteMany({}),
      MessageModel.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  function service(envOverrides = {}, serviceOverrides = {}) {
    return createLocalQaCortexFaultService({
      ControlModel,
      UserModel,
      ConversationModel,
      MessageModel,
      env: {
        NODE_ENV: 'production',
        VIVENTIUM_LOCAL_QA_MODE: 'emo_uc_048',
        VIVENTIUM_LOCAL_QA_CASE_TOKEN: CASE_TOKEN,
        VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: COMPONENT_ARTIFACT_DIGEST,
        ...envOverrides,
      },
      ...serviceOverrides,
    });
  }

  async function createSyntheticFixture(
    scope = SCOPE,
    expiresAt = new Date(Date.now() + 60 * 60 * 1_000),
  ) {
    await UserModel.create({
      _id: scope.ownerId,
      email: `emo-uc-048-${'a'.repeat(32)}@local-qa.invalid`,
      provider: 'viventium_local_qa_fixture',
      idOnTheSource: `viventium:local-qa:emo_uc_048:${CASE_TOKEN_HASH}`,
      expiresAt,
    });
    await ConversationModel.create({
      user: scope.ownerId,
      conversationId: scope.conversationId,
      endpoint: 'openAI',
      title: 'EMO-UC-048 local QA fixture',
      tags: ['viventium:local-qa:emo_uc_048', CASE_TOKEN_HASH],
      expiredAt: expiresAt,
    });
    await MessageModel.create({
      user: scope.ownerId,
      conversationId: scope.conversationId,
      messageId: scope.parentMessageId,
      isCreatedByUser: false,
      text: '',
      expiredAt: expiresAt,
      metadata: {
        viventium: {
          localQaFixture: {
            schemaVersion: 1,
            caseId: 'emo_uc_048',
            componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
            caseTokenHash: CASE_TOKEN_HASH,
            ownerScopeHash: scopeHash('owner', scope.ownerId),
            conversationScopeHash: scopeHash('conversation', scope.conversationId),
            parentScopeHash: scopeHash('parent', scope.parentMessageId),
            expiresAt,
          },
        },
      },
    });
  }

  function capabilityKey(boundary) {
    const binding = [
      'emo-uc-048-capability',
      CASE_TOKEN_HASH,
      COMPONENT_ARTIFACT_DIGEST,
      boundary,
      scopeHash('owner', SCOPE.ownerId),
      scopeHash('conversation', SCOPE.conversationId),
      scopeHash('parent', SCOPE.parentMessageId),
    ].join('\u0000');
    return `sha256:${crypto.createHash('sha256').update(binding).digest('hex')}`;
  }

  function rawArmedControl(boundary, controlId) {
    const armedAt = new Date('2026-08-23T12:00:00.000Z');
    const expiresAt = new Date('2026-08-23T12:15:00.000Z');
    return {
      schemaVersion: 1,
      controlId,
      capabilityKey: capabilityKey(boundary),
      caseTokenHash: CASE_TOKEN_HASH,
      componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
      boundary,
      ownerScopeHash: scopeHash('owner', SCOPE.ownerId),
      conversationScopeHash: scopeHash('conversation', SCOPE.conversationId),
      parentScopeHash: scopeHash('parent', SCOPE.parentMessageId),
      syntheticScope: true,
      state: 'armed',
      armedAt,
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + 24 * 60 * 60 * 1_000),
      consumedAt: null,
      clearedAt: null,
      audit: [{ sequence: 1, event: 'armed', at: armedAt }],
    };
  }

  function rearmedProjection(row) {
    const rearmed = {
      ...row,
      state: 'armed',
      audit: [row.audit[0]],
    };
    delete rearmed.consumedAt;
    delete rearmed.clearedAt;
    return rearmed;
  }

  test('rejects caller-asserted synthetic scope when the durable rows are ordinary user data', async () => {
    const ownerId = new database.Types.ObjectId().toString();
    const realScope = {
      ownerId,
      conversationId: 'ordinary-conversation-row',
      parentMessageId: 'ordinary-parent-row',
    };
    await UserModel.create({
      _id: ownerId,
      email: 'ordinary-row@example.invalid',
      provider: 'local',
    });
    await ConversationModel.create({
      user: ownerId,
      conversationId: realScope.conversationId,
      endpoint: 'openAI',
      title: 'Ordinary row',
    });
    await MessageModel.create({
      user: ownerId,
      conversationId: realScope.conversationId,
      messageId: realScope.parentMessageId,
      isCreatedByUser: false,
      text: 'ordinary synthetic test text',
    });

    await expect(
      service().arm({
        boundary: 'cortex_ledger_first_write',
        ...realScope,
      }),
    ).rejects.toMatchObject({ code: 'cortex_local_qa_synthetic_fixture_unverified' });
    await expect(ControlModel.countDocuments({})).resolves.toBe(0);
  });

  test.each([
    ['expired fixture', async () => createSyntheticFixture(SCOPE, new Date(Date.now() + 500))],
    [
      'wrong-token fixture marker',
      async () => {
        await createSyntheticFixture();
        await MessageModel.updateOne(
          { messageId: SCOPE.parentMessageId },
          {
            $set: { 'metadata.viventium.localQaFixture.caseTokenHash': `sha256:${'0'.repeat(64)}` },
          },
        );
      },
    ],
    [
      'cross-owner parent row',
      async () => {
        await createSyntheticFixture();
        await MessageModel.updateOne(
          { messageId: SCOPE.parentMessageId },
          { $set: { user: '64b000000000000000000049' } },
        );
      },
    ],
  ])('rejects an adversarial %s', async (_label, arrange) => {
    await arrange();
    await expect(
      service().arm({
        boundary: 'web_replay_persistence',
        ...SCOPE,
        expiresInMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'cortex_local_qa_synthetic_fixture_unverified' });
    await expect(ControlModel.countDocuments({})).resolves.toBe(0);
  });

  test.each([
    [
      'extra fixture marker field',
      async () => {
        await createSyntheticFixture();
        await MessageModel.updateOne(
          { messageId: SCOPE.parentMessageId },
          { $set: { 'metadata.viventium.localQaFixture.unexpected': true } },
        );
      },
      {},
      'cortex_local_qa_synthetic_fixture_unverified',
    ],
    [
      'wrong component artifact digest',
      async () => {
        await createSyntheticFixture();
        await MessageModel.updateOne(
          { messageId: SCOPE.parentMessageId },
          {
            $set: {
              'metadata.viventium.localQaFixture.componentArtifactDigest': `sha256:${'e'.repeat(64)}`,
            },
          },
        );
      },
      {},
      'cortex_local_qa_synthetic_fixture_unverified',
    ],
    [
      'missing process component artifact digest',
      async () => createSyntheticFixture(),
      { VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: '' },
      'cortex_local_qa_component_artifact_invalid',
    ],
  ])('rejects %s before arming', async (_label, arrange, envOverrides, expectedCode) => {
    await arrange();
    await expect(
      service(envOverrides).arm({
        boundary: 'web_replay_persistence',
        ...SCOPE,
        expiresInMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: expectedCode });
    await expect(ControlModel.countDocuments({})).resolves.toBe(0);
  });

  test.each([
    ['Z suffix', '2026-08-23T12:00:00.000Z', '2026-08-23T12:01:00.000+00:00'],
    ['missing milliseconds', '2026-08-23T12:00:00+00:00', '2026-08-23T12:01:00.000+00:00'],
    ['extra fractional digit', '2026-08-23T12:00:00.000+00:00', '2026-08-23T12:01:00.0000+00:00'],
  ])('rejects synthetic verification with a %s timestamp', async (_label, armedAt, expiresAt) => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    const verify = createMongoSyntheticScopeVerifier(
      () => ({ User: UserModel, Conversation: ConversationModel, Message: MessageModel }),
      {
        env: {
          VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: COMPONENT_ARTIFACT_DIGEST,
        },
      },
    );

    await expect(
      verify({
        scope: SCOPE,
        caseTokenHash: CASE_TOKEN_HASH,
        componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
        ownerScopeHash: scopeHash('owner', SCOPE.ownerId),
        conversationScopeHash: scopeHash('conversation', SCOPE.conversationId),
        parentScopeHash: scopeHash('parent', SCOPE.parentMessageId),
        armedAt,
        expiresAt,
      }),
    ).resolves.toBe(false);
  });

  test('accepts exact canonical synthetic verification timestamps', async () => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    const verify = createMongoSyntheticScopeVerifier(
      () => ({ User: UserModel, Conversation: ConversationModel, Message: MessageModel }),
      {
        env: {
          VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: COMPONENT_ARTIFACT_DIGEST,
        },
      },
    );

    await expect(
      verify({
        scope: SCOPE,
        caseTokenHash: CASE_TOKEN_HASH,
        componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
        ownerScopeHash: scopeHash('owner', SCOPE.ownerId),
        conversationScopeHash: scopeHash('conversation', SCOPE.conversationId),
        parentScopeHash: scopeHash('parent', SCOPE.parentMessageId),
        armedAt: '2026-08-23T12:00:00.000+00:00',
        expiresAt: '2026-08-23T12:01:00.000+00:00',
      }),
    ).resolves.toBe(true);
  });

  test('does not consume an armed control after restart under a different component artifact', async () => {
    await createSyntheticFixture();
    const original = service();
    await original.arm({
      boundary: 'web_redis_publish_ack',
      ...SCOPE,
    });

    const restartedWithStaleArtifact = service({
      VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: `sha256:${'e'.repeat(64)}`,
    });
    await expect(
      restartedWithStaleArtifact.consume({ boundary: 'web_redis_publish_ack', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
    await expect(
      original.consume({ boundary: 'web_redis_publish_ack', ...SCOPE }),
    ).resolves.toMatchObject({ triggered: true });
  });

  test('does not expire or clear after the durable case and candidate binding disappears', async () => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    let now = new Date('2026-08-23T12:00:00.000Z');
    const controls = service({}, { now: () => now });
    await controls.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
      expiresInMs: 1_000,
    });
    await controls.arm({
      boundary: 'web_replay_persistence',
      ...SCOPE,
      expiresInMs: 60_000,
    });
    await MessageModel.collection.deleteOne({ messageId: SCOPE.parentMessageId });
    now = new Date('2026-08-23T12:00:02.000Z');

    await expect(controls.query({ ...SCOPE })).resolves.toEqual([]);
    await expect(controls.clear({ boundary: 'web_replay_persistence', ...SCOPE })).resolves.toEqual(
      { cleared: 0 },
    );
    await expect(ControlModel.countDocuments({ state: 'armed' })).resolves.toBe(2);
  });

  test('atomically consumes once across restarted service instances', async () => {
    await createSyntheticFixture();
    await service().arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
    });

    const restarted = service();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        restarted.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
      ),
    );

    expect(results.filter((result) => result.triggered)).toHaveLength(1);
    const row = await ControlModel.findOne({}).lean();
    expect(row).toMatchObject({
      state: 'consumed',
      syntheticScope: true,
      audit: [
        { event: 'armed', sequence: 1 },
        { event: 'consumed', sequence: 2 },
      ],
    });
    expect(JSON.stringify(row)).not.toContain(CASE_TOKEN);
    expect(JSON.stringify(row)).not.toContain(SCOPE.ownerId);

    const issuanceCollection = database.connection.collection(AUTHORITY_COLLECTION);
    const receiptCollection = database.connection.collection(RECEIPT_COLLECTION);
    const [issuance, receipt, issuanceIndexes, receiptIndexes] = await Promise.all([
      issuanceCollection.findOne({}),
      receiptCollection.findOne({}),
      issuanceCollection.indexes(),
      receiptCollection.indexes(),
    ]);
    expect(issuance).toMatchObject({
      capabilityKey: row.capabilityKey,
      componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
      purgeAt: row.purgeAt,
    });
    expect(receipt).toMatchObject({
      capabilityKey: row.capabilityKey,
      terminalState: 'consumed',
      purgeAt: row.purgeAt,
    });
    expect(await receiptCollection.countDocuments({})).toBe(1);
    expect(issuanceIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { capabilityKey: 1 }, unique: true }),
        expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
    expect(receiptIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { capabilityKey: 1 }, unique: true }),
        expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
    expect(JSON.stringify({ issuance, receipt })).not.toContain(CASE_TOKEN);
    expect(JSON.stringify({ issuance, receipt })).not.toContain(SCOPE.ownerId);
    expect(JSON.stringify({ issuance, receipt })).not.toContain(SCOPE.conversationId);
    expect(JSON.stringify({ issuance, receipt })).not.toContain(SCOPE.parentMessageId);

    const Receipt = database.model('LocalQaCortexFaultTerminalReceipt');
    const receiptDocument = await Receipt.findOne({}).orFail();
    receiptDocument.terminalState = 'cleared';
    await expect(receiptDocument.save()).rejects.toThrow(/immutable/);
    await expect(receiptCollection.findOne({})).resolves.toMatchObject({
      terminalState: 'consumed',
    });
  });

  test('blocks a second consume after terminal receipt deletion, raw control replacement, and restart', async () => {
    await createSyntheticFixture();
    const firstBoot = service();
    await firstBoot.arm({ boundary: 'web_replay_persistence', ...SCOPE });
    await expect(
      firstBoot.consume({ boundary: 'web_replay_persistence', ...SCOPE }),
    ).resolves.toMatchObject({ triggered: true });
    const consumed = await ControlModel.findOne({}).lean();

    await database.connection.collection(RECEIPT_COLLECTION).deleteOne({
      capabilityKey: consumed.capabilityKey,
    });
    await ControlModel.collection.replaceOne({ _id: consumed._id }, rearmedProjection(consumed));

    await expect(
      service().consume({ boundary: 'web_replay_persistence', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
    await expect(
      service().query({ boundary: 'web_replay_persistence', ...SCOPE }),
    ).resolves.toEqual([
      expect.objectContaining({
        controlId: consumed.controlId,
        state: 'consumed',
        audit: [
          expect.objectContaining({ sequence: 1, event: 'armed' }),
          expect.objectContaining({ sequence: 2, event: 'consumed' }),
        ],
      }),
    ]);
    await expect(
      database.connection.collection(AUTHORITY_COLLECTION).findOne({
        capabilityKey: consumed.capabilityKey,
      }),
    ).resolves.toMatchObject({ authorityState: 'consumed' });
  });

  test('surfaces and repairs an issuance when arm crashes before the control write', async () => {
    await createSyntheticFixture();
    const firstControlId = 'emo048_00000000-0000-4000-8000-000000000061';
    const secondControlId = 'emo048_00000000-0000-4000-8000-000000000062';
    const create = jest
      .spyOn(ControlModel, 'create')
      .mockRejectedValueOnce(new Error('simulated_before_control_write_crash'));
    await expect(
      service({}, { randomUUID: () => firstControlId.slice('emo048_'.length) }).arm({
        boundary: 'web_redis_publish_ack',
        ...SCOPE,
      }),
    ).rejects.toThrow('simulated_before_control_write_crash');
    create.mockRestore();

    await expect(ControlModel.countDocuments({})).resolves.toBe(0);
    await expect(service().query({ boundary: 'web_redis_publish_ack', ...SCOPE })).resolves.toEqual(
      [
        expect.objectContaining({
          controlId: firstControlId,
          state: 'inconsistent',
          inconsistency: 'control_projection_missing',
        }),
      ],
    );

    const repaired = await service(
      {},
      { randomUUID: () => secondControlId.slice('emo048_'.length) },
    ).arm({
      boundary: 'web_redis_publish_ack',
      ...SCOPE,
    });
    expect(repaired).toMatchObject({ controlId: firstControlId, state: 'armed' });
    await expect(
      database.connection.collection(AUTHORITY_COLLECTION).countDocuments({}),
    ).resolves.toBe(1);
    await expect(ControlModel.countDocuments({ controlId: firstControlId })).resolves.toBe(1);
    await expect(ControlModel.countDocuments({ controlId: secondControlId })).resolves.toBe(0);
  });

  test('recovers the same issuance when arm crashes after the control write', async () => {
    await createSyntheticFixture();
    const firstControlId = 'emo048_00000000-0000-4000-8000-000000000063';
    const originalCreate = ControlModel.create.bind(ControlModel);
    const create = jest.spyOn(ControlModel, 'create').mockImplementationOnce(async (value) => {
      await originalCreate(value);
      throw new Error('simulated_after_control_write_crash');
    });
    await expect(
      service({}, { randomUUID: () => firstControlId.slice('emo048_'.length) }).arm({
        boundary: 'telegram_promoted_parent_presentation',
        ...SCOPE,
      }),
    ).rejects.toThrow('simulated_after_control_write_crash');
    create.mockRestore();

    await expect(
      service().query({ boundary: 'telegram_promoted_parent_presentation', ...SCOPE }),
    ).resolves.toEqual([expect.objectContaining({ controlId: firstControlId, state: 'armed' })]);
    await expect(
      service().arm({ boundary: 'telegram_promoted_parent_presentation', ...SCOPE }),
    ).resolves.toMatchObject({ controlId: firstControlId, state: 'armed' });
    await expect(
      database.connection.collection(AUTHORITY_COLLECTION).countDocuments({}),
    ).resolves.toBe(1);
    await expect(ControlModel.countDocuments({})).resolves.toBe(1);
  });

  test('exact clear terminalizes a surfaced missing-control issuance', async () => {
    await createSyntheticFixture();
    const create = jest
      .spyOn(ControlModel, 'create')
      .mockRejectedValueOnce(new Error('simulated_before_control_write_crash'));
    await expect(
      service().arm({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).rejects.toThrow('simulated_before_control_write_crash');
    create.mockRestore();

    await expect(
      service().clear({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ cleared: 1 });
    await expect(
      service().query({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual([expect.objectContaining({ state: 'cleared' })]);
    await expect(
      service().arm({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).rejects.toMatchObject({ code: 'cortex_local_qa_fault_already_exists' });
  });

  test.each([
    [
      'model bulk update',
      async (row) => {
        await expect(
          ControlModel.bulkWrite([
            {
              updateOne: {
                filter: { _id: row._id },
                update: {
                  $set: { state: 'armed', audit: [row.audit[0]] },
                  $unset: { consumedAt: 1, clearedAt: 1 },
                },
              },
            },
          ]),
        ).rejects.toThrow('local_qa_cortex_fault_control_update_rejected');
      },
      false,
    ],
    [
      'direct collection update',
      async (row) =>
        ControlModel.collection.updateOne(
          { _id: row._id },
          {
            $set: { state: 'armed', audit: [row.audit[0]] },
            $unset: { consumedAt: 1, clearedAt: 1 },
          },
        ),
      true,
    ],
    [
      'direct collection replacement',
      async (row) => ControlModel.collection.replaceOne({ _id: row._id }, rearmedProjection(row)),
      true,
    ],
  ])(
    'does not make a consumed capability usable after %s across restart',
    async (_label, rearm, projectionRearmed) => {
      await createSyntheticFixture();
      const firstBoot = service();
      await firstBoot.arm({ boundary: 'web_replay_persistence', ...SCOPE });
      await expect(
        firstBoot.consume({ boundary: 'web_replay_persistence', ...SCOPE }),
      ).resolves.toMatchObject({ triggered: true });
      const consumed = await ControlModel.findOne({}).lean();

      await rearm(consumed);
      await expect(ControlModel.findOne({}).lean()).resolves.toMatchObject({
        state: projectionRearmed ? 'armed' : 'consumed',
      });
      await expect(
        service().consume({ boundary: 'web_replay_persistence', ...SCOPE }),
      ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
      await expect(
        service().query({ boundary: 'web_replay_persistence', ...SCOPE }),
      ).resolves.toEqual([
        expect.objectContaining({
          state: 'consumed',
          audit: [
            expect.objectContaining({ sequence: 1, event: 'armed' }),
            expect.objectContaining({ sequence: 2, event: 'consumed' }),
          ],
        }),
      ]);
    },
  );

  test.each([
    ['direct model create', async (row) => ControlModel.create(row)],
    ['direct model insertMany', async (row) => ControlModel.insertMany([row])],
    [
      'direct collection upsert',
      async (row) =>
        ControlModel.collection.updateOne(
          { controlId: row.controlId },
          { $setOnInsert: row },
          { upsert: true },
        ),
    ],
  ])('does not make a %s into a usable capability', async (_label, insert) => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    const boundary = 'web_redis_publish_ack';
    const row = rawArmedControl(boundary, 'emo048_00000000-0000-4000-8000-000000000099');
    await insert(row);

    const fixedNow = new Date('2026-08-23T12:00:01.000Z');
    await expect(
      service({}, { now: () => fixedNow }).consume({ boundary, ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
  });

  test.each([
    [
      'control identity rewrite',
      async (row) =>
        ControlModel.collection.updateOne(
          { _id: row._id },
          { $set: { controlId: 'emo048_00000000-0000-4000-8000-000000000088' } },
        ),
    ],
    [
      'candidate artifact rewrite',
      async (row) =>
        ControlModel.collection.updateOne(
          { _id: row._id },
          { $set: { componentArtifactDigest: `sha256:${'e'.repeat(64)}` } },
        ),
    ],
    [
      'expiry extension',
      async (row) => {
        const expiresAt = new Date('2026-08-23T12:01:00.000Z');
        return ControlModel.collection.updateOne(
          { _id: row._id },
          {
            $set: {
              expiresAt,
              purgeAt: new Date(expiresAt.getTime() + 24 * 60 * 60 * 1_000),
            },
          },
        );
      },
    ],
  ])('fails closed after an armed %s', async (_label, mutate) => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    let now = new Date('2026-08-23T12:00:00.000Z');
    const controls = service({}, { now: () => now });
    await controls.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
      expiresInMs: 1_000,
    });
    const armed = await ControlModel.findOne({}).lean();
    await mutate(armed);
    if (_label === 'expiry extension') now = new Date('2026-08-23T12:00:02.000Z');

    await expect(
      controls.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
  });

  test('returns canonical offset receipts while Mongo comparisons retain the exact instant', async () => {
    await createSyntheticFixture(SCOPE, new Date('2026-08-24T12:00:00.000Z'));
    const fixedNow = new Date('2026-08-23T12:00:00.123Z');
    const controls = service(
      {},
      {
        now: () => fixedNow,
        randomUUID: () => '00000000-0000-4000-8000-000000000048',
      },
    );

    const armed = await controls.arm({
      boundary: 'web_redis_publish_ack',
      ...SCOPE,
      expiresInMs: 1_000,
    });
    expect(armed).toMatchObject({
      armedAt: '2026-08-23T12:00:00.123+00:00',
      expiresAt: '2026-08-23T12:00:01.123+00:00',
      purgeAt: '2026-08-24T12:00:01.123+00:00',
      audit: [{ at: '2026-08-23T12:00:00.123+00:00' }],
    });

    const persisted = await ControlModel.findOne({ controlId: armed.controlId }).lean();
    expect(persisted.armedAt).toEqual(new Date('2026-08-23T12:00:00.123Z'));
    expect(persisted.expiresAt).toEqual(new Date('2026-08-23T12:00:01.123Z'));
    await expect(controls.query({ boundary: 'web_redis_publish_ack', ...SCOPE })).resolves.toEqual([
      expect.objectContaining({
        armedAt: '2026-08-23T12:00:00.123+00:00',
        expiresAt: '2026-08-23T12:00:01.123+00:00',
      }),
    ]);
  });

  test('does not consume wrong scope and clears an armed control through the operator interface', async () => {
    await createSyntheticFixture();
    const controls = service();
    await controls.arm({
      boundary: 'telegram_promoted_parent_presentation',
      ...SCOPE,
    });
    await expect(
      controls.consume({
        boundary: 'telegram_promoted_parent_presentation',
        ...SCOPE,
        parentMessageId: 'other-parent',
      }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
    await expect(
      controls.clear({ boundary: 'telegram_promoted_parent_presentation', ...SCOPE }),
    ).resolves.toEqual({ cleared: 1 });
    await expect(
      controls.consume({ boundary: 'telegram_promoted_parent_presentation', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
  });

  test('runs the real CLI arm, query, and clear lifecycle through a private file', async () => {
    await createSyntheticFixture();
    const { main } = require(
      path.resolve(__dirname, '../../../../../scripts/viventium-cortex-fault-control.js'),
    );
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emo048-real-cli-')));
    const scopeFile = path.join(directory, 'scope.json');
    const env = {
      NODE_ENV: 'production',
      VIVENTIUM_LOCAL_QA_MODE: 'emo_uc_048',
      VIVENTIUM_LOCAL_QA_CASE_TOKEN: CASE_TOKEN,
      VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: COMPONENT_ARTIFACT_DIGEST,
      MONGO_URI: mongoServer.getUri(),
    };
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      fs.writeFileSync(
        scopeFile,
        JSON.stringify({
          schemaVersion: 1,
          scope: SCOPE,
          boundary: 'web_replay_persistence',
          ttlSeconds: 60,
        }),
        { mode: 0o600 },
      );
      const descriptor = fs.openSync(scopeFile, 'r');
      try {
        await expect(main(['arm', '--scope-fd', String(descriptor), '--json'], env)).resolves.toBe(
          0,
        );
      } finally {
        fs.closeSync(descriptor);
      }
      fs.writeFileSync(
        scopeFile,
        JSON.stringify({
          schemaVersion: 1,
          scope: SCOPE,
          boundary: 'web_replay_persistence',
        }),
      );
      await expect(main(['query', '--scope-file', scopeFile, '--json'], env)).resolves.toBe(0);
      await expect(main(['clear', '--scope-file', scopeFile, '--json'], env)).resolves.toBe(0);

      const output = stdout.mock.calls.map(([value]) => String(value)).join('');
      expect(output).toContain('ownerScopeHash');
      expect(output).toContain('"state": "armed"');
      expect(output).toContain('"cleared": 1');
      expect(output).not.toContain(CASE_TOKEN);
      expect(output).not.toContain(SCOPE.ownerId);
      expect(output).not.toContain(SCOPE.conversationId);
      expect(output).not.toContain(SCOPE.parentMessageId);
    } finally {
      stdout.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
