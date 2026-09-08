/* === VIVENTIUM START === Durable saved-memory admission uses the existing message store. === */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createMemoryWriteMethods } from './memoryWrite';
import { createMemoryMethods } from './memory';

describe('durable saved-memory admission', () => {
  let server: MongoMemoryServer;
  let writes: ReturnType<typeof createMemoryWriteMethods>;
  let memories: ReturnType<typeof createMemoryMethods>;
  const user = new mongoose.Types.ObjectId().toString();
  const admission = {
    userId: user, messageId: 'answer', conversationId: 'conversation', owner: 'runtime-one',
    source: { digest: 'source-hash', configDigest: 'config-hash', messageIds: ['question'],
      input: 'temporary frozen input', timeContext: 'temporary rendered time', memoryRevisionMap: {},
      interactionContextJson: '{"origin":"external_user","revision":2}' },
  };
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    createModels(mongoose);
    await mongoose.models.MemoryEntry.init();
    writes = createMemoryWriteMethods(mongoose);
    memories = createMemoryMethods(mongoose);
  });
  afterAll(async () => { await mongoose.disconnect(); await server.stop(); });
  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.MemoryEntry.deleteMany({});
    await mongoose.models.Message.create({ messageId: 'answer', user,
      conversationId: 'conversation', attachments: [{ type: 'file', file_id: 'artifact' }] });
  });

  it('admits exactly once on the persisted owner response, without leaking internal source', async () => {
    expect(await writes.admitMemoryWrite({ ...admission, userId: new mongoose.Types.ObjectId().toString() })).toBe(false);
    expect(await writes.admitMemoryWrite({ ...admission, messageId: 'missing' })).toBe(false);
    expect(await writes.admitMemoryWrite(admission)).toBe(true);
    expect(await writes.getMemoryWriteStatus(admission)).toBe('pending');
    expect(await writes.getMemoryWriteStatus({ ...admission, userId: 'other-owner' })).toBeNull();
    expect(await writes.admitMemoryWrite({ ...admission, owner: 'another-runtime' })).toBe(false);
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).lean();
    expect(row.savedMemoryWrite).toBeUndefined();
    const internal = await mongoose.models.Message.findOne({ messageId: 'answer' }).select('+savedMemoryWrite').lean();
    expect(internal.savedMemoryWrite).toMatchObject({ status: 'pending', source: admission.source });
  });

  it('retains admission and effect authority for unchanged writes and persists their terminal receipt', async () => {
    const initial = await memories.setMemory({
      userId: user,
      key: 'preferences',
      value: 'Same fact.',
      expectedRevision: null,
    });
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    const writerEffect = {
      messageId: 'answer',
      owner: admission.owner,
      operationId: 'same-value-operation',
    };
    const same = await memories.setMemory({
      userId: user,
      key: 'preferences',
      value: 'Same fact.',
      expectedRevision: initial.revision,
      writerEffect,
    });
    expect(same).toMatchObject({ ok: true, changed: false, revision: initial.revision + 1 });
    const entry = await mongoose.models.MemoryEntry.findOne({
      userId: user,
      key: 'preferences',
    }).lean();
    expect(entry.writerEffect).toEqual(writerEffect);
    const receipts = [
      {
        type: 'memory',
        memory: { type: 'unchanged', key: 'preferences', revision: same.revision },
      },
    ];
    expect(await writes.completeMemoryWrite({ ...admission, receipts })).toBe(true);
    const saved = await mongoose.models.Message.findOne({ messageId: 'answer' })
      .select('+savedMemoryWrite')
      .lean();
    expect(saved.savedMemoryWrite.status).toBe('completed');
    expect(saved.attachments).toEqual([{ type: 'file', file_id: 'artifact' }, ...receipts]);
    expect(saved.savedMemoryWrite.source.input).toBeUndefined();
    await expect(
      memories.setMemory({
        userId: user,
        key: 'preferences',
        value: 'Same fact.',
        expectedRevision: same.revision,
        writerEffect,
      }),
    ).rejects.toThrow('admission is no longer running');
    expect(
      (await mongoose.models.MemoryEntry.findOne({ userId: user, key: 'preferences' }).lean()).__v,
    ).toBe(same.revision);
  });

  it('claims once and records mutation identity atomically with revision-protected value and tombstone', async () => {
    await writes.admitMemoryWrite(admission);
    expect(await writes.startMemoryWrite(admission)).toBe(true);
    expect(await writes.startMemoryWrite(admission)).toBe(false);
    const writerEffect = { messageId: 'answer', owner: admission.owner, operationId: 'operation-one' };
    const applied = await memories.setMemory({ userId: user, key: 'preferences', value: 'A fact', expectedRevision: null, writerEffect });
    expect(applied.ok).toBe(true);
    const row = await mongoose.models.MemoryEntry.findOne({ userId: user, key: 'preferences' }).lean();
    expect(row.writerEffect).toEqual(writerEffect);
    const removed = await memories.deleteMemory({ userId: user, key: 'preferences', expectedRevision: applied.revision,
      writerEffect: { ...writerEffect, operationId: 'operation-two' } });
    expect(removed.ok).toBe(true);
    const tombstone = await mongoose.models.MemoryEntry.findOne({ userId: user, key: 'preferences' }).lean();
    expect(tombstone.writerEffect.operationId).toBe('operation-two');
    expect(tombstone.deletedAt).toBeInstanceOf(Date);
    expect(await memories.setMemory({ userId: user, key: 'preferences', value: 'stale', expectedRevision: applied.revision, writerEffect }))
      .toMatchObject({ ok: false, conflict: true });
  });

  it('recovers unstarted and partially applied interruptions without replay, and rejects late writes', async () => {
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    const writerEffect = { messageId: 'answer', owner: admission.owner, operationId: 'effect-one' };
    await memories.setMemory({ userId: user, key: 'preferences', value: 'already saved', expectedRevision: null, writerEffect });
    await mongoose.models.Message.updateOne({ messageId: 'answer' }, { $set: { 'savedMemoryWrite.heartbeatAt': new Date(0) } });
    expect(await writes.recoverInterruptedMemoryWrites({ before: new Date(1) })).toBe(1);
    expect(await writes.recoverInterruptedMemoryWrites({ before: new Date(1) })).toBe(0);
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).select('+savedMemoryWrite').lean();
    expect(row.savedMemoryWrite.status).toBe('failed');
    expect(row.attachments[0]).toMatchObject({ file_id: 'artifact' });
    expect(row.attachments[1].memory).toMatchObject({ type: 'error', errorType: 'writer_interrupted', partialApplied: true });
    await expect(memories.setMemory({ userId: user, key: 'context', value: 'late write', expectedRevision: null, writerEffect }))
      .rejects.toThrow('admission is no longer running');
  });

  it('commits the receipt and final state together, preserving other artifacts and avoiding false interruption', async () => {
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    const receipts = [{ type: 'memory', memory: { type: 'update', key: 'preferences', revision: 1, value: 'saved' } }];
    expect(await writes.completeMemoryWrite({ ...admission, receipts })).toBe(true);
    expect(await writes.completeMemoryWrite({ ...admission, receipts })).toBe(false);
    expect(await writes.recoverInterruptedMemoryWrites({ before: new Date(Date.now() + 1000) })).toBe(0);
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).select('+savedMemoryWrite').lean();
    expect(row.savedMemoryWrite.status).toBe('completed');
    expect(row.savedMemoryWrite.source.input).toBeUndefined();
    expect(row.savedMemoryWrite.source.timeContext).toBeUndefined();
    expect(row.attachments).toHaveLength(2);
  });

  it('does not time out another healthy runtime or revive a failed admission', async () => {
    await writes.admitMemoryWrite(admission);
    expect(await writes.refreshMemoryWrites('runtime-two')).toBe(0);
    expect(await writes.refreshMemoryWrites(admission.owner)).toBe(1);
    expect(await writes.recoverInterruptedMemoryWrites({ before: new Date(Date.now() - 1000) })).toBe(0);
    await writes.recoverInterruptedMemoryWrites({ before: new Date(Date.now() + 1000) });
    expect(await writes.startMemoryWrite(admission)).toBe(false);
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).select('+savedMemoryWrite').lean();
    expect(row.attachments[1].memory.partialApplied).toBe(false);
  });

  it('preserves a later correction after an applied write loses its receipt', async () => {
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    const first = await memories.setMemory({ userId: user, key: 'preferences', value: 'old fact', expectedRevision: null,
      writerEffect: { messageId: 'answer', owner: admission.owner, operationId: 'original-effect' } });
    const correction = await memories.setMemory({ userId: user, key: 'preferences', value: 'corrected fact', expectedRevision: first.revision });
    await writes.recoverInterruptedMemoryWrites({ before: new Date(Date.now() + 1000) });
    const row = await mongoose.models.MemoryEntry.findOne({ userId: user, key: 'preferences' }).lean();
    expect(row.value).toBe('corrected fact');
    expect(row.__v).toBe(correction.revision);
    expect(row.writerEffect).toBeUndefined();
  });

  it('reclaims unstarted work exactly once and never reclaims a running writer', async () => {
    await writes.admitMemoryWrite(admission);
    const [row] = await writes.listPendingMemoryWrites({ before: new Date(Date.now() + 1000) });
    const claim = { userId: user, messageId: 'answer', owner: 'replacement',
      previousOwner: row.savedMemoryWrite.owner, heartbeatAt: row.savedMemoryWrite.heartbeatAt };
    const claimed = await Promise.all([writes.reclaimPendingMemoryWrite(claim), writes.reclaimPendingMemoryWrite(claim)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(await writes.startMemoryWrite(claim)).toBe(true);
    expect(await writes.reclaimPendingMemoryWrite({ ...claim, previousOwner: 'replacement' })).toBe(false);
  });

  it('detects later user source and purges interrupted or deleted recovery payloads', async () => {
    await writes.admitMemoryWrite(admission);
    const [row] = await writes.listPendingMemoryWrites({ before: new Date(Date.now() + 1000) });
    expect(await writes.hasNewerMemorySource({ userId: user, admittedAt: row.savedMemoryWrite.admittedAt })).toBe(false);
    await mongoose.models.Message.create({ messageId: 'later-correction', user, conversationId: 'another-conversation',
      isCreatedByUser: true, text: 'A later correction', updatedAt: new Date(Date.now() + 1000) });
    expect(await writes.hasNewerMemorySource({ userId: user, admittedAt: row.savedMemoryWrite.admittedAt })).toBe(true);
    await mongoose.models.Message.updateOne({ messageId: 'answer' }, { $set: { deletedAt: new Date() } });
    await writes.recoverInterruptedMemoryWrites({ before: new Date(Date.now() + 1000) });
    const deleted = await mongoose.models.Message.findOne({ messageId: 'answer', deletedAt: { $ne: null } }).select('+savedMemoryWrite').lean();
    expect(deleted.savedMemoryWrite.source.input).toBeUndefined();
    expect(deleted.savedMemoryWrite.source.timeContext).toBeUndefined();
  });

  it('completes a no-change decision without a saved receipt and stops pending status', async () => {
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    expect(await writes.completeMemoryWrite({ ...admission, receipts: [] })).toBe(true);
    expect(await writes.getMemoryWriteStatus(admission)).toBe('completed');
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).lean();
    expect(row.attachments).toEqual([{ type: 'file', file_id: 'artifact' }]);
  });

  it('preserves file attachments whose optional memory field is null', async () => {
    await mongoose.models.Message.updateOne({ messageId: 'answer' }, { $set: {
      attachments: [{ type: 'file', file_id: 'artifact', memory: null }],
    } });
    await writes.admitMemoryWrite(admission);
    await writes.startMemoryWrite(admission);
    await writes.completeMemoryWrite({ ...admission, receipts: [] });
    const row = await mongoose.models.Message.findOne({ messageId: 'answer' }).lean();
    expect(row.attachments).toEqual([{ type: 'file', file_id: 'artifact', memory: null }]);
  });

  it('permits revision advancement only through earlier accepted writers and refuses intervening panel edits', async () => {
    await writes.admitMemoryWrite({ ...admission, admittedAt: new Date(1) });
    await writes.startMemoryWrite(admission);
    await mongoose.models.Message.create({ messageId: 'later-answer', user, conversationId: 'conversation' });
    const later = { ...admission, messageId: 'later-answer', admittedAt: new Date(2) };
    await writes.admitMemoryWrite(later);
    await writes.startMemoryWrite(later);
    const effect = { messageId: 'answer', owner: admission.owner, operationId: 'first-save' };
    const result = await memories.setMemory({ userId: user, key: 'preferences', value: 'first fact', expectedRevision: null, writerEffect: effect });
    expect(await writes.validateMemoryWriteSnapshot({ ...later, revisions: { preferences: result.revision }, effects: { preferences: effect } })).toBe(true);
    const corrected = await memories.setMemory({ userId: user, key: 'preferences', value: 'panel correction', expectedRevision: result.revision });
    expect(await writes.validateMemoryWriteSnapshot({ ...later, revisions: { preferences: corrected.revision }, effects: {} })).toBe(false);
    await memories.deleteMemory({ userId: user, key: 'preferences', expectedRevision: corrected.revision });
    const tombstone = await mongoose.models.MemoryEntry.findOne({ userId: user, key: 'preferences' }).lean();
    expect(await writes.validateMemoryWriteSnapshot({ ...later, revisions: { preferences: tombstone.__v }, effects: {} })).toBe(false);
  });

  it('refuses snapshot advancement from later, different-owner, deleted, and legacy unguarded admissions', async () => {
    await writes.admitMemoryWrite({ ...admission, admittedAt: new Date(2) });
    await writes.startMemoryWrite(admission);
    await mongoose.models.Message.create({ messageId: 'other-answer', user, conversationId: 'conversation' });
    const other = { ...admission, messageId: 'other-answer', admittedAt: new Date(3) };
    await writes.admitMemoryWrite(other);
    await writes.startMemoryWrite(other);
    const effect = { messageId: other.messageId, owner: other.owner, operationId: 'effect' };
    const check = () => writes.validateMemoryWriteSnapshot({ ...admission, revisions: { preferences: 1 }, effects: { preferences: effect } });
    expect(await check()).toBe(false);
    await mongoose.models.Message.updateOne({ messageId: other.messageId }, { $set: { 'savedMemoryWrite.admittedAt': new Date(1), user: 'another-user' } });
    expect(await check()).toBe(false);
    await mongoose.models.Message.updateOne({ messageId: other.messageId }, { $set: { user, deletedAt: new Date() } });
    expect(await check()).toBe(false);
    await mongoose.models.Message.updateOne({ messageId: other.messageId }, { $set: { deletedAt: null }, $unset: { 'savedMemoryWrite.source.memoryRevisionMap': 1 } });
    expect(await check()).toBe(false);
    expect(await writes.validateMemoryWriteSnapshot({ ...admission, revisions: {}, effects: {} })).toBe(true);
  });
});
