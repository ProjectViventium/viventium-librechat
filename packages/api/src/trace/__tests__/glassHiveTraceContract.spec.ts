/* === VIVENTIUM START === Strict GlassHive-to-Core orchestration trace contract tests. === VIVENTIUM END === */

import { tmpdir } from 'os';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import completedDetailFixture from '../__fixtures__/glassHiveCompletedWorkDetail.v1.json';
import {
  appendOrchestrationTraceEvent,
  buildCallbackTraceEvents,
  buildDeliveryTraceEvent,
  buildUnifiedOrchestrationTrace,
  GLASSHIVE_WORK_TRACE_EMITTED_KEY_SET_DIGEST,
  GLASSHIVE_WORK_TRACE_PRODUCER_SOURCE_IDENTITY,
  GLASSHIVE_WORK_TRACE_SCHEMA_DIGEST,
  ingestGlassHiveWorkDetailTrace,
  projectGlassHiveProducerFactFingerprints,
  readOrchestrationTraceLedger,
  validateGlassHiveWorkDetailTrace,
} from '../index';

import type {
  OrchestrationTraceEventRow,
  OrchestrationTraceLedgerStore,
} from '../orchestrationTraceLedger';

const ownerId = 'owner-synthetic-1';
const originRef = 'ghi_0123456789abcdef0123456789abcdef';
const workRef = 'work_synthetic_1';
const runRef = 'run_synthetic_1';

interface FileFingerprint {
  mtimeMs: number;
  sha256: string;
}

interface MutableDetailFixture extends Record<string, unknown> {
  runRef?: string;
  attemptHistory?: Array<Record<string, unknown>>;
  attemptHistoryOverflowCount?: number;
  capacityAttempts?: Array<Record<string, unknown>>;
  capacityAttemptOverflowCount?: number;
  callbackDeliveries?: Array<Record<string, unknown>>;
  callbackDeliveryOverflowCount?: number;
  artifactHistory?: Array<{
    artifactRefs: Record<string, unknown>;
    observedAt: string;
  }>;
  artifactHistoryOverflowCount?: number;
  historyPage?: {
    cursor: string | null;
    nextCursor: string | null;
    limit: number;
    total: number;
    showing: number;
    overflowCount: number;
  };
  traceability: {
    contractVersion?: number;
    origin: Record<string, unknown>;
    promptLayers: Record<string, unknown>;
    providerAttempts?: Array<Record<string, unknown>>;
    runtimeInvocations?: Array<Record<string, unknown>>;
    providerAuthorizationPreflights?: Array<Record<string, unknown>>;
    integrity: Record<string, unknown>;
  };
  artifactRefs: { refs: Array<Record<string, unknown>> };
}

class MemoryLedgerStore implements OrchestrationTraceLedgerStore {
  rows: OrchestrationTraceEventRow[] = [];

  async findByEventKey(query: {
    ownerScopeHash: string;
    originRefHash: string;
    eventKeyHash: string;
  }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.eventKeyHash === query.eventKeyHash,
      ) || null
    );
  }

  async findLatest(query: { ownerScopeHash: string; originRefHash: string }) {
    return (
      this.rows
        .filter(
          (row) =>
            row.ownerScopeHash === query.ownerScopeHash &&
            row.originRefHash === query.originRefHash,
        )
        .sort((left, right) => right.sequence - left.sequence)[0] || null
    );
  }

  async findBySequence(query: { ownerScopeHash: string; originRefHash: string; sequence: number }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence === query.sequence,
      ) || null
    );
  }

  async insert(row: OrchestrationTraceEventRow) {
    if (
      this.rows.some(
        (item) =>
          item.ownerScopeHash === row.ownerScopeHash &&
          item.originRefHash === row.originRefHash &&
          (item.sequence === row.sequence || item.eventKeyHash === row.eventKeyHash),
      )
    ) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    this.rows.push({ ...row, facts: { ...row.facts } });
    return row;
  }

  async listPage(query: {
    ownerScopeHash: string;
    originRefHash: string;
    afterSequence: number;
    limit: number;
  }) {
    return this.rows
      .filter(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence > query.afterSequence,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, query.limit);
  }
}

function fixture(): MutableDetailFixture {
  return refreshHistoryPage(
    JSON.parse(JSON.stringify(completedDetailFixture)) as MutableDetailFixture,
  );
}

function refreshHistoryPage(value: MutableDetailFixture): MutableDetailFixture {
  const showing = [
    value.attemptHistory,
    value.capacityAttempts,
    value.callbackDeliveries,
    value.artifactHistory,
  ].reduce((total, rows) => total + (rows?.length || 0), 0);
  const overflowCount = [
    value.attemptHistoryOverflowCount,
    value.capacityAttemptOverflowCount,
    value.callbackDeliveryOverflowCount,
    value.artifactHistoryOverflowCount,
  ].reduce((total, count) => total + (count || 0), 0);
  value.historyPage = {
    cursor: null,
    nextCursor:
      overflowCount > 0 ? `history_${'a'.repeat(64)}_1_${'0'.repeat(64)}_0_1_0_0_10` : null,
    limit: 16,
    total: showing + overflowCount,
    showing,
    overflowCount,
  };
  return value;
}

function v2Fixture(): MutableDetailFixture {
  const value = fixture();
  const providerAttempt = value.traceability.providerAttempts?.[0];
  delete value.traceability.providerAttempts;
  value.traceability.contractVersion = 2;
  value.traceability.runtimeInvocations = providerAttempt
    ? [
        {
          attemptNumber: providerAttempt.attemptNumber,
          model: providerAttempt.model,
          profile: providerAttempt.profile,
          runtimeInvocationRef: `runtime_invocation_sha256:${'e'.repeat(64)}`,
          runtime: providerAttempt.runtime,
          runtimeInvokedAt: providerAttempt.runtimeInvokedAt,
        },
      ]
    : [];
  value.traceability.providerAuthorizationPreflights = [
    {
      attemptNumber: 1,
      failureClass: null,
      observedAt: '2026-08-22T01:00:02.500Z',
      provider: 'openai',
      providerAuthorizationPreflightRef: `provider_authorization_preflight_sha256:${'d'.repeat(64)}`,
      status: 'authorized',
    },
  ];
  return value;
}

function latestCallback(
  detail: MutableDetailFixture,
  event = 'run.completed',
): Record<string, unknown> | undefined {
  const rows = detail.callbackDeliveries || [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].event === event) return rows[index];
  }
  return undefined;
}

