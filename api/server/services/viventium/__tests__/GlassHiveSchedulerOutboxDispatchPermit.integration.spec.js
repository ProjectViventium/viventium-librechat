/* === VIVENTIUM START ===
 * Feature: scheduler terminal-callback dispatch permit.
 * Purpose: A newer Core result cannot win after final authorization but before receiver acceptance.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { schedulerDispatchDocumentId } = require('@librechat/api');
const {
  compareAndSetGlassHiveTerminalCallbackResult,
  fenceGlassHiveTerminalCallbackAcceptedOperationTransaction,
} = require('@librechat/data-schemas');
const {
  GlassHiveTerminalCallbackResult,
  ViventiumGlassHiveCallbackEffectOutbox,
} = require('~/db/models');
const {
  dispatchGlassHiveSchedulerCallbackOutbox,
  enqueueGlassHiveSchedulerCallbackOutbox,
  reconcileGlassHiveSchedulerCallbackOutbox,
} = require('../GlassHiveTerminalCallbackOutboxService');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('../GlassHiveTerminalCallbackTransaction');

function identity(revision, character) {
  return {
    ownerId: 'owner-scheduler-permit',
    originRef: 'origin-scheduler-permit',
    workRef: 'work-scheduler-permit',
    workerId: `worker-${character}`,
    runId: 'run-scheduler-permit',
    callbackId: `cb_terminal_${character.repeat(64)}`,
    attemptNumber: 1,
    resultState: revision === 1 ? 'completed' : 'cancelled',
    resultEndedAt: '2026-08-23T20:00:00.000Z',
    resultRevision: revision,
    resultDigest: `sha256:${character.repeat(64)}`,
  };
}

const schedulerRoot = path.resolve(__dirname, '../../../../../viventium/MCPs/scheduling-cortex');
const sharedRoot = process.env.VIVENTIUM_TEST_PRODUCTION_ROOT
  ? path.join(process.env.VIVENTIUM_TEST_PRODUCTION_ROOT, 'viventium_v0_4', 'shared')
  : path.resolve(schedulerRoot, '../../../../shared');
const schedulerPython = path.join(schedulerRoot, '.venv/bin/python');
const schedulerDriver = String.raw`
import json
import os
import sys

from scheduling_cortex.server import build_server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig
from starlette.testclient import TestClient

request = json.loads(sys.stdin.read())
storage = ScheduleStorage(StorageConfig(db_path=request["db_path"]))
if request["action"] == "seed":
    now = "2026-08-23T20:00:00+00:00"
    storage.create_scheduled_prompt_run({
        "run_id": "scheduled-run-core-http",
        "task_id": "task-core-http",
        "user_id": "owner-scheduler-permit",
        "due_at": now,
        "started_at": now,
        "completed_at": None,
        "status": "running",
        "executor": "glasshive_host",
        "result_summary": "Running.",
        "error_class": None,
        "disposition": "running",
        "occurrence_key": "occurrence-scheduler-permit",
        "created_at": now,
        "updated_at": now,
    })
    response = {"seeded": True}
elif request["action"] == "post":
    os.environ["VIVENTIUM_SCHEDULER_SECRET"] = "synthetic-scheduler-secret"
    client = TestClient(build_server(storage).http_app(transport="streamable-http"))
    received = client.post(
        "/internal/scheduled-prompts/external-work-callback",
        content=request["body"].encode("utf-8"),
        headers=request["headers"],
    )
    response = {"status": received.status_code, "body": received.json()}
elif request["action"] == "read":
    response = {
        "run": storage.get_scheduled_prompt_run("scheduled-run-core-http"),
        "terminal": storage.get_scheduled_terminal_callback_result(
            owner_id="owner-scheduler-permit",
            work_id="scheduled-run-core-http",
        ),
    }
else:
    raise RuntimeError("unknown scheduler driver action")
print(json.dumps(response, separators=(",", ":")))
`;

function runSchedulerDriver(input) {
  const result = spawnSync(schedulerPython, ['-c', schedulerDriver], {
    cwd: schedulerRoot,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, PYTHONPATH: [schedulerRoot, sharedRoot].join(path.delimiter) },
  });
  if (result.status !== 0) {
    throw new Error(`scheduler_driver_failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split('\n').at(-1);
  return JSON.parse(output);
}

describe('GlassHive scheduler outbox final dispatch permit', () => {
  let replicaSet;
  let priorUrl;
  let priorSecret;

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=1000'] }],
    });
    await mongoose.connect(replicaSet.getUri());
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await ViventiumGlassHiveCallbackEffectOutbox.syncIndexes();
  }, 30000);

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await ViventiumGlassHiveCallbackEffectOutbox.syncIndexes();
    priorUrl = process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
    priorSecret = process.env.VIVENTIUM_SCHEDULER_SECRET;
    process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL =
      'https://scheduler.invalid/internal/external-work';
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'synthetic-scheduler-secret';
  });

  afterEach(() => {
    if (priorUrl == null) delete process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
    else process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL = priorUrl;
    if (priorSecret == null) delete process.env.VIVENTIUM_SCHEDULER_SECRET;
    else process.env.VIVENTIUM_SCHEDULER_SECRET = priorSecret;
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await replicaSet?.stop({ doCleanup: true, force: true });
  }, 15000);

  async function enqueueOwnershipCase(occurrenceKey = 'opaque-occurrence') {
    const result = identity(1, 'a');
    const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult, incoming: result,
    });
    const durable = await GlassHiveTerminalCallbackResult.findOne({}).lean();
    return enqueueGlassHiveSchedulerCallbackOutbox({
      binding: { ownerId: result.ownerId, scheduleOccurrenceKey: occurrenceKey },
      summary: { requiredTotal: 1, requiredTerminal: 1, requiredFailed: 0,
        allRequiredTerminal: true, state: 'completed' },
      effectFence: { resultKey: String(durable._id), acceptedOperationId: accepted.acceptedOperationId,
        callbackId: result.callbackId, resultDigest: result.resultDigest, resultRevision: 1, generation: 1 },
    });
  }

  async function insertAdmission(row) {
    return mongoose.connection.collection('viventium_scheduler_dispatch_intents').insertOne({
      _id: schedulerDispatchDocumentId(row.userId, row.idempotencyKey), ...row,
    });
  }

  test.each([
    ['schedule_due', 'owner-scheduler-permit', true],
    ['schedule_due', 'another-owner', false],
    ['legacy', 'owner-scheduler-permit', false],
  ])('routes opaque occurrence by saved %s owner %s', async (kind, userId, applicationOwned) => {
    await insertAdmission({
      kind, userId, idempotencyKey: 'opaque-occurrence',
    });
    const outbox = await enqueueOwnershipCase();
    if (applicationOwned) {
      expect(outbox).toBeNull();
      expect(await ViventiumGlassHiveCallbackEffectOutbox.countDocuments({})).toBe(0);
    } else {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
      expect(await dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
        .toMatchObject({ status: 'sent' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test('retained application-owned callback is superseded without sending to legacy scheduler', async () => {
    const outbox = await enqueueOwnershipCase();
    await insertAdmission({
      kind: 'schedule_due', userId: 'owner-scheduler-permit', idempotencyKey: 'opaque-occurrence',
    });
    const fetchImpl = jest.fn();
    expect(await dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
      .toMatchObject({ status: 'superseded' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outbox.outboxId }).lean())
      .toMatchObject({ status: 'superseded', nextAttemptAt: null,
        lastError: 'scheduler_occurrence_owned_by_application' });
    expect(await GlassHiveTerminalCallbackResult.countDocuments({})).toBe(1);
  });

  test('keeps a durable callback when ownership lookup fails, then resolves the owner before sending', async () => {
    const admissions = mongoose.connection.collection('viventium_scheduler_dispatch_intents');
    const lookup = jest.spyOn(admissions, 'findOne').mockRejectedValueOnce(new Error('lookup_unavailable'));
    let outbox;
    try {
      outbox = await enqueueOwnershipCase();
    } finally {
      lookup.mockRestore();
    }
    expect(outbox.status).toBe('pending');
    await insertAdmission({ kind: 'schedule_due', userId: 'owner-scheduler-permit',
      idempotencyKey: 'opaque-occurrence' });
    const fetchImpl = jest.fn();
    expect(await dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
      .toMatchObject({ status: 'superseded' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([false, true])('does not send when ownership lookup is unavailable during dispatch (expired=%s)', async (expired) => {
    const outbox = await enqueueOwnershipCase();
    const lookup = jest.spyOn(mongoose.connection.collection('viventium_scheduler_dispatch_intents'),
      'findOne').mockImplementationOnce(async () => {
        // Model a lookup that outlasts the claim, without faking Mongo's timers.
        if (expired) await ViventiumGlassHiveCallbackEffectOutbox.updateOne({ outboxId: outbox.outboxId },
          { $set: { claimExpiresAt: new Date(0) } });
        throw new Error('lookup_unavailable');
      });
    const fetchImpl = jest.fn(async () => ({ ok: true }));
    try {
      await expect(dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
        .rejects.toThrow('lookup_unavailable');
    } finally { lookup.mockRestore(); }
    expect(fetchImpl).not.toHaveBeenCalled();
    const deferred = await ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outbox.outboxId }).lean();
    expect(deferred).toMatchObject({ status: 'failed', claimId: '', claimExpiresAt: null,
      lastError: 'scheduler_ownership_lookup_unavailable' });
    expect(deferred.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // The normal retry remains available after the delay, with no abandoned claim.
    await ViventiumGlassHiveCallbackEffectOutbox.updateOne({ outboxId: outbox.outboxId },
      { $set: { nextAttemptAt: new Date(0) } });
    expect(await dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
      .toMatchObject({ status: 'sent' });
  });

  test('lookup failure cannot settle a claim acquired by another dispatcher', async () => {
    const outbox = await enqueueOwnershipCase();
    const lookup = jest.spyOn(mongoose.connection.collection('viventium_scheduler_dispatch_intents'),
      'findOne').mockImplementationOnce(async () => {
        await ViventiumGlassHiveCallbackEffectOutbox.updateOne({ outboxId: outbox.outboxId },
          { $set: { claimId: 'new-dispatcher-claim', claimExpiresAt: new Date(Date.now() + 30000) } });
        throw new Error('lookup_unavailable');
      });
    const fetchImpl = jest.fn();
    try {
      await expect(dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outbox.outboxId, fetchImpl }))
        .rejects.toThrow('lookup_unavailable');
    } finally { lookup.mockRestore(); }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outbox.outboxId }).lean())
      .toMatchObject({ status: 'claimed', claimId: 'new-dispatcher-claim' });
  });

  test('a failed callback does not prevent a later callback in the same batch', async () => {
    const bad = await enqueueOwnershipCase('bad-occurrence');
    await enqueueOwnershipCase('good-occurrence');
    const fetchImpl = jest.fn(async (_url, options) => {
      const badOccurrence = JSON.parse(options.body).occurrence_key === 'bad-occurrence';
      return { ok: !badOccurrence, status: badOccurrence ? 404 : 200 };
    });
    expect(await reconcileGlassHiveSchedulerCallbackOutbox({ limit: 2, fetchImpl }))
      .toMatchObject({ failed: 1, sent: 1 });
    expect(await ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: bad.outboxId }).lean())
      .toMatchObject({ status: 'failed', lastError: 'scheduler_external_work_callback_http_404' });
  });

  test('an older retry does not jump ahead of callbacks eligible for longer', async () => {
    const bad = await enqueueOwnershipCase('old-retry');
    const good = await enqueueOwnershipCase('waiting-callback');
    await ViventiumGlassHiveCallbackEffectOutbox.updateOne({ outboxId: bad.outboxId },
      { $set: { status: 'failed', createdAt: new Date(0), nextAttemptAt: new Date(Date.now() - 1000) } });
    await ViventiumGlassHiveCallbackEffectOutbox.updateOne({ outboxId: good.outboxId },
      { $set: { nextAttemptAt: new Date(Date.now() - 2000) } });
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    expect(await dispatchGlassHiveSchedulerCallbackOutbox({ fetchImpl }))
      .toMatchObject({ status: 'sent', outboxId: good.outboxId });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).occurrence_key).toBe('waiting-callback');
  });

  test('blocks B while receiver accepts A, then accepts B after A settles', async () => {
    const resultA = identity(1, 'a');
    const resultB = identity(2, 'b');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
    const referenceA = {
      resultKey: String(durableA._id),
      acceptedOperationId: acceptedA.acceptedOperationId,
      callbackId: resultA.callbackId,
      resultDigest: resultA.resultDigest,
      resultRevision: 1,
      generation: 1,
    };
    let outboxA;
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      outboxA = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: {
          ownerId: resultA.ownerId,
          scheduleOccurrenceKey: 'occurrence-scheduler-permit',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence: referenceA,
        effectSession: session,
      });
      const current = await fenceGlassHiveTerminalCallbackAcceptedOperationTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        reference: referenceA,
        session,
      });
      expect(current).toBe(true);
    });

    const receiverBodies = [];
    let bBlockedAtReceiver = false;
    const fetchImpl = jest.fn().mockImplementation(async (_url, init) => {
      receiverBodies.push(JSON.parse(init.body));
      try {
        await compareAndSetGlassHiveTerminalCallbackResult({
          ResultModel: GlassHiveTerminalCallbackResult,
          incoming: resultB,
        });
      } catch (error) {
        bBlockedAtReceiver = error?.message === 'glasshive_terminal_callback_effects_in_progress';
      }
      return { ok: true, status: 200 };
    });

    await expect(
      dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outboxA.outboxId, fetchImpl }),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(bBlockedAtReceiver).toBe(true);
    expect(receiverBodies).toEqual([
      expect.objectContaining({
        callback_id: resultA.callbackId,
        result_revision: 1,
        result_digest: resultA.resultDigest,
      }),
    ]);
    await expect(
      ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outboxA.outboxId }).lean(),
    ).resolves.toMatchObject({ status: 'sent' });
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      }),
    ).resolves.toMatchObject({ status: 'accepted', current: { resultState: 'cancelled' } });
  }, 15000);

  test('network failure releases the permit and restart retries the same durable payload', async () => {
    const resultA = identity(1, 'a');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
    const referenceA = {
      resultKey: String(durableA._id),
      acceptedOperationId: acceptedA.acceptedOperationId,
      callbackId: resultA.callbackId,
      resultDigest: resultA.resultDigest,
      resultRevision: 1,
      generation: 1,
    };
    let outboxA;
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      outboxA = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: {
          ownerId: resultA.ownerId,
          scheduleOccurrenceKey: 'occurrence-scheduler-restart',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence: referenceA,
        effectSession: session,
      });
      const current = await fenceGlassHiveTerminalCallbackAcceptedOperationTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        reference: referenceA,
        session,
      });
      expect(current).toBe(true);
    });

    const bodies = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        throw new Error('synthetic_scheduler_network_failure');
      })
      .mockImplementationOnce(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      });

    await expect(
      dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outboxA.outboxId, fetchImpl }),
    ).rejects.toThrow('synthetic_scheduler_network_failure');
    await expect(
      ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outboxA.outboxId }).lean(),
    ).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      dispatchPermitId: '',
      dispatchPermitGeneration: 0,
      dispatchPermitExpiresAt: null,
    });
    await expect(
      GlassHiveTerminalCallbackResult.findOne({ _id: durableA._id }).lean(),
    ).resolves.not.toHaveProperty('effectLeaseId');

    await ViventiumGlassHiveCallbackEffectOutbox.updateOne(
      { outboxId: outboxA.outboxId },
      { $set: { nextAttemptAt: new Date(0) } },
    );
    await expect(
      dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outboxA.outboxId, fetchImpl }),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(
      ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outboxA.outboxId }).lean(),
    ).resolves.toMatchObject({ status: 'sent', attempts: 2 });
  }, 15000);

  test('actual Core payload lets B win at external-work-callback before paused A has any effect', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-scheduler-cas-'));
    const dbPath = path.join(directory, 'schedules.db');
    runSchedulerDriver({ action: 'seed', db_path: dbPath });
    const resultA = identity(1, 'a');
    const resultB = identity(2, 'b');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
    const referenceA = {
      resultKey: String(durableA._id),
      acceptedOperationId: acceptedA.acceptedOperationId,
      callbackId: resultA.callbackId,
      resultDigest: resultA.resultDigest,
      resultRevision: 1,
      generation: 1,
    };
    let outboxA;
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      outboxA = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: {
          ownerId: resultA.ownerId,
          scheduleOccurrenceKey: 'occurrence-scheduler-permit',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed-a',
        },
        effectFence: referenceA,
        effectSession: session,
      });
    });

    let enterA;
    let resumeA;
    const aEnteredTransport = new Promise((resolve) => {
      enterA = resolve;
    });
    const aMayReachReceiver = new Promise((resolve) => {
      resumeA = resolve;
    });
    const deliveredBodies = [];
    const fetchImpl = jest.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      deliveredBodies.push(body);
      if (body.result_revision === 1) {
        enterA();
        await aMayReachReceiver;
      }
      const received = runSchedulerDriver({
        action: 'post',
        db_path: dbPath,
        body: init.body,
        headers: init.headers,
      });
      return {
        ok: received.status >= 200 && received.status < 300,
        status: received.status,
        json: async () => received.body,
      };
    });

    try {
      const dispatchA = dispatchGlassHiveSchedulerCallbackOutbox({
        outboxId: outboxA.outboxId,
        fetchImpl,
      });
      await aEnteredTransport;
      await GlassHiveTerminalCallbackResult.updateOne(
        { _id: durableA._id },
        { $set: { effectLeaseExpiresAt: new Date(0) } },
      );
      const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      });
      const durableB = await GlassHiveTerminalCallbackResult.findOne({}).lean();
      const referenceB = {
        resultKey: String(durableB._id),
        acceptedOperationId: acceptedB.acceptedOperationId,
        callbackId: resultB.callbackId,
        resultDigest: resultB.resultDigest,
        resultRevision: 2,
        generation: 2,
      };
      let outboxB;
      await runGlassHiveTerminalCallbackTransaction(async (session) => {
        outboxB = await enqueueGlassHiveSchedulerCallbackOutbox({
          binding: {
            ownerId: resultB.ownerId,
            scheduleOccurrenceKey: 'occurrence-scheduler-permit',
          },
          summary: {
            requiredTotal: 1,
            requiredTerminal: 1,
            requiredFailed: 1,
            allRequiredTerminal: true,
            state: 'failed-b',
          },
          effectFence: referenceB,
          effectSession: session,
        });
      });

      await expect(
        dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outboxB.outboxId, fetchImpl }),
      ).resolves.toMatchObject({ status: 'sent' });
      resumeA();
      await expect(dispatchA).rejects.toThrow('scheduler_external_work_callback_http_409');

      expect(deliveredBodies).toEqual([
        expect.objectContaining({
          callback_contract: 'glasshive_terminal_result_v1',
          source: 'glasshive',
          event: 'run.completed',
          result_revision: 1,
        }),
        expect.objectContaining({
          callback_contract: 'glasshive_terminal_result_v1',
          source: 'glasshive',
          event: 'run.completed',
          result_revision: 2,
          state: 'failed-b',
        }),
      ]);
      const schedulerState = runSchedulerDriver({ action: 'read', db_path: dbPath });
      expect(schedulerState.terminal).toMatchObject({
        callback_id: resultB.callbackId,
        result_revision: 2,
        result_digest: resultB.resultDigest,
        effect_state: 'committed',
      });
      expect(schedulerState.run).toMatchObject({
        status: 'failed',
        disposition: 'failed',
        execution_snapshot: {
          external_work: expect.objectContaining({ state: 'failed-b' }),
        },
      });
    } finally {
      resumeA?.();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
