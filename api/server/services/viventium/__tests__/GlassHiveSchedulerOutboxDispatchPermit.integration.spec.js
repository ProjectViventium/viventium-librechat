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
const schedulerPython = path.join(schedulerRoot, '.venv/bin/python');
const schedulerDriver = String.raw`
import json
import os
import sys
import types

prompt_contract = types.ModuleType("scheduler_prompt_contract")
prompt_contract.CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID = "test.continuity"
prompt_contract.SCHEDULER_RUN_ENVELOPE_PROMPT_ID = "test.scheduler_envelope"
prompt_contract.SCHEDULER_RUN_ENVELOPE_TEMPLATE = """<!--test:begin-->
## Test Background Processing
For live external facts, use verified test context only.

## Scheduled Run Context (Deterministic)
{{scheduled_run_context}}"""
prompt_contract.render_scheduler_run_envelope = lambda context: (
    prompt_contract.SCHEDULER_RUN_ENVELOPE_TEMPLATE.replace(
        "{{scheduled_run_context}}", str(context).strip()
    )
)
sys.modules.setdefault("scheduler_prompt_contract", prompt_contract)

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
        "definition_id": None,
        "user_id": "owner-scheduler-permit",
        "version_id": None,
        "due_at": now,
        "started_at": now,
        "completed_at": None,
        "status": "running",
        "executor": "glasshive_host",
        "rendered_hash": None,
        "variable_snapshot_hash": None,
        "glasshive_project_id": None,
        "glasshive_worker_id": None,
        "glasshive_run_id": None,
        "result_summary": "Running.",
        "error_class": None,
        "private_detail_path": None,
        "callback_payload_json": None,
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
    try:
        response_body = received.json()
    except ValueError:
        response_body = {"raw": received.text}
    response = {"status": received.status_code, "body": response_body}
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
  const localEnvironmentReady = fs.existsSync(schedulerPython);
  const command = localEnvironmentReady ? schedulerPython : 'uv';
  const args = localEnvironmentReady
    ? ['-c', schedulerDriver]
    : ['run', '--frozen', '--project', '.', 'python', '-c', schedulerDriver];
  const result = spawnSync(command, args, {
    cwd: schedulerRoot,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, PYTHONPATH: '.' },
  });
  if (result.status !== 0) {
    const diagnostic = [
      result.error ? `${result.error.name}: ${result.error.message}` : '',
      result.stderr || '',
      result.stdout || '',
    ]
      .filter(Boolean)
      .join('\n')
      .replaceAll(schedulerRoot, '<scheduling-cortex>')
      .replaceAll(path.resolve(schedulerRoot, '..', '..', '..'), '<repository>')
      .replaceAll(os.homedir(), '<home>');
    throw new Error(
      `scheduler_driver_failed status=${result.status ?? 'spawn_error'}: ${diagnostic || 'no diagnostic output'}`,
    );
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