function fixtureWithSupersededCallback(): MutableDetailFixture {
  const detail = fixture();
  const terminalIndex = detail.callbackDeliveries?.findIndex(
    (item) => item.event === 'run.completed' && item.status === 'pending',
  );
  if (!detail.callbackDeliveries || terminalIndex == null || terminalIndex < 0) {
    throw new Error('Canonical fixture is missing run.completed callback history');
  }
  for (const callback of detail.callbackDeliveries.slice(terminalIndex)) {
    callback.ledgerSequence = Number(callback.ledgerSequence) + 2;
  }
  detail.callbackDeliveries[terminalIndex].previousEventSha256 = `sha256:${'f'.repeat(64)}`;
  detail.callbackDeliveries.splice(
    terminalIndex,
    0,
    {
      callbackRef: `callback_sha256:${'d'.repeat(64)}`,
      callbackRevision: 1,
      ledgerSequence: 2,
      previousEventSha256: `sha256:${'1'.repeat(64)}`,
      eventSha256: `sha256:${'e'.repeat(64)}`,
      attemptNumber: 1,
      event: 'run.completed',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-08-22T01:00:06.500Z',
      updatedAt: '2026-08-22T01:00:06.500Z',
      acceptedAt: null,
      payloadSha256: `sha256:${'a'.repeat(64)}`,
      resultRevision: 0,
      resultDigest: null,
      deliveryGeneration: 0,
      authoritySha256: `sha256:${'b'.repeat(64)}`,
    },
    {
      callbackRef: `callback_sha256:${'d'.repeat(64)}`,
      callbackRevision: 2,
      ledgerSequence: 3,
      previousEventSha256: `sha256:${'e'.repeat(64)}`,
      eventSha256: `sha256:${'f'.repeat(64)}`,
      attemptNumber: 1,
      event: 'run.completed',
      status: 'superseded',
      attempts: 0,
      createdAt: '2026-08-22T01:00:06.500Z',
      updatedAt: '2026-08-22T01:00:06.750Z',
      acceptedAt: null,
      payloadSha256: `sha256:${'a'.repeat(64)}`,
      resultRevision: 0,
      resultDigest: null,
      deliveryGeneration: 0,
      authoritySha256: `sha256:${'c'.repeat(64)}`,
    },
  );
  return refreshHistoryPage(detail);
}

