/* === VIVENTIUM START === Durable GlassHive terminal-result receiver CAS tests. === VIVENTIUM END === */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createGlassHiveTerminalCallbackResultModel } from '~/models/glassHiveTerminalCallbackResult';
import {
  acquireGlassHiveTerminalCallbackEffectLease,
  compareAndSetGlassHiveTerminalCallbackResult,
  releaseGlassHiveTerminalCallbackEffectLease,
  renewGlassHiveTerminalCallbackEffectLease,
} from '~/methods/glassHiveTerminalCallbackResult';
import type { GlassHiveTerminalCallbackResultIdentity } from '~/types/glassHiveTerminalCallbackResult';

function identity(
  resultRevision: number,
  digestCharacter: string,
): GlassHiveTerminalCallbackResultIdentity {
  return {
    ownerId: 'owner-receiver-cas',
    originRef: 'ghi_receiver_cas_origin',
    workRef: 'gh_receiver_cas_work',
    workerId: 'wrk_receiver_cas',
    runId: 'run_receiver_cas',
    callbackId: `cb_terminal_${digestCharacter.repeat(64)}`,
    attemptNumber: 1,
    resultState: 'completed',
    resultEndedAt: '2026-08-23T18:00:00+00:00',
    resultRevision,
    resultDigest: `sha256:${digestCharacter.repeat(64)}`,
  };
}

describe('GlassHiveTerminalCallbackResult receiver CAS', () => {
  let mongoServer: MongoMemoryServer;
  const database = new mongoose.Mongoose();
  const ResultModel = createGlassHiveTerminalCallbackResultModel(database);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await database.connect(mongoServer.getUri());
    await ResultModel.syncIndexes();
  });

  afterEach(async () => {
    await ResultModel.deleteMany({});
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  test('accepts only increasing revisions and requires exact equal-revision identity', async () => {
    const resultA = identity(1, 'a');
    const equalConflict = identity(1, 'c');
    const resultB = identity(2, 'b');

    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultA }),
    ).resolves.toMatchObject({ status: 'accepted', current: resultA });
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultA }),
    ).resolves.toMatchObject({ status: 'idempotent', current: resultA });
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: equalConflict }),
    ).resolves.toMatchObject({ status: 'conflict', current: resultA });
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultB }),
    ).resolves.toMatchObject({ status: 'accepted', current: resultB });
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultA }),
    ).resolves.toMatchObject({ status: 'superseded', current: resultB });

    await expect(ResultModel.countDocuments({})).resolves.toBe(1);
    await expect(ResultModel.findOne({}).lean()).resolves.toMatchObject({
      callbackId: resultB.callbackId,
      resultRevision: 2,
      resultDigest: resultB.resultDigest,
    });
  });

  test('keeps the highest revision under concurrent first writes', async () => {
    const resultA = identity(1, 'a');
    const resultB = identity(2, 'b');

    await Promise.all([
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultA }),
      compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultB }),
    ]);

    await expect(ResultModel.findOne({}).lean()).resolves.toMatchObject({
      callbackId: resultB.callbackId,
      resultRevision: 2,
      resultDigest: resultB.resultDigest,
    });
  });

  test('fences every effect with the current accepted operation and lease generation', async () => {
    const resultA = identity(1, 'a');
    const resultB = identity(2, 'b');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel,
      incoming: resultA,
    });
    const acquired = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel,
      incoming: resultA,
      acceptedOperationId: acceptedA.acceptedOperationId,
      now: new Date('2026-08-23T18:00:01.000Z'),
      leaseDurationMs: 60_000,
    });
    expect(acquired).toMatchObject({ status: 'acquired' });
    if (acquired.status !== 'acquired') throw new Error('effect lease was not acquired');

    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel,
        incoming: resultB,
        now: new Date('2026-08-23T18:00:02.000Z'),
      }),
    ).rejects.toThrow('glasshive_terminal_callback_effects_in_progress');
    await expect(
      renewGlassHiveTerminalCallbackEffectLease({
        ResultModel,
        lease: { ...acquired.lease, generation: acquired.lease.generation + 1 },
        now: new Date('2026-08-23T18:00:03.000Z'),
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBe(false);
    await expect(
      renewGlassHiveTerminalCallbackEffectLease({
        ResultModel,
        lease: acquired.lease,
        now: new Date('2026-08-23T18:00:03.000Z'),
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      releaseGlassHiveTerminalCallbackEffectLease({ ResultModel, lease: acquired.lease }),
    ).resolves.toBe(true);
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel,
        incoming: resultB,
        now: new Date('2026-08-23T18:00:04.000Z'),
      }),
    ).resolves.toMatchObject({
      status: 'accepted',
      current: resultB,
      acceptedOperationGeneration: 2,
    });
  });

  test('recovers only an expired effect lease after model recreation', async () => {
    const resultA = identity(1, 'a');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel,
      incoming: resultA,
    });
    const firstLease = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel,
      incoming: resultA,
      acceptedOperationId: acceptedA.acceptedOperationId,
      now: new Date('2026-08-23T18:00:01.000Z'),
      leaseDurationMs: 1_000,
    });
    expect(firstLease.status).toBe('acquired');
    const ReloadedModel = createGlassHiveTerminalCallbackResultModel(database);

    await expect(
      acquireGlassHiveTerminalCallbackEffectLease({
        ResultModel: ReloadedModel,
        incoming: resultA,
        acceptedOperationId: acceptedA.acceptedOperationId,
        now: new Date('2026-08-23T18:00:03.000Z'),
        leaseDurationMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: 'acquired',
      lease: { generation: 2, acceptedOperationGeneration: 1 },
    });
  });

  test('retains the winner across service recreation without a TTL', async () => {
    const resultB = identity(2, 'b');
    await compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming: resultB });
    const ReloadedModel = createGlassHiveTerminalCallbackResultModel(database);

    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: ReloadedModel,
        incoming: identity(1, 'a'),
      }),
    ).resolves.toMatchObject({ status: 'superseded', current: resultB });
    expect(ResultModel.schema.indexes()).not.toEqual(
      expect.arrayContaining([
        [expect.anything(), expect.objectContaining({ expireAfterSeconds: 0 })],
      ]),
    );
  });

  test('stores no callback payload, message, result text, or private content field', () => {
    for (const forbidden of [
      'payload',
      'payloadJson',
      'message',
      'text',
      'outputText',
      'errorText',
      'privateContent',
    ]) {
      expect(ResultModel.schema.path(forbidden)).toBeUndefined();
    }
  });
});