function fileFingerprint(path: string): FileFingerprint | null {
  if (!existsSync(path)) return null;
  return {
    mtimeMs: statSync(path).mtimeMs,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function isolatedGlassHiveChildEnv(tempDir: string): NodeJS.ProcessEnv {
  const home = resolve(tempDir, 'home');
  const runtimeRoot = resolve(tempDir, 'runtime');
  const configRoot = resolve(tempDir, 'config');
  const stateRoot = resolve(tempDir, 'state');
  const cacheRoot = resolve(tempDir, 'cache');
  const tempRoot = resolve(tempDir, 'tmp');
  for (const path of [home, runtimeRoot, configRoot, stateRoot, cacheRoot, tempRoot]) {
    mkdirSync(path, { recursive: true });
  }
  const inheritedEnvironment = Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TZ']
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return {
    ...inheritedEnvironment,
    HOME: home,
    TMPDIR: tempRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
    XDG_CACHE_HOME: cacheRoot,
    CODEX_HOME: resolve(configRoot, 'codex'),
    CLAUDE_CONFIG_DIR: resolve(configRoot, 'claude'),
    VIVENTIUM_RUNTIME_ROOT: runtimeRoot,
    VIVENTIUM_ENV_FILE: resolve(configRoot, 'runtime.env.disabled'),
    VIVENTIUM_DISABLE_DEFAULT_RUNTIME_ENV: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    WPR_DB_PATH: resolve(stateRoot, 'workers-projects.sqlite3'),
    WPR_RUNTIME_BACKEND: 'stub',
    WPR_HOST_WORKSPACE_ROOT: resolve(runtimeRoot, 'workspaces'),
    GLASSHIVE_LINK_REF_STATE_PATH: resolve(stateRoot, 'link-refs.sqlite3'),
  };
}

function spawnIsolatedGlassHiveProducer(input: {
  glassHiveRoot: string;
  tempDir: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const installedDb = resolve(input.glassHiveRoot, 'runtime_phase1/data/runtime_phase1.db');
  const before = fileFingerprint(installedDb);
  const producer = spawnSync('uv', input.args, {
    cwd: input.glassHiveRoot,
    encoding: 'utf8',
    env: { ...isolatedGlassHiveChildEnv(input.tempDir), ...input.env },
  });
  expect(fileFingerprint(installedDb)).toEqual(before);
  return producer;
}

function readGlassHiveProducerDetail(): {
  workRef: string;
  runRef: string;
  detail: unknown;
  contract: {
    contractVersion: number;
    schemaDigest: string;
    producerSourceIdentity: string;
    emittedKeySetDigest: string;
  };
} {
  const glassHiveRoot = resolve(__dirname, '../../../../../../GlassHive');
  const tempDir = mkdtempSync(resolve(tmpdir(), 'viventium-trace-contract-'));
  const outputPath = resolve(tempDir, 'producer-detail.json');
  try {
    const producer = spawnIsolatedGlassHiveProducer({
      glassHiveRoot,
      tempDir,
      args: [
        'run',
        '--no-sync',
        '--project',
        'runtime_phase1',
        'python',
        '-m',
        'pytest',
        'runtime_phase1/tests/test_account_api.py::test_completed_work_detail_matches_strict_core_producer_contract',
        '-q',
      ],
      env: { GLASSHIVE_CORE_TRACE_CONTRACT_OUTPUT: outputPath },
    });
    expect({ status: producer.status, stderr: producer.stderr }).toEqual({ status: 0, stderr: '' });
    return JSON.parse(readFileSync(outputPath, 'utf8')) as {
      workRef: string;
      runRef: string;
      detail: unknown;
      contract: {
        contractVersion: number;
        schemaDigest: string;
        producerSourceIdentity: string;
        emittedKeySetDigest: string;
      };
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readGlassHiveSupersededProducerDetail(): {
  workRef: string;
  runRef: string;
  detail: unknown;
} {
  const glassHiveRoot = resolve(__dirname, '../../../../../../GlassHive');
  const harnessPath = resolve(__dirname, 'harnesses/glass_hive_superseded_producer.py');
  const tempDir = mkdtempSync(resolve(tmpdir(), 'viventium-superseded-contract-'));
  const outputPath = resolve(tempDir, 'producer-detail.json');
  try {
    const producer = spawnIsolatedGlassHiveProducer({
      glassHiveRoot,
      tempDir,
      args: ['run', '--no-sync', '--project', 'runtime_phase1', 'python', harnessPath, outputPath],
    });
    expect({ status: producer.status, stderr: producer.stderr }).toEqual({ status: 0, stderr: '' });
    return JSON.parse(readFileSync(outputPath, 'utf8')) as {
      workRef: string;
      runRef: string;
      detail: unknown;
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readGlassHivePreRuntimeProducerDetail(): {
  workRef: string;
  runRef: string;
  detail: unknown;
} {
  const glassHiveRoot = resolve(__dirname, '../../../../../../GlassHive');
  const tempDir = mkdtempSync(resolve(tmpdir(), 'viventium-pre-runtime-contract-'));
  const outputPath = resolve(tempDir, 'producer-detail.json');
  try {
    const producer = spawnIsolatedGlassHiveProducer({
      glassHiveRoot,
      tempDir,
      args: [
        'run',
        '--no-sync',
        '--project',
        'runtime_phase1',
        'python',
        '-m',
        'pytest',
        'runtime_phase1/tests/test_account_api.py::test_active_work_stop_is_exact_idempotent_and_owner_scoped',
        '-q',
      ],
      env: { GLASSHIVE_CORE_TRACE_PRE_RUNTIME_OUTPUT: outputPath },
    });
    expect({ status: producer.status, stderr: producer.stderr }).toEqual({ status: 0, stderr: '' });
    return JSON.parse(readFileSync(outputPath, 'utf8')) as {
      workRef: string;
      runRef: string;
      detail: unknown;
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function producerFieldPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const visit = (current: unknown, prefix: string) => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item, `${prefix}[]`);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      visit((current as Record<string, unknown>)[key], path);
    }
  };
  visit(value, '');
  return [...paths].sort();
}

function producerFieldPathsDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(producerFieldPaths(value)), 'utf8')
    .digest('hex')}`;
}

test('accepts the exact sanitized detail emitted by the real GlassHive producer path', () => {
  const handoff = readGlassHiveProducerDetail();

  expect(
    validateGlassHiveWorkDetailTrace({
      workRef: handoff.workRef,
      runRef: handoff.runRef,
      detail: handoff.detail,
    }),
  ).toEqual([]);
}, 120_000);

test('canonical fixture has the exact recursive field shape emitted by GlassHive', () => {
  const handoff = readGlassHiveProducerDetail();

  expect(producerFieldPaths(v2Fixture())).toEqual(producerFieldPaths(handoff.detail));
}, 120_000);

test('golden producer fixture pins schema, source identity, and emitted key-set drift', () => {
  const handoff = readGlassHiveProducerDetail();

  expect(handoff.contract).toEqual({
    contractVersion: 1,
    schemaDigest: GLASSHIVE_WORK_TRACE_SCHEMA_DIGEST,
    producerSourceIdentity: GLASSHIVE_WORK_TRACE_PRODUCER_SOURCE_IDENTITY,
    emittedKeySetDigest: GLASSHIVE_WORK_TRACE_EMITTED_KEY_SET_DIGEST,
  });
  expect(handoff.contract.emittedKeySetDigest).toBe(producerFieldPathsDigest(handoff.detail));
  expect(handoff.contract.emittedKeySetDigest).toBe(producerFieldPathsDigest(v2Fixture()));
}, 120_000);

test('accepts V2 runtime and authorization facts without calling a runtime start a provider request', () => {
  const detail = v2Fixture();

  expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
  expect(detail.traceability).not.toHaveProperty('providerAttempts');
});

test('V2 rejects a runtime invocation without its exact authorized provider preflight', () => {
  const detail = v2Fixture();
  detail.traceability.providerAuthorizationPreflights = [];

  expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
    'provider_authorization_preflights_invalid',
  );
});

test('V2 permits a failed primary preflight and authorized fallback within one runtime attempt', () => {
  const detail = v2Fixture();
  const authorized = detail.traceability.providerAuthorizationPreflights?.[0];
  if (!authorized) throw new Error('V2 fixture is missing its authorization preflight');
  authorized.provider = 'anthropic';
  detail.traceability.providerAuthorizationPreflights?.unshift({
    attemptNumber: 1,
    failureClass: 'provider_auth_projection_unavailable',
    observedAt: '2026-08-22T01:00:02.250Z',
    provider: 'openai',
    providerAuthorizationPreflightRef: `provider_authorization_preflight_sha256:${'c'.repeat(64)}`,
    status: 'retryable_failure',
  });

  expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
});

test('rejects an untyped or invalid worker resource reservation', () => {
  for (const mutate of [
    (value: MutableDetailFixture) => {
      value.resourceClass = 'tiny';
    },
    (value: MutableDetailFixture) => {
      value.resourceReservation = { memoryBytes: 0 };
    },
  ]) {
    const detail = fixture();
    mutate(detail);
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'resource_contract_invalid',
    );
  }
});

test('accepts real GlassHive pending then superseded then HTTP-accepted history', () => {
  const handoff = readGlassHiveSupersededProducerDetail();

  expect(producerFieldPaths(handoff.detail)).toEqual(producerFieldPaths(v2Fixture()));
  expect(
    (handoff.detail as MutableDetailFixture).callbackDeliveries?.map((item) => item.status),
  ).toEqual(['pending', 'pending', 'superseded', 'pending', 'delivering', 'http_accepted']);
  expect(
    validateGlassHiveWorkDetailTrace({
      workRef: handoff.workRef,
      runRef: handoff.runRef,
      detail: handoff.detail,
    }),
  ).toEqual([]);
}, 120_000);

test('accepts exact pre-runtime Stop detail emitted by the real GlassHive producer path', () => {
  const handoff = readGlassHivePreRuntimeProducerDetail();

  expect(
    validateGlassHiveWorkDetailTrace({
      workRef: handoff.workRef,
      runRef: handoff.runRef,
      detail: handoff.detail,
    }),
  ).toEqual([]);
}, 120_000);

function inFlightFixture(): MutableDetailFixture {
  const value = fixture();
  const callback = latestCallback(value);
  if (callback) {
    callback.status = 'delivering';
    callback.updatedAt = '2026-08-22T01:00:07.500Z';
    callback.acceptedAt = null;
  }
  return value;
}

function inFlightV2Fixture(): MutableDetailFixture {
  const value = v2Fixture();
  const callback = latestCallback(value);
  if (callback) {
    callback.status = 'delivering';
    callback.updatedAt = '2026-08-22T01:00:07.500Z';
    callback.acceptedAt = null;
  }
  return value;
}

function overflowedPreAttemptCallbackFixture(
  event: 'worker.message_queued' | 'run.queue_status' | 'run.waiting_on_capacity',
): MutableDetailFixture {
  const value = fixture();
  const callbackRows = value.callbackDeliveries?.slice(0, -1);
  if (!callbackRows?.[0]) throw new Error('Canonical fixture is missing callback history');
  const overflowCount = 12;
  callbackRows[0].event = event;
  callbackRows[0].previousEventSha256 = `sha256:${'0'.repeat(64)}`;
  for (let index = 0; index < callbackRows.length; index += 1) {
    callbackRows[index].ledgerSequence = overflowCount + index + 1;
  }
  value.callbackDeliveries = callbackRows;
  value.callbackDeliveryOverflowCount = overflowCount;
  return refreshHistoryPage(value);
}

function terminalFixture(
  state: 'completed' | 'failed' | 'cancelled',
  callbackEvent: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted',
): MutableDetailFixture {
  const value = fixture();
  value.state = state;
  const attempt = value.attemptHistory?.[value.attemptHistory.length - 1];
  if (attempt) {
    attempt.state = state;
    attempt.terminalReason = state;
  }
  for (const callback of value.callbackDeliveries || []) {
    if (callback.event === 'run.completed') callback.event = callbackEvent;
  }
  return value;
}

function resumedNeedsInputFixture(): MutableDetailFixture {
  const value = fixture();
  const currentAttempt = value.attemptHistory?.[0];
  const currentProviderAttempt = value.traceability.providerAttempts?.[0];
  if (!currentAttempt || !currentProviderAttempt) {
    throw new Error('Canonical fixture is missing attempt history');
  }
  value.attemptHistory = [
    {
      ...currentAttempt,
      attemptNumber: 1,
      state: 'needs_input',
      claimedAt: '2026-08-22T00:59:55.000Z',
      admittedAt: '2026-08-22T00:59:56.000Z',
      runtimeInvokedAt: '2026-08-22T00:59:57.000Z',
      endedAt: '2026-08-22T00:59:58.000Z',
      terminalReason: 'provider_progress_stalled',
    },
    { ...currentAttempt, attemptNumber: 2 },
  ];
  value.traceability.providerAttempts = [
    {
      ...currentProviderAttempt,
      attemptNumber: 1,
      providerAttemptRef: `provider_attempt_sha256:${'d'.repeat(64)}`,
      runtimeInvokedAt: '2026-08-22T00:59:57.000Z',
    },
    { ...currentProviderAttempt, attemptNumber: 2 },
  ];
  (value.lifecycle as Record<string, unknown>).attemptNumber = 2;
  for (const callback of value.callbackDeliveries || []) {
    if (callback.event === 'run.completed') callback.attemptNumber = 2;
  }
  return refreshHistoryPage(value);
}

function preRuntimeTerminalFixture(
  state: 'failed' | 'cancelled',
  callbackEvent: 'run.failed' | 'run.cancelled' | 'run.interrupted',
): MutableDetailFixture {
  const value = fixture();
  value.state = state;
  value.lifecycle = {
    attemptNumber: null,
    queuedAt: '2026-08-22T01:00:01.000Z',
    claimedAt: null,
    admittedAt: null,
    runtimeInvokedAt: null,
    startedAt: null,
    endedAt: '2026-08-22T01:00:06.000Z',
  };
  value.attemptHistory = [];
  value.traceability.providerAttempts = [];
  for (const callback of value.callbackDeliveries || []) {
    if (callback.event === 'run.completed') {
      callback.event = callbackEvent;
      callback.attemptNumber = null;
    }
  }
  return refreshHistoryPage(value);
}

async function seedLaunch(store: MemoryLedgerStore) {
  await appendOrchestrationTraceEvent({
    store,
    ownerId,
    originRef,
    eventKey: 'source',
    stage: 'source.bound',
    at: '2026-08-22T01:00:00.000Z',
    facts: { sourceEventRef: 'source-synthetic-1' },
  });
  await appendOrchestrationTraceEvent({
    store,
    ownerId,
    originRef,
    eventKey: 'launch',
    stage: 'launch.accepted',
    at: '2026-08-22T01:00:00.500Z',
    facts: { workRef },
  });
}

async function appendCoreCallbackAndDelivery(
  store: MemoryLedgerStore,
  callbackRef = String(latestCallback(fixture())?.callbackRef || ''),
) {
  const callbackEvents = buildCallbackTraceEvents({
    workRef,
    runRef,
    callbackRef,
    event: 'run.completed',
    workState: 'completed',
    workTerminal: true,
    callbackAt: '2026-08-22T01:00:07.000Z',
    callbackAcceptedAt: '2026-08-22T01:00:08.000Z',
    attemptNumber: 1,
  });
  for (const event of callbackEvents) {
    await appendOrchestrationTraceEvent({ store, ownerId, originRef, ...event });
  }
  await appendOrchestrationTraceEvent({
    store,
    ownerId,
    originRef,
    ...buildDeliveryTraceEvent({
      deliveryRef: 'core-surface-receipt-1',
      workRef,
      runRef,
      callbackRef,
      callbackEvent: 'run.completed',
      state: 'completed',
      terminal: true,
      surface: 'telegram',
      status: 'sent',
      at: '2026-08-22T01:00:09.000Z',
      attemptNumber: 1,
    }),
  });
}

async function appendProviderForwarding(store: MemoryLedgerStore) {
  await appendOrchestrationTraceEvent({
    store,
    ownerId,
    originRef,
    eventKey: 'provider-request-forwarded',
    stage: 'provider.request.forwarded',
    at: '2026-08-22T01:00:05.500Z',
    facts: {
      workRef,
      runRef,
      providerRequestRef: 'provider-request-synthetic-1',
      provider: 'openai',
      providerStatus: 'completed',
    },
  });
}

describe('GlassHive work detail trace ingestion', () => {
  test('HTTP-accepted producer history is transport evidence and cannot claim surface delivery', async () => {
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    const result = await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: fixture(),
    });
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: fixture(),
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(result).toMatchObject({ accepted: true, errors: [] });
    expect(ledgerPage.events.map((event) => event.stage)).toEqual([
      'source.bound',
      'launch.accepted',
      'prompt.layers.verified',
      'work.queued',
      'work.claimed',
      'work.admitted',
      'runtime.invoked',
      'work.running',
      'attempt.history.complete',
      'capacity.history.complete',
      'work.completed',
      'callback.history.complete',
    ]);
    expect(ledgerPage.events.some((event) => event.stage === 'callback.delivery.sent')).toBe(false);
    expect(trace.completionClaims).toEqual({ allowed: false });
    expect(trace.integrity.missingStages).toEqual(
      expect.arrayContaining(['terminal_callback_acceptance', 'terminal_callback_delivery']),
    );
    expect(trace.current.artifactRefs).toEqual(completedDetailFixture.artifactRefs);
  });

  test('a separate exact Core callback and surface receipt permits completion', async () => {
    const store = new MemoryLedgerStore();
    const detail = v2Fixture();
    await seedLaunch(store);
    await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail,
    });
    await appendProviderForwarding(store);
    await appendCoreCallbackAndDelivery(store);
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: detail,
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(trace.completionClaims).toEqual({ allowed: true });
    expect(trace.integrity.completionClaimable).toBe(true);
  });

  test('binds an exact pre-runtime Stop callback and delivery without fake runtime stages', async () => {
    const detail = preRuntimeTerminalFixture('cancelled', 'run.cancelled');
    const callbackRef = String(latestCallback(detail, 'run.cancelled')?.callbackRef || '');
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail,
    });
    for (const event of buildCallbackTraceEvents({
      workRef,
      runRef,
      callbackRef,
      event: 'run.cancelled',
      workState: 'cancelled',
      workTerminal: true,
      callbackAt: '2026-08-22T01:00:07.000Z',
      callbackAcceptedAt: '2026-08-22T01:00:08.000Z',
      attemptNumber: null,
    })) {
      await appendOrchestrationTraceEvent({ store, ownerId, originRef, ...event });
    }
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      ...buildDeliveryTraceEvent({
        deliveryRef: 'core-pre-runtime-stop-receipt',
        workRef,
        runRef,
        callbackRef,
        callbackEvent: 'run.cancelled',
        state: 'cancelled',
        terminal: true,
        surface: 'telegram',
        status: 'sent',
        at: '2026-08-22T01:00:09.000Z',
        attemptNumber: null,
      }),
    });
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: {
        ownerId,
        originRef,
        workRef,
        runId: runRef,
        externalState: 'cancelled',
      },
      glassHiveDetail: detail,
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(trace.completionClaims).toEqual({ allowed: false });
    expect(trace.integrity.terminalTruth).toEqual({
      isTerminal: true,
      successful: false,
      state: 'cancelled',
      evidenceExact: true,
    });
    expect(trace.integrity.lifecycleChronology).toEqual({ status: 'verified' });
    expect(trace.integrity.missingStages).toContain('successful_terminal_work');
    expect(trace.integrity.missingStages).not.toEqual(
      expect.arrayContaining([
        'work_claimed',
        'work_admitted',
        'runtime_invocation',
        'runtime_started',
        'callback_history',
        'terminal_callback_acceptance',
        'terminal_callback_delivery',
        'monotonic_lifecycle',
      ]),
    );
  });

  test('accepts mutable delivery-state replay for the same immutable callback authority', async () => {
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    const ingestion = await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: inFlightV2Fixture(),
    });
    await appendProviderForwarding(store);
    await appendCoreCallbackAndDelivery(store);
    const eventCount = store.rows.length;
    const finalReplay = await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: v2Fixture(),
    });
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: v2Fixture(),
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(ingestion).toMatchObject({ accepted: true, errors: [] });
    expect(finalReplay).toMatchObject({ accepted: true, errors: [] });
    expect(store.rows).toHaveLength(eventCount);
    expect(trace.integrity.conflicts).not.toContain('producer_fact_fingerprint_mismatch');
    expect(trace.completionClaims).toEqual({ allowed: true });
  });

  test.each([
    ['status', (callback: Record<string, unknown>) => (callback.status = 'accepted')],
    ['attempts', (callback: Record<string, unknown>) => (callback.attempts = 2)],
    [
      'updatedAt',
      (callback: Record<string, unknown>) => (callback.updatedAt = '2026-08-22T01:00:09.500Z'),
    ],
    [
      'acceptedAt',
      (callback: Record<string, unknown>) => (callback.acceptedAt = '2026-08-22T01:00:07.500Z'),
    ],
  ])(
    'does not bind mutable callback %s into the immutable producer fingerprint',
    (_field, mutate) => {
      const before = fixture();
      const after = fixture();
      const callback = latestCallback(after);
      expect(callback).toBeDefined();
      mutate(callback as Record<string, unknown>);

      const beforeFingerprint = projectGlassHiveProducerFactFingerprints({
        workRef,
        runRef,
        detail: before,
      });
      const afterFingerprint = projectGlassHiveProducerFactFingerprints({
        workRef,
        runRef,
        detail: after,
      });

      expect(beforeFingerprint).not.toBeNull();
      expect(afterFingerprint).not.toBeNull();
      expect(afterFingerprint?.producerCallbackHistoryHash).toBe(
        beforeFingerprint?.producerCallbackHistoryHash,
      );
    },
  );

  test('accepts the same terminal callback after transport acknowledgment advances its authority revision', async () => {
    const delivering = fixture();
    delivering.callbackDeliveries = delivering.callbackDeliveries?.slice(0, -1);
    refreshHistoryPage(delivering);
    const acknowledged = fixture();
    const store = new MemoryLedgerStore();
    await seedLaunch(store);

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: delivering })).toEqual([]);
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: acknowledged })).toEqual([]);
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: delivering,
      }),
    ).resolves.toMatchObject({ accepted: true, errors: [] });
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: acknowledged,
      }),
    ).resolves.toMatchObject({ accepted: true, errors: [] });
  });

  test('does not bind mutable callback authority into the immutable producer fingerprint', () => {
    const before = fixture();
    const after = fixture();
    const callback = latestCallback(after);
    expect(callback).toBeDefined();
    (callback as Record<string, unknown>).authoritySha256 = `sha256:${'0'.repeat(64)}`;

    const beforeFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: before,
    });
    const afterFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: after,
    });

    expect(beforeFingerprint).not.toBeNull();
    expect(afterFingerprint).not.toBeNull();
    expect(afterFingerprint?.producerCallbackHistoryHash).toBe(
      beforeFingerprint?.producerCallbackHistoryHash,
    );
  });

  test('binds terminal callback result identity and rejects a conflicting replay', async () => {
    const before = fixture();
    const after = fixture();
    const callbackRef = latestCallback(after)?.callbackRef;
    for (const callback of after.callbackDeliveries || []) {
      if (callback.callbackRef === callbackRef) {
        callback.resultRevision = 1;
        callback.resultDigest = `sha256:${'0'.repeat(64)}`;
      }
    }

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: after })).toEqual([]);
    const beforeFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: before,
    });
    const afterFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: after,
    });
    expect(afterFingerprint?.producerCallbackHistoryHash).not.toBe(
      beforeFingerprint?.producerCallbackHistoryHash,
    );

    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: before,
      }),
    ).resolves.toMatchObject({ accepted: true, errors: [] });
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: after,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      errors: expect.arrayContaining(['producer_facts_conflict']),
    });
  });

  test('binds immutable callback payload authority into the producer fingerprint', () => {
    const before = fixture();
    const after = fixture();
    const callbackRef = latestCallback(after)?.callbackRef;
    for (const callback of after.callbackDeliveries || []) {
      if (callback.callbackRef === callbackRef) {
        callback.payloadSha256 = `sha256:${'0'.repeat(64)}`;
      }
    }

    const beforeFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: before,
    });
    const afterFingerprint = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: after,
    });

    expect(beforeFingerprint).not.toBeNull();
    expect(afterFingerprint).not.toBeNull();
    expect(afterFingerprint?.producerCallbackHistoryHash).not.toBe(
      beforeFingerprint?.producerCallbackHistoryHash,
    );
  });

  test.each([
    ['failed', 'run.failed', 'work.failed'],
    ['cancelled', 'run.cancelled', 'work.cancelled'],
    ['cancelled', 'run.interrupted', 'work.cancelled'],
  ] as const)(
    'ingests terminal %s producer detail from %s',
    async (state, callbackEvent, expectedStage) => {
      const detail = terminalFixture(state, callbackEvent);
      const store = new MemoryLedgerStore();
      await seedLaunch(store);

      expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
      await expect(
        ingestGlassHiveWorkDetailTrace({
          store,
          ownerId,
          originRef,
          workRef,
          runRef,
          detail,
        }),
      ).resolves.toMatchObject({ accepted: true, errors: [] });
      expect(store.rows.map((event) => event.stage)).toContain(expectedStage);
      expect(
        store.rows.find((event) => event.stage === 'callback.history.complete')?.facts,
      ).toEqual(expect.objectContaining({ callbackEvent }));
    },
  );

  test('accepts a completed resumed run whose earlier attempt needed input', async () => {
    const detail = resumedNeedsInputFixture();
    const store = new MemoryLedgerStore();
    await seedLaunch(store);

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail,
      }),
    ).resolves.toMatchObject({ accepted: true, errors: [] });
  });

  test.each([
    ['failed', 'run.failed', 'work.failed'],
    ['cancelled', 'run.cancelled', 'work.cancelled'],
    ['cancelled', 'run.interrupted', 'work.cancelled'],
  ] as const)(
    'ingests pre-runtime terminal %s detail from %s without inventing an attempt',
    async (state, callbackEvent, expectedStage) => {
      const detail = preRuntimeTerminalFixture(state, callbackEvent);
      const store = new MemoryLedgerStore();
      await seedLaunch(store);

      expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
      await expect(
        ingestGlassHiveWorkDetailTrace({
          store,
          ownerId,
          originRef,
          workRef,
          runRef,
          detail,
        }),
      ).resolves.toMatchObject({ accepted: true, errors: [] });
      expect(store.rows.map((event) => event.stage)).toContain(expectedStage);
      expect(store.rows.map((event) => event.stage)).not.toEqual(
        expect.arrayContaining([
          'work.claimed',
          'work.admitted',
          'runtime.invoked',
          'work.running',
        ]),
      );
      expect(store.rows.find((event) => event.stage === expectedStage)?.facts).not.toHaveProperty(
        'attemptNumber',
      );
    },
  );

  test('accepts a verified callback-ledger suffix after transport retries overflow the public bound', async () => {
    const full = fixture();
    const suffix = fixture();
    suffix.callbackDeliveries = suffix.callbackDeliveries?.slice(2);
    suffix.callbackDeliveryOverflowCount = 2;
    refreshHistoryPage(suffix);
    const store = new MemoryLedgerStore();
    await seedLaunch(store);

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: suffix })).toEqual([]);
    expect(
      projectGlassHiveProducerFactFingerprints({ workRef, runRef, detail: suffix })
        ?.producerCallbackHistoryHash,
    ).toBe(
      projectGlassHiveProducerFactFingerprints({ workRef, runRef, detail: full })
        ?.producerCallbackHistoryHash,
    );
    await expect(
      ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: suffix,
      }),
    ).resolves.toMatchObject({ accepted: true, errors: [] });
  });

  test('a different callback on the same work, run, and attempt cannot satisfy completion', async () => {
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: fixture(),
    });
    await appendCoreCallbackAndDelivery(store, `callback_sha256:${'9'.repeat(64)}`);
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: fixture(),
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(trace.completionClaims).toEqual({ allowed: false });
    expect(trace.integrity.conflicts).toContain('terminal_callback_identity_mismatch');
  });

  test('late producer backfill cannot override causal ledger sequence', async () => {
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    await appendCoreCallbackAndDelivery(store);
    await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: fixture(),
    });
    const ledgerPage = await readOrchestrationTraceLedger({
      store,
      ownerId,
      originRef,
      limit: 100,
    });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: fixture(),
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(trace.ledger?.chain.fullChainVerified).toBe(true);
    expect(trace.integrity.lifecycleChronology).toEqual({
      status: 'invalid',
      reason: 'terminal_causal_order_invalid',
    });
    expect(trace.completionClaims).toEqual({ allowed: false });
  });

  test('binds canonical fingerprints for every strict producer fact group', () => {
    const fingerprints = projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: fixture(),
    });

    expect(fingerprints).toEqual({
      producerLifecycleHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      producerAttemptHistoryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      producerCapacityHistoryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      producerCallbackHistoryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      producerPromptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      producerArtifactRefsHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  test.each([
    [
      'lifecycle time',
      (value) => {
        const lifecycle = value.lifecycle as Record<string, unknown>;
        lifecycle.queuedAt = '2026-08-22T01:00:01.010Z';
      },
    ],
    [
      'attempt history',
      (value) => {
        if (value.attemptHistory?.[0]) value.attemptHistory[0].terminalReason = 'completed-v2';
      },
    ],
    [
      'capacity history',
      (value) => {
        const available = value.capacityAttempts?.[0]?.available as Record<string, unknown>;
        available.childProcesses = 4;
      },
    ],
    [
      'callback history',
      (value) => {
        const callbackRef = latestCallback(value)?.callbackRef;
        for (const callback of value.callbackDeliveries || []) {
          if (callback.callbackRef === callbackRef) {
            callback.payloadSha256 = `sha256:${'0'.repeat(64)}`;
          }
        }
      },
    ],
    [
      'artifact digest facts',
      (value) => {
        if (value.artifactRefs.refs[0]) value.artifactRefs.refs[0].sizeBytes = 129;
        const latest = value.artifactHistory?.[value.artifactHistory.length - 1];
        const latestRefs = latest?.artifactRefs.refs as Array<Record<string, unknown>> | undefined;
        if (latestRefs?.[0]) latestRefs[0].sizeBytes = 129;
      },
    ],
    [
      'artifact observation history',
      (value) => {
        const latest = value.artifactHistory?.[value.artifactHistory.length - 1];
        if (latest) latest.observedAt = '2026-08-22T01:00:08.600Z';
      },
    ],
    [
      'origin source revision',
      (value) => {
        value.traceability.origin.sourceRevision = 2;
      },
    ],
    [
      'provider attempt route',
      (value) => {
        const providerAttempt = value.traceability.providerAttempts?.[0];
        if (providerAttempt) providerAttempt.profile = 'codex-cli-v2';
      },
    ],
  ] as Array<[string, (value: MutableDetailFixture) => void]>)(
    'valid %s mutation after ledger conflicts and cannot reuse old evidence',
    async (_label, mutate) => {
      const store = new MemoryLedgerStore();
      await seedLaunch(store);
      const original = fixture();
      await ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: original,
      });
      await appendCoreCallbackAndDelivery(store);
      const changed = fixture();
      mutate(changed);

      await expect(
        ingestGlassHiveWorkDetailTrace({
          store,
          ownerId,
          originRef,
          workRef,
          runRef,
          detail: changed,
        }),
      ).resolves.toMatchObject({ accepted: false, errors: ['producer_facts_conflict'] });
      const ledgerPage = await readOrchestrationTraceLedger({
        store,
        ownerId,
        originRef,
        limit: 100,
      });
      const trace = buildUnifiedOrchestrationTrace({
        ownerId,
        originRef,
        binding: { ownerId, originRef, workRef },
        externalWork: { ownerId, originRef, workRef, runId: runRef },
        glassHiveDetail: changed,
        ledgerPage,
      });

      expect(trace.completionClaims.allowed).toBe(false);
      expect(trace.integrity.conflicts).toContain('producer_fact_fingerprint_mismatch');
    },
  );

  test.each([
    ['missing attempt history', (value) => delete value.attemptHistory, 'attempt_history_missing'],
    [
      'attempt overflow',
      (value) => {
        value.attemptHistoryOverflowCount = 1;
      },
      'attempt_history_overflow',
    ],
    [
      'missing capacity history',
      (value) => delete value.capacityAttempts,
      'capacity_history_missing',
    ],
    [
      'capacity overflow',
      (value) => {
        value.capacityAttemptOverflowCount = 1;
      },
      'capacity_history_overflow',
    ],
    [
      'missing callback history',
      (value) => delete value.callbackDeliveries,
      'callback_history_missing',
    ],
    [
      'callback overflow boundary mismatch',
      (value) => {
        value.callbackDeliveryOverflowCount = 1;
      },
      'callback_history_invalid',
    ],
    [
      'wrong terminal callback',
      (value) => {
        const callback = latestCallback(value);
        if (callback) callback.event = 'run.failed';
      },
      'terminal_callback_invalid',
    ],
    [
      'mixed attempts',
      (value) => {
        if (value.attemptHistory?.[0]) value.attemptHistory[0].attemptNumber = 2;
      },
      'attempt_identity_mismatch',
    ],
    [
      'untyped prior attempt',
      (value) => {
        value.attemptHistory?.unshift({
          attemptNumber: 0,
          state: 'retry_queued',
          claimedAt: '2026-08-22T00:59:58.000Z',
          admittedAt: null,
          runtimeInvokedAt: null,
          endedAt: '2026-08-22T00:59:59.000Z',
          terminalReason: 'host_capacity',
          path: '/private/attempt.json',
        });
      },
      'attempt_history_invalid',
    ],
    [
      'stale lifecycle attempt',
      (value) => {
        const row = value.attemptHistory?.[0];
        if (row) {
          value.attemptHistory?.push({
            ...row,
            attemptNumber: 2,
            claimedAt: '2026-08-22T01:00:07.000Z',
            admittedAt: '2026-08-22T01:00:08.000Z',
            runtimeInvokedAt: '2026-08-22T01:00:09.000Z',
            endedAt: '2026-08-22T01:00:10.000Z',
          });
        }
      },
      'attempt_identity_mismatch',
    ],
    [
      'reversed capacity history',
      (value) => {
        const row = value.capacityAttempts?.[0];
        if (row) {
          value.capacityAttempts?.push({
            ...row,
            sequence: 0,
            observedAt: '2026-08-22T01:00:01.500Z',
          });
        }
      },
      'capacity_history_invalid',
    ],
    [
      'reversed callback delivery update',
      (value) => {
        const callback = latestCallback(value);
        if (callback) callback.updatedAt = '2026-08-22T01:00:06.500Z';
      },
      'callback_history_invalid',
    ],
    ['missing producer run identity', (value) => delete value.runRef, 'run_identity_invalid'],
    [
      'wrong producer run identity',
      (value) => {
        value.runRef = `run_sha256:${'f'.repeat(64)}`;
      },
      'run_identity_invalid',
    ],
    [
      'missing producer scope',
      (value) => delete value.traceability.promptLayers.producerScope,
      'prompt_producer_scope_invalid',
    ],
    [
      'wrong producer scope',
      (value) => {
        value.traceability.promptLayers.producerScope = 'local.snapshot';
      },
      'prompt_producer_scope_invalid',
    ],
    [
      'missing prompt layer names',
      (value) => delete value.traceability.promptLayers.layerNames,
      'prompt_producer_scope_invalid',
    ],
    [
      'unknown prompt field',
      (value) => {
        value.traceability.promptLayers.privatePath = '/private/prompt.md';
      },
      'prompt_producer_scope_invalid',
    ],
    [
      'unknown traceability field',
      (value) => {
        (value.traceability as Record<string, unknown>).privateContext = 'secret';
      },
      'traceability_contract_invalid',
    ],
    [
      'unsafe provider attempt field',
      (value) => {
        if (value.traceability.providerAttempts?.[0]) {
          value.traceability.providerAttempts[0].configPath = '/private/provider.json';
        }
      },
      'provider_attempts_invalid',
    ],
    [
      'inconsistent provider health observation',
      (value) => {
        if (value.attemptHistory?.[0]) {
          value.attemptHistory[0].providerHealthObservedGeneration = 2;
        }
      },
      'attempt_history_invalid',
    ],
    [
      'unsafe artifact field',
      (value) => {
        if (value.artifactRefs.refs[0]) value.artifactRefs.refs[0].path = '/private/output.html';
      },
      'artifact_contract_invalid',
    ],
    [
      'mismatched artifact digest',
      (value) => {
        if (value.artifactRefs.refs[0]) {
          value.artifactRefs.refs[0].fingerprint = `sha256:${'c'.repeat(64)}`;
        }
      },
      'artifact_contract_invalid',
    ],
  ] as Array<[string, (value: MutableDetailFixture) => void, string]>)(
    '%s blocks ingestion',
    async (_name, mutate, code) => {
      const store = new MemoryLedgerStore();
      const detail = fixture();
      mutate(detail);

      const result = await ingestGlassHiveWorkDetailTrace({
        store,
        ownerId,
        originRef,
        workRef,
        runRef,
        detail,
      });

      expect(result).toMatchObject({ accepted: false, errors: expect.arrayContaining([code]) });
      expect(store.rows).toHaveLength(0);
    },
  );

  test('concurrent exact replay is idempotent', async () => {
    const store = new MemoryLedgerStore();
    await seedLaunch(store);
    const input = { store, ownerId, originRef, workRef, runRef, detail: fixture() };

    const results = await Promise.all([
      ingestGlassHiveWorkDetailTrace(input),
      ingestGlassHiveWorkDetailTrace(input),
    ]);

    expect(results.every((result) => result.accepted)).toBe(true);
    expect(store.rows.map((row) => row.eventKeyHash)).toHaveLength(
      new Set(store.rows.map((row) => row.eventKeyHash)).size,
    );
    expect(store.rows).toHaveLength(12);
  });

  test('accepts both safe provider-health observation variants', () => {
    const healthyObservation = fixture();
    const healthyAttempt = healthyObservation.attemptHistory?.[0];
    if (healthyAttempt) healthyAttempt.providerHealthObservedGeneration = 0;
    const failedObservation = fixture();
    const failedAttempt = failedObservation.attemptHistory?.[0];
    if (failedAttempt) {
      failedAttempt.providerHealthObservedLastFailedAt = '2026-08-22T00:59:00.000Z';
      failedAttempt.providerHealthObservedGeneration = 2;
    }

    expect(
      validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: healthyObservation }),
    ).toEqual([]);
    expect(
      validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: failedObservation }),
    ).toEqual([]);
  });

  test('accepts the producer run.queued null attempt', () => {
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: fixture() })).not.toContain(
      'callback_history_invalid',
    );
  });

  test.each(['worker.message_queued', 'run.queue_status', 'run.waiting_on_capacity'] as const)(
    'accepts an overflowed producer callback suffix starting at pre-attempt %s',
    async (event) => {
      const detail = overflowedPreAttemptCallbackFixture(event);
      const store = new MemoryLedgerStore();
      await seedLaunch(store);

      expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
      await expect(
        ingestGlassHiveWorkDetailTrace({ store, ownerId, originRef, workRef, runRef, detail }),
      ).resolves.toMatchObject({ accepted: true, errors: [] });
    },
  );

  test.each(['run.started', 'run.completed'] as const)(
    'rejects null attempt for attempt-scoped %s',
    (event) => {
      const detail = fixture();
      const callback =
        event === 'run.completed' ? latestCallback(detail) : detail.callbackDeliveries?.[0];
      if (callback) {
        callback.event = event;
        callback.attemptNumber = null;
      }

      const errors = validateGlassHiveWorkDetailTrace({ workRef, runRef, detail });

      expect(errors).toContain('callback_history_invalid');
      expect(errors).toContain('terminal_callback_invalid');
    },
  );

  test('accepts pending then superseded then HTTP-accepted completed callback history', () => {
    const detail = fixtureWithSupersededCallback();

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
  });

  test.each([
    [
      'an acceptance receipt',
      (detail: MutableDetailFixture) => {
        const superseded = detail.callbackDeliveries?.find((item) => item.status === 'superseded');
        if (superseded) superseded.acceptedAt = '2026-08-22T01:00:06.750Z';
      },
    ],
    [
      'a nonterminal event',
      (detail: MutableDetailFixture) => {
        const superseded = detail.callbackDeliveries?.find((item) => item.status === 'superseded');
        if (superseded) superseded.event = 'run.queued';
      },
    ],
    [
      'an update after the current terminal callback',
      (detail: MutableDetailFixture) => {
        const superseded = detail.callbackDeliveries?.find((item) => item.status === 'superseded');
        if (superseded) superseded.updatedAt = '2026-08-22T01:00:07.500Z';
      },
    ],
  ])('rejects a superseded callback with %s', (_name, mutate) => {
    const detail = fixtureWithSupersededCallback();
    mutate(detail);

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'callback_history_invalid',
    );
  });

  test('requires the complete bounded immutable artifact observation history', () => {
    const missing = fixture();
    delete missing.artifactHistory;
    const overflow = fixture();
    overflow.artifactHistoryOverflowCount = 1;
    const stale = fixture();
    if (stale.artifactHistory?.[0]) {
      stale.artifactHistory[0].artifactRefs = {
        available: false,
        refs: [],
        overflowCount: 0,
      };
    }
    const privateField = fixture();
    if (privateField.artifactHistory?.[0]) {
      (privateField.artifactHistory[0] as Record<string, unknown>).path = '/private/result.html';
    }

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: missing })).toContain(
      'artifact_history_missing',
    );
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: overflow })).toContain(
      'artifact_history_overflow',
    );
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: stale })).toContain(
      'artifact_history_invalid',
    );
    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail: privateField })).toContain(
      'artifact_history_invalid',
    );
  });

  test('accepts a pre-terminal empty artifact observation followed by the final artifact', () => {
    const detail = fixture();
    const finalObservation = detail.artifactHistory?.[0];
    expect(finalObservation).toBeDefined();
    detail.artifactHistory = [
      {
        artifactRefs: { available: false, refs: [], overflowCount: 0 },
        observedAt: '2026-08-22T01:00:05.500Z',
      },
      finalObservation!,
    ];
    refreshHistoryPage(detail);

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toEqual([]);
  });

  test('rejects artifact history whose final observation predates terminal completion', () => {
    const detail = fixture();
    if (detail.artifactHistory?.[0]) {
      detail.artifactHistory[0].observedAt = '2026-08-22T01:00:05.500Z';
    }

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'artifact_history_invalid',
    );
  });

  test('rejects unknown top-level producer fields', () => {
    const detail = fixture();
    detail.argv = ['worker', '--token', 'private'];

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'detail_contract_invalid',
    );
  });

  test('rejects a reduced completed producer root shape', () => {
    const detail = fixture();
    delete detail.title;

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'detail_contract_invalid',
    );
  });

  test('rejects producer origin evidence from a different owner-scoped claim', async () => {
    const detail = fixture();
    detail.traceability.origin.originRef = `origin_sha256:${'9'.repeat(64)}`;

    await expect(
      ingestGlassHiveWorkDetailTrace({
        store: new MemoryLedgerStore(),
        ownerId,
        originRef,
        workRef,
        runRef,
        detail,
      }),
    ).resolves.toMatchObject({ accepted: false, errors: ['origin_identity_mismatch'] });
  });

  test('requires provider attempts to bind the same immutable attempt identity', () => {
    const detail = fixture();
    const providerAttempt = detail.traceability.providerAttempts?.[0];
    if (providerAttempt) providerAttempt.attemptNumber = 2;

    expect(validateGlassHiveWorkDetailTrace({ workRef, runRef, detail })).toContain(
      'provider_attempts_invalid',
    );
  });

  test('accepts a complete bounded callback history and selects the exact terminal row', async () => {
    const store = new MemoryLedgerStore();
    const detail = fixture();
    if (!detail.callbackDeliveries) {
      throw new Error('Canonical fixture is missing callback history');
    }
    for (const callback of detail.callbackDeliveries) {
      callback.ledgerSequence = Number(callback.ledgerSequence) + 1;
    }
    detail.callbackDeliveries[0].previousEventSha256 = `sha256:${'d'.repeat(64)}`;
    detail.callbackDeliveries.unshift({
      callbackRef: `callback_sha256:${'d'.repeat(64)}`,
      callbackRevision: 1,
      ledgerSequence: 1,
      previousEventSha256: null,
      eventSha256: `sha256:${'d'.repeat(64)}`,
      attemptNumber: 1,
      event: 'run.queued',
      status: 'http_accepted',
      attempts: 1,
      createdAt: '2026-08-22T01:00:01.000Z',
      updatedAt: '2026-08-22T01:00:01.050Z',
      acceptedAt: '2026-08-22T01:00:01.050Z',
      payloadSha256: `sha256:${'e'.repeat(64)}`,
      resultRevision: 0,
      resultDigest: null,
      deliveryGeneration: 1,
      authoritySha256: `sha256:${'f'.repeat(64)}`,
    });
    refreshHistoryPage(detail);

    const result = await ingestGlassHiveWorkDetailTrace({
      store,
      ownerId,
      originRef,
      workRef,
      runRef,
      detail,
    });

    expect(result).toMatchObject({ accepted: true, errors: [], eventCount: 10 });
    expect(store.rows.filter((row) => row.stage === 'callback.accepted')).toHaveLength(0);
  });
});
