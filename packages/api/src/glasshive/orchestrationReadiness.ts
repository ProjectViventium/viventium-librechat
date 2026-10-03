/* === VIVENTIUM START ===
 * Feature: Fail-closed isolated Parallel readiness watcher.
 * Purpose: Keep host-mission mutual exclusion a GlassHive deployment invariant without adding a
 * GlassHive round trip to Main's per-turn authoring path. Consumers read only this bounded local
 * snapshot; startup/periodic refresh owns the service-authenticated probe.
 * === VIVENTIUM END === */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Document } from 'mongodb';
import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { activeWorkColdTimeoutMs } from './activeWorkService';
import {
  CONVERSATION_ORCHESTRATION_TOOLS,
  isDeclaredConversationOrchestrator,
} from './conversationOrchestration';

type ValueRecord = Document;

interface ReadinessFact {
  status: string;
  reason?: string;
  contractVersion?: number;
  schemaDigest?: string;
  producerSourceIdentity?: string;
  emittedKeySetDigest?: string;
  durability?: string;
  replicaSafe?: boolean;
  usedPercent?: number;
  availableBytes?: number;
  thresholdPercent?: number;
  unknownLayerCount?: number;
}

interface InternalReadiness {
  status: string;
  reason: string;
  diagnosticCode?: string;
  checkedAtMs: number;
  ownerId: string;
  storagePressure: ReadinessFact;
  promptLayers: ReadinessFact;
  sourceOrder: ReadinessFact;
  workTraceContract: ReadinessFact;
}

interface ReadinessAgent extends ValueRecord {
  id?: string;
  _id?: object | string;
  tools?: Array<string | { name?: string }>;
  toolDefinitions?: Array<{ name?: string; function?: { name?: string } }>;
}

export interface OrchestrationReadinessSnapshot {
  requested: boolean;
  available: boolean;
  status: string;
  reason: string;
  checkedAtMs: number;
  storagePressure: ReadinessFact;
  promptLayers: ReadinessFact;
  sourceOrder: ReadinessFact;
  workTraceContract: ReadinessFact;
}

export interface OrchestrationReadinessDependencies {
  logger: {
    warn(message: string, details?: ValueRecord): void;
    info?(message: string): void;
  };
  getSourceOrderCapabilities(): ValueRecord;
  findUser(filter: ValueRecord, projection: string): Promise<ValueRecord | null>;
  getAgent(filter: ValueRecord): Promise<ReadinessAgent | null>;
  checkPermission(input: ValueRecord): Promise<boolean>;
  requestAccountApi(input: ValueRecord): Promise<ValueRecord>;
  promptLayerIntegritySnapshot(): ValueRecord;
}

let orchestrationReadinessDependencies: OrchestrationReadinessDependencies | null = null;

export function configureOrchestrationReadiness(
  dependencies: OrchestrationReadinessDependencies,
): void {
  orchestrationReadinessDependencies = dependencies;
}

function runtimeDependencies(): OrchestrationReadinessDependencies {
  if (!orchestrationReadinessDependencies) {
    throw new Error('orchestration_readiness_dependencies_unavailable');
  }
  return orchestrationReadinessDependencies;
}

const logger = {
  warn: (message: string, details?: ValueRecord) =>
    runtimeDependencies().logger.warn(message, details),
  info: (message: string) => runtimeDependencies().logger.info?.(message),
};
const GenerationJobManager = {
  getSourceOrderCapabilities: () => runtimeDependencies().getSourceOrderCapabilities(),
};
const findUser = (...args: Parameters<OrchestrationReadinessDependencies['findUser']>) =>
  runtimeDependencies().findUser(...args);
const getAgent = (...args: Parameters<OrchestrationReadinessDependencies['getAgent']>) =>
  runtimeDependencies().getAgent(...args);
const checkPermission = (
  ...args: Parameters<OrchestrationReadinessDependencies['checkPermission']>
) => runtimeDependencies().checkPermission(...args);
const requestAccountApi = (
  ...args: Parameters<OrchestrationReadinessDependencies['requestAccountApi']>
) => runtimeDependencies().requestAccountApi(...args);
const promptLayerIntegritySnapshot = () => runtimeDependencies().promptLayerIntegritySnapshot();

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_OWNER_IDLE_TTL_MS = 10 * 60_000;
const MAX_TRACKED_OWNERS = 128;
const GLASSHIVE_PROMPT_LAYER_PRODUCER_SCOPE = 'glasshive.worker_prompt_registry';
const GLASSHIVE_WORK_TRACE_SCHEMA_DIGEST =
  'sha256:ba9b15e022a451c62be0c0f30a02d6615bea83e868b2ffdd349beff75002e790';
const GLASSHIVE_WORK_TRACE_PRODUCER_SOURCE_IDENTITY =
  'workers_projects_runtime.api:get_active_work';
const GLASSHIVE_WORK_TRACE_EMITTED_KEY_SET_DIGEST =
  'sha256:3a109b0f41a08755252a050e444dd6780e7bf95aec194ad95628e4e7a5c3a253';
const readinessByOwner = new Map<string, InternalReadiness>();
const inFlightByOwner = new Map<string, Promise<OrchestrationReadinessSnapshot>>();
const observedAtByOwner = new Map<string, number>();
let startupOwnerId = '';
let startupOwnerResolution: Promise<string> | null = null;
let deploymentReadiness: InternalReadiness | null = null;
let deploymentInFlight: Promise<OrchestrationReadinessSnapshot> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let capabilityRequestOrdinal = 0;

async function requestReadinessCapability(ownerId: string, scope: 'owner' | 'deployment') {
  const startedAtMs = Date.now();
  const started = performance.now();
  const requestOrdinal = ++capabilityRequestOrdinal;
  let errorClass = '';
  try {
    return await requestAccountApi({
      ownerId,
      path: '/v1/orchestration-capabilities',
      timeoutMs: 1000,
    });
  } catch (cause) {
    errorClass = cause instanceof Error ? cause.name : 'Error';
    throw cause;
  } finally {
    logger.info(
      `[VIVENTIUM][parallel-work-timing] ${JSON.stringify({
        stage: 'readiness_capability_request',
        scope,
        requestOrdinal,
        startedAtMs,
        ownerHash: createHash('sha256').update(ownerId).digest('hex'),
        durationMs: performance.now() - started,
        errorClass,
      })}`,
    );
  }
}

export function parallelWorkRequested(): boolean {
  return process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true';
}

function positiveBoundedMs(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;
}

function readinessIntervalMs(): number {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_READINESS_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    1_000,
    5 * 60_000,
  );
}

function readinessMaxAgeMs(): number {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_READINESS_MAX_AGE_MS',
    DEFAULT_MAX_AGE_MS,
    2_000,
    10 * 60_000,
  );
}

function readinessMaxInFlight(): number {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_READINESS_MAX_IN_FLIGHT',
    DEFAULT_MAX_IN_FLIGHT,
    1,
    MAX_TRACKED_OWNERS,
  );
}

function ownerIdleTtlMs(): number {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_OWNER_IDLE_TTL_MS',
    DEFAULT_OWNER_IDLE_TTL_MS,
    1_000,
    24 * 60 * 60_000,
  );
}

function validReadyCapability(value: ValueRecord | null | undefined): boolean {
  if (process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE === 'host') {
    return (
      value?.policyVersion === 1 &&
      value?.nativeParallelReady === true &&
      value?.hostMissionsAllowed === true
    );
  }
  return (
    value?.policyVersion === 1 &&
    value?.isolatedParallelReady === true &&
    value?.hostMissionsAllowed === false &&
    Number(value?.hostMissionsActive) === 0
  );
}

/* === VIVENTIUM START ===
 * Feature: Typed prompt-integrity and storage-pressure readiness facts.
 * Purpose: Fail on measured unsafe/contradictory capability data without exposing machine paths.
 * Both local and remote prompt producers must provide the strict integrity contract.
 * === VIVENTIUM END === */
function unknownStoragePressure(reason = 'storage_capability_missing'): ReadinessFact {
  return Object.freeze({ status: 'unknown', reason });
}

function unknownPromptLayers(reason = 'prompt_layer_capability_missing'): ReadinessFact {
  return Object.freeze({ status: 'unknown', reason });
}

function unknownSourceOrder(reason = 'source_order_capability_missing'): ReadinessFact {
  return Object.freeze({ status: 'unknown', reason });
}

function unknownWorkTraceContract(reason = 'work_trace_contract_missing'): ReadinessFact {
  return Object.freeze({ status: 'unknown', reason });
}

function normalizedWorkTraceContract(capability: ValueRecord): ReadinessFact {
  const value = capability?.workTraceContract;
  if (value == null) return unknownWorkTraceContract();
  if (
    value.contractVersion !== 1 ||
    value.schemaDigest !== GLASSHIVE_WORK_TRACE_SCHEMA_DIGEST ||
    value.producerSourceIdentity !== GLASSHIVE_WORK_TRACE_PRODUCER_SOURCE_IDENTITY ||
    value.emittedKeySetDigest !== GLASSHIVE_WORK_TRACE_EMITTED_KEY_SET_DIGEST
  ) {
    return unknownWorkTraceContract('work_trace_contract_invalid');
  }
  return Object.freeze({
    status: 'verified',
    contractVersion: 1,
    schemaDigest: value.schemaDigest,
    producerSourceIdentity: value.producerSourceIdentity,
    emittedKeySetDigest: value.emittedKeySetDigest,
  });
}

function sourceOrderReadiness(): ReadinessFact {
  try {
    const capability = GenerationJobManager.getSourceOrderCapabilities();
    const durability = String(capability?.durability || '').trim();
    const replicaSafe = capability?.replica_safe;
    if (!['process', 'durable'].includes(durability) || typeof replicaSafe !== 'boolean') {
      return unknownSourceOrder('source_order_capability_invalid');
    }
    if (durability !== 'durable' || replicaSafe !== true) {
      return Object.freeze({
        status: 'unavailable',
        reason: 'source_order_not_durable',
        durability,
        replicaSafe,
      });
    }
    return Object.freeze({ status: 'verified', durability, replicaSafe });
  } catch (_error) {
    return unknownSourceOrder('source_order_capability_unavailable');
  }
}

function normalizedStoragePressure(capability: ValueRecord): ReadinessFact {
  const value = capability?.storagePressure;
  if (value == null) return unknownStoragePressure();
  const usedPercent = Number(value.usedPercent);
  const availableBytes = Number(value.availableBytes);
  const thresholdPercent = Number(value.thresholdPercent);
  const declaredStatus = String(value.status || value.state || '').trim();
  const statusConflict = Boolean(value.status && value.state && value.status !== value.state);
  const healthConflict =
    typeof value.healthy === 'boolean' && value.healthy !== (declaredStatus !== 'critical');
  if (
    value.version !== 1 ||
    !['healthy', 'warning', 'critical'].includes(declaredStatus) ||
    statusConflict ||
    healthConflict ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent <= 0 ||
    thresholdPercent > 100
  ) {
    return unknownStoragePressure('storage_capability_invalid');
  }
  let status = declaredStatus;
  if (usedPercent >= thresholdPercent) status = 'critical';
  return Object.freeze({ status, usedPercent, availableBytes, thresholdPercent });
}

function normalizedPromptLayers(capability: ValueRecord): ReadinessFact {
  const local = promptLayerIntegritySnapshot();
  const remote = capability?.promptLayers;
  const validLayerNames = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 160);
  if (local?.contractVersion !== 1 || !validLayerNames(local?.unknownLayerNames)) {
    return unknownPromptLayers('prompt_layer_capability_invalid');
  }
  if (remote == null) return unknownPromptLayers();
  const localStatus = String(local.status || '')
    .trim()
    .toLowerCase();
  const remoteStatus = String(remote.status || '')
    .trim()
    .toLowerCase();
  if (
    remote.contractVersion !== 1 ||
    remote.producerScope !== GLASSHIVE_PROMPT_LAYER_PRODUCER_SCOPE ||
    !validLayerNames(remote.unknownLayerNames) ||
    (localStatus && !['verified', 'unknown', 'mismatch'].includes(localStatus)) ||
    (remoteStatus && !['verified', 'unknown', 'mismatch'].includes(remoteStatus)) ||
    (Object.prototype.hasOwnProperty.call(remote, 'available') && remote.available !== true)
  ) {
    return unknownPromptLayers('prompt_layer_capability_invalid');
  }
  const unknownLayerCount = Math.min(
    new Set([...local.unknownLayerNames, ...remote.unknownLayerNames]).size,
    10_000,
  );
  const mismatch = localStatus === 'mismatch' || remoteStatus === 'mismatch';
  const status = mismatch ? 'mismatch' : unknownLayerCount > 0 ? 'unknown' : 'verified';
  return Object.freeze({
    status,
    unknownLayerCount,
    ...(status !== 'verified'
      ? {
          reason: mismatch
            ? safeReadinessReason(remote.reason || local.reason, 'prompt_layer_hash_mismatch')
            : 'prompt_layers_unknown',
        }
      : {}),
  });
}

function hasTypedDeploymentScope(capability: ValueRecord): boolean {
  const scope = capability?.readinessScope;
  return (
    scope?.contractVersion === 1 &&
    scope?.scope === 'deployment' &&
    scope?.ownerCredentialRole === 'transport_auth'
  );
}

function storagePressureAllowsReadiness(value: ReadinessFact): boolean {
  return value.status === 'healthy' || value.status === 'warning';
}

function promptLayersAllowReadiness(value: ReadinessFact): boolean {
  return value.status === 'verified';
}

function workTraceContractAllowsReadiness(value: ReadinessFact): boolean {
  return value.status === 'verified';
}

function safeReadinessReason(value: unknown, fallback = 'isolated_parallel_unready'): string {
  const reason = String(value || '').trim();
  return /^[a-z0-9_.-]{1,120}$/.test(reason) ? reason : fallback;
}

function safeDiagnosticCode(value: unknown, fallback = 'readiness_unavailable'): string {
  const code = String(value || '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9_.-]{1,120}$/.test(code) ? code : fallback;
}

function logReadinessStage(ownerId: string, stage: string, details: ValueRecord): void {
  // Serialize into the message: the host logger may discard a second metadata argument.
  logger.info(
    `[VIVENTIUM][parallel-work-timing] ${JSON.stringify({
      stage,
      ownerHash: ownerId ? createHash('sha256').update(ownerId).digest('hex') : null,
      ...details,
    })}`,
  );
}

function resolvedAgentToolNames(agent: ReadinessAgent | null): Set<string> {
  const names = new Set<string>();
  for (const tool of agent?.tools || []) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    if (name) names.add(String(name).trim());
  }
  for (const definition of agent?.toolDefinitions || []) {
    const name = definition?.name || definition?.function?.name;
    if (name) names.add(String(name).trim());
  }
  return names;
}

async function accessibleMainAgent(
  mainAgentId: string,
  ownerId: string,
): Promise<ReadinessAgent | null> {
  if (!mainAgentId || !ownerId) return null;
  const agent = await getAgent({ id: mainAgentId }).catch(() => null);
  if (!agent) return null;
  const resourceId = agent._id || agent.id;
  if (!resourceId) return null;
  const canView = await checkPermission({
    userId: ownerId,
    resourceType: ResourceType.AGENT,
    resourceId,
    requiredPermission: PermissionBits.VIEW,
  }).catch(() => false);
  return canView ? agent : null;
}

function mainAgentReadiness(agent: ReadinessAgent | null, mainAgentId: string): ValueRecord {
  const configured = Boolean(mainAgentId && agent);
  const declared = configured && isDeclaredConversationOrchestrator(agent);
  const resolved = resolvedAgentToolNames(agent);
  const missingTools = CONVERSATION_ORCHESTRATION_TOOLS.filter((name) => !resolved.has(name));
  return { configured, declared, missingTools };
}

function readinessRecord(ownerId: string): InternalReadiness {
  return (
    readinessByOwner.get(ownerId) || {
      status: 'unknown',
      reason: '',
      checkedAtMs: 0,
      ownerId,
      storagePressure: unknownStoragePressure(),
      promptLayers: unknownPromptLayers(),
      sourceOrder: unknownSourceOrder(),
      workTraceContract: unknownWorkTraceContract(),
    }
  );
}

function unknownReadiness(ownerId = ''): InternalReadiness {
  return {
    status: 'unknown',
    reason: '',
    checkedAtMs: 0,
    ownerId,
    storagePressure: unknownStoragePressure(),
    promptLayers: unknownPromptLayers(),
    sourceOrder: unknownSourceOrder(),
    workTraceContract: unknownWorkTraceContract(),
  };
}

function ownerRequiredSnapshot(): OrchestrationReadinessSnapshot {
  return Object.freeze({
    requested: true,
    available: false,
    status: 'owner_required',
    reason: 'owner_required',
    checkedAtMs: 0,
    storagePressure: unknownStoragePressure(),
    promptLayers: unknownPromptLayers(),
    sourceOrder: unknownSourceOrder(),
    workTraceContract: unknownWorkTraceContract(),
  });
}

function snapshotFromReadiness(
  readiness: InternalReadiness,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): OrchestrationReadinessSnapshot {
  const requested = parallelWorkRequested();
  const fresh = readiness.checkedAtMs > 0 && nowMs - readiness.checkedAtMs <= readinessMaxAgeMs();
  const available = requested && fresh && readiness.status === 'ready';
  let status = 'disabled';
  if (requested) status = fresh ? readiness.status : 'stale';
  return Object.freeze({
    requested,
    available,
    status,
    reason: requested && fresh ? readiness.reason : '',
    checkedAtMs: readiness.checkedAtMs,
    storagePressure: readiness.storagePressure || unknownStoragePressure(),
    promptLayers: readiness.promptLayers || unknownPromptLayers(),
    sourceOrder: readiness.sourceOrder || unknownSourceOrder(),
    workTraceContract: readiness.workTraceContract || unknownWorkTraceContract(),
  });
}

function rememberReadiness(ownerId: string, value: InternalReadiness): void {
  if (!readinessByOwner.has(ownerId) && readinessByOwner.size >= MAX_TRACKED_OWNERS) {
    const oldest = readinessByOwner.keys().next().value;
    if (oldest) {
      readinessByOwner.delete(oldest);
      observedAtByOwner.delete(oldest);
    }
  }
  readinessByOwner.set(ownerId, value);
}

function observeOwner(ownerId: string, nowMs = Date.now()): void {
  if (!observedAtByOwner.has(ownerId) && observedAtByOwner.size >= MAX_TRACKED_OWNERS) {
    let oldestOwnerId = '';
    let oldestObservedAtMs = Number.POSITIVE_INFINITY;
    for (const [trackedOwnerId, observedAtMs] of observedAtByOwner) {
      if (observedAtMs < oldestObservedAtMs) {
        oldestOwnerId = trackedOwnerId;
        oldestObservedAtMs = observedAtMs;
      }
    }
    if (oldestOwnerId) {
      observedAtByOwner.delete(oldestOwnerId);
      readinessByOwner.delete(oldestOwnerId);
    }
  }
  observedAtByOwner.set(ownerId, nowMs);
}

function observedOwnersForWatcher(nowMs = Date.now()): string[] {
  const owners: string[] = [];
  for (const ownerId of readinessByOwner.keys()) {
    const observedAtMs = Number(observedAtByOwner.get(ownerId)) || 0;
    if (observedAtMs <= 0 || nowMs - observedAtMs > ownerIdleTtlMs()) {
      readinessByOwner.delete(ownerId);
      observedAtByOwner.delete(ownerId);
      continue;
    }
    owners.push(ownerId);
  }
  return owners;
}

function probeCapacitySnapshot(ownerId: string): OrchestrationReadinessSnapshot {
  const next: InternalReadiness = {
    status: 'capacity_limited',
    reason: 'readiness_probe_capacity_limited',
    checkedAtMs: Date.now(),
    ownerId,
    storagePressure: unknownStoragePressure('storage_capability_not_probed'),
    promptLayers: unknownPromptLayers('prompt_layer_capability_not_probed'),
    sourceOrder: unknownSourceOrder('source_order_capability_not_probed'),
    workTraceContract: unknownWorkTraceContract('work_trace_contract_not_probed'),
  };
  rememberReadiness(ownerId, next);
  return snapshotFromReadiness(next);
}

export function orchestrationReadinessSnapshot({
  ownerId,
  nowMs = Date.now(),
}: { ownerId?: unknown; nowMs?: number } = {}): OrchestrationReadinessSnapshot {
  if (!parallelWorkRequested()) return snapshotFromReadiness(unknownReadiness(), { nowMs });
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) return ownerRequiredSnapshot();
  return snapshotFromReadiness(readinessRecord(normalizedOwnerId), { nowMs });
}

export function orchestrationDeploymentReadinessSnapshot({
  nowMs = Date.now(),
}: { nowMs?: number } = {}): OrchestrationReadinessSnapshot {
  return snapshotFromReadiness(deploymentReadiness || unknownReadiness(), { nowMs });
}

export async function refreshOrchestrationReadiness({
  ownerId,
  observed = true,
}: { ownerId?: unknown; observed?: boolean } = {}): Promise<OrchestrationReadinessSnapshot> {
  if (!parallelWorkRequested()) {
    readinessByOwner.clear();
    inFlightByOwner.clear();
    observedAtByOwner.clear();
    deploymentReadiness = null;
    deploymentInFlight = null;
    return orchestrationReadinessSnapshot({ ownerId });
  }
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) return ownerRequiredSnapshot();
  if (observed) observeOwner(normalizedOwnerId);
  const existing = inFlightByOwner.get(normalizedOwnerId);
  if (existing) return existing;
  if (inFlightByOwner.size >= readinessMaxInFlight()) {
    logger.warn('[VIVENTIUM][parallel-work] Readiness probe capacity reached', {
      status: 'capacity_limited',
      inFlightCount: inFlightByOwner.size,
      maxInFlight: readinessMaxInFlight(),
    });
    return probeCapacitySnapshot(normalizedOwnerId);
  }
  const mainAgentId = String(process.env.VIVENTIUM_MAIN_AGENT_ID || '').trim();
  const probeStartedAt = performance.now();
  let capabilityMs: number | null = null;
  let mainAgentMs: number | null = null;
  let errorClass = '';
  const operation = Promise.all([
    requestReadinessCapability(normalizedOwnerId, 'owner').finally(() => {
      capabilityMs = performance.now() - probeStartedAt;
    }),
    (mainAgentId
      ? accessibleMainAgent(mainAgentId, normalizedOwnerId)
      : Promise.resolve(null)
    ).finally(() => {
      mainAgentMs = performance.now() - probeStartedAt;
    }),
  ])
    .then(([capability, mainAgent]) => {
      const isolationReady = validReadyCapability(capability);
      const main = mainAgentReadiness(mainAgent, mainAgentId);
      const storagePressure = normalizedStoragePressure(capability);
      const promptLayers = normalizedPromptLayers(capability);
      const sourceOrder = sourceOrderReadiness();
      const workTraceContract = normalizedWorkTraceContract(capability);
      const ready =
        isolationReady &&
        main.configured &&
        main.declared &&
        main.missingTools.length === 0 &&
        sourceOrder.status === 'verified' &&
        workTraceContractAllowsReadiness(workTraceContract) &&
        promptLayersAllowReadiness(promptLayers) &&
        storagePressureAllowsReadiness(storagePressure);
      let reason = '';
      if (!isolationReady) {
        reason = safeReadinessReason(
          process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE === 'host'
            ? capability?.nativeParallelReason
            : capability?.isolatedParallelReason,
        );
      } else if (!mainAgentId) {
        reason = 'main_agent_unconfigured';
      } else if (!main.configured) {
        reason = 'main_agent_unavailable';
      } else if (!main.declared) {
        reason = 'main_agent_undeclared';
      } else if (main.missingTools.length > 0) {
        reason = 'main_agent_tools_missing';
      } else if (sourceOrder.status !== 'verified') {
        reason = sourceOrder.reason || 'source_order_capability_invalid';
      } else if (!workTraceContractAllowsReadiness(workTraceContract)) {
        reason = workTraceContract.reason || 'work_trace_contract_invalid';
      } else if (!promptLayersAllowReadiness(promptLayers)) {
        reason = promptLayers.reason || 'prompt_layers_unknown';
      } else if (!storagePressureAllowsReadiness(storagePressure)) {
        reason = ['critical', 'warning'].includes(storagePressure.status)
          ? 'storage_pressure'
          : storagePressure.reason || 'storage_capability_invalid';
      }
      const previous = readinessRecord(normalizedOwnerId);
      const next: InternalReadiness = {
        status: ready ? 'ready' : 'unready',
        reason,
        diagnosticCode: '',
        checkedAtMs: Date.now(),
        ownerId: normalizedOwnerId,
        storagePressure,
        promptLayers,
        sourceOrder,
        workTraceContract,
      };
      rememberReadiness(normalizedOwnerId, next);
      if (storagePressure.status === 'warning' && previous.storagePressure?.status !== 'warning') {
        logger.warn('[VIVENTIUM][parallel-work] Storage pressure warning code=storage_pressure', {
          status: storagePressure.status,
          usedPercent: storagePressure.usedPercent,
          availableBytes: storagePressure.availableBytes,
          thresholdPercent: storagePressure.thresholdPercent,
        });
      }
      if (!ready && (previous.status !== next.status || previous.reason !== next.reason)) {
        const diagnosticCode = safeDiagnosticCode(reason, 'readiness_invariant_failed');
        logger.warn(
          `[VIVENTIUM][parallel-work] Readiness invariant failed code=${diagnosticCode}`,
          {
            status: next.status,
            reason: next.reason,
            isolationReady,
            mainAgentConfigured: main.configured,
            mainAgentDeclared: main.declared,
            missingFacadeToolCount: main.missingTools.length,
            sourceOrder,
            workTraceContract,
            storagePressure,
            promptLayers,
          },
        );
      }
      return orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
    })
    .catch((error: unknown) => {
      const runtimeError = error as { code?: string; name?: string };
      const previous = readinessRecord(normalizedOwnerId);
      const diagnosticCode = safeDiagnosticCode(runtimeError.code || runtimeError.name);
      errorClass = safeDiagnosticCode(runtimeError.name, 'unknown');
      const next: InternalReadiness = {
        status: 'unavailable',
        reason: 'readiness_unavailable',
        diagnosticCode,
        checkedAtMs: Date.now(),
        ownerId: normalizedOwnerId,
        storagePressure: unknownStoragePressure('storage_capability_unavailable'),
        promptLayers: unknownPromptLayers('prompt_layer_capability_unavailable'),
        sourceOrder: unknownSourceOrder('source_order_capability_unavailable'),
        workTraceContract: unknownWorkTraceContract('work_trace_contract_unavailable'),
      };
      rememberReadiness(normalizedOwnerId, next);
      if (previous.status !== next.status || previous.diagnosticCode !== diagnosticCode) {
        logger.warn(
          `[VIVENTIUM][parallel-work] Isolation readiness refresh failed code=${diagnosticCode}`,
        );
      }
      return orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
    })
    .finally(() => {
      const observed = readinessRecord(normalizedOwnerId);
      logReadinessStage(normalizedOwnerId, 'readiness_probe', {
        elapsedMs: performance.now() - probeStartedAt,
        capabilityMs,
        mainAgentMs,
        capabilityTimeoutMs: 1000,
        status: observed.status,
        reason: observed.reason,
        checkedAtMs: observed.checkedAtMs,
        diagnosticCode: observed.diagnosticCode || '',
        errorClass,
        storagePressure: observed.storagePressure,
      });
      if (inFlightByOwner.get(normalizedOwnerId) === operation) {
        inFlightByOwner.delete(normalizedOwnerId);
      }
    });
  inFlightByOwner.set(normalizedOwnerId, operation);
  return operation;
}

export function observeOrchestrationOwner(ownerId: unknown): OrchestrationReadinessSnapshot {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!parallelWorkRequested())
    return orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
  if (!normalizedOwnerId) return ownerRequiredSnapshot();
  observeOwner(normalizedOwnerId);
  const snapshot = orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
  if (normalizedOwnerId && (!snapshot.available || snapshot.status === 'stale')) {
    void refreshOrchestrationReadiness({ ownerId: normalizedOwnerId, observed: false });
  }
  return snapshot;
}

/* === VIVENTIUM START ===
 * Main authoring reuses fresh owner observations. A cold/stale owner gets only the existing
 * Active Work cold budget to join its deduplicated probe; explicit warm-up retains the long wait.
 * Native execution still owns admission, storage, capacity, ACL and atomic lease checks.
 * === VIVENTIUM END === */
export async function authoringOrchestrationReadiness({
  ownerId,
  sourceId,
  consumer,
  timeoutMs = activeWorkColdTimeoutMs(),
}: {
  ownerId?: unknown;
  sourceId?: unknown;
  consumer?: 'telegram' | 'tool_discovery';
  timeoutMs?: number;
} = {}): Promise<OrchestrationReadinessSnapshot> {
  const normalizedOwnerId = String(ownerId || '').trim();
  const startedAt = performance.now();
  const budgetMs = Math.max(0, Number(timeoutMs) || 0);
  let probeCount = 0;
  const complete = (snapshot: OrchestrationReadinessSnapshot, outcome: string) => {
    logReadinessStage(normalizedOwnerId, 'turn_readiness', {
      sourceHash: sourceId ? createHash('sha256').update(String(sourceId)).digest('hex') : null,
      consumer: consumer || 'unknown',
      elapsedMs: performance.now() - startedAt,
      timeoutMs: budgetMs,
      probeCount,
      outcome,
      requested: snapshot.requested,
      available: snapshot.available,
      status: snapshot.status,
      reason: snapshot.reason,
      checkedAtMs: snapshot.checkedAtMs,
      ageMs: snapshot.checkedAtMs > 0 ? Math.max(0, Date.now() - snapshot.checkedAtMs) : null,
      storagePressure: snapshot.storagePressure,
    });
    return snapshot;
  };
  if (normalizedOwnerId) observeOwner(normalizedOwnerId);
  const snapshot = orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
  if (!snapshot.requested || !normalizedOwnerId) return complete(snapshot, 'not_requested');
  if (!['unknown', 'stale'].includes(snapshot.status)) return complete(snapshot, 'fresh_snapshot');

  observeOrchestrationOwner(normalizedOwnerId);
  const probe = inFlightByOwner.get(normalizedOwnerId);
  if (!probe || budgetMs <= 0) return complete(snapshot, 'cold_budget');
  probeCount = 1;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    probe,
    new Promise<OrchestrationReadinessSnapshot>((resolve) => {
      timeout = setTimeout(() => resolve(snapshot), budgetMs);
    }),
  ]).finally(() => clearTimeout(timeout));
  return complete(observed, observed === snapshot ? 'cold_budget' : 'refreshed_snapshot');
}

async function resolveStartupOwnerId(): Promise<string> {
  if (startupOwnerId) return startupOwnerId;
  if (startupOwnerResolution) return startupOwnerResolution;
  const operation = findUser({ role: 'ADMIN' }, '_id')
    .catch(() => null)
    .then((user) => {
      startupOwnerId = String(user?._id || user?.id || '').trim();
      return startupOwnerId;
    })
    .finally(() => {
      if (startupOwnerResolution === operation) startupOwnerResolution = null;
    });
  startupOwnerResolution = operation;
  return operation;
}

export async function refreshStartupOrchestrationReadiness(): Promise<OrchestrationReadinessSnapshot> {
  if (!parallelWorkRequested()) {
    deploymentReadiness = null;
    deploymentInFlight = null;
    return orchestrationDeploymentReadinessSnapshot();
  }
  if (deploymentInFlight) return deploymentInFlight;
  const ownerId = await resolveStartupOwnerId();
  if (deploymentInFlight) return deploymentInFlight;
  if (!ownerId) {
    deploymentReadiness = {
      ...unknownReadiness(),
      status: 'unavailable',
      reason: 'startup_owner_unavailable',
      checkedAtMs: Date.now(),
    };
    return orchestrationDeploymentReadinessSnapshot();
  }
  const operation = requestReadinessCapability(ownerId, 'deployment')
    .then((capability) => {
      const previous = deploymentReadiness || unknownReadiness();
      const deploymentScoped = hasTypedDeploymentScope(capability);
      const isolationReady = validReadyCapability(capability);
      const storagePressure = normalizedStoragePressure(capability);
      const promptLayers = normalizedPromptLayers(capability);
      const sourceOrder = sourceOrderReadiness();
      const workTraceContract = normalizedWorkTraceContract(capability);
      const ready =
        deploymentScoped &&
        isolationReady &&
        sourceOrder.status === 'verified' &&
        workTraceContractAllowsReadiness(workTraceContract) &&
        promptLayersAllowReadiness(promptLayers) &&
        storagePressureAllowsReadiness(storagePressure);
      let reason = '';
      if (!deploymentScoped) {
        reason = 'deployment_scope_unverified';
      } else if (!isolationReady) {
        reason = safeReadinessReason(
          process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE === 'host'
            ? capability?.nativeParallelReason
            : capability?.isolatedParallelReason,
        );
      } else if (sourceOrder.status !== 'verified') {
        reason = sourceOrder.reason || 'source_order_capability_invalid';
      } else if (!workTraceContractAllowsReadiness(workTraceContract)) {
        reason = workTraceContract.reason || 'work_trace_contract_invalid';
      } else if (!promptLayersAllowReadiness(promptLayers)) {
        reason = promptLayers.reason || 'prompt_layers_unknown';
      } else if (!storagePressureAllowsReadiness(storagePressure)) {
        reason = ['critical', 'warning'].includes(storagePressure.status)
          ? 'storage_pressure'
          : storagePressure.reason || 'storage_capability_invalid';
      }
      deploymentReadiness = {
        status: ready ? 'ready' : 'unready',
        reason,
        diagnosticCode: '',
        checkedAtMs: Date.now(),
        ownerId: '',
        storagePressure,
        promptLayers,
        sourceOrder,
        workTraceContract,
      };
      if (
        !ready &&
        (previous.status !== deploymentReadiness.status || previous.reason !== reason)
      ) {
        const diagnosticCode = safeDiagnosticCode(reason, 'readiness_invariant_failed');
        logger.warn(
          `[VIVENTIUM][parallel-work] Deployment readiness invariant failed code=${diagnosticCode}`,
          {
            status: deploymentReadiness.status,
            reason,
            deploymentScoped,
            isolationReady,
            sourceOrder,
            workTraceContract,
            storagePressure,
            promptLayers,
          },
        );
      }
      return orchestrationDeploymentReadinessSnapshot();
    })
    .catch((error: unknown) => {
      const runtimeError = error as { code?: string; name?: string };
      const previous = deploymentReadiness || unknownReadiness();
      const diagnosticCode = safeDiagnosticCode(runtimeError.code || runtimeError.name);
      deploymentReadiness = {
        ...unknownReadiness(),
        status: 'unavailable',
        reason: 'readiness_unavailable',
        diagnosticCode,
        checkedAtMs: Date.now(),
        storagePressure: unknownStoragePressure('storage_capability_unavailable'),
        promptLayers: unknownPromptLayers('prompt_layer_capability_unavailable'),
        sourceOrder: unknownSourceOrder('source_order_capability_unavailable'),
        workTraceContract: unknownWorkTraceContract('work_trace_contract_unavailable'),
      };
      if (
        previous.status !== deploymentReadiness.status ||
        previous.diagnosticCode !== diagnosticCode
      ) {
        logger.warn(
          `[VIVENTIUM][parallel-work] Deployment readiness refresh failed code=${diagnosticCode}`,
        );
      }
      return orchestrationDeploymentReadinessSnapshot();
    })
    .finally(() => {
      if (deploymentInFlight === operation) deploymentInFlight = null;
    });
  deploymentInFlight = operation;
  return operation;
}

const DEFINITIVE_READINESS_REJECTIONS = new Set([
  'isolated_parallel_policy_disabled',
  'native_parallel_not_authorized',
  'parallel_clean_room_network_unconfigured',
  'parallel_clean_room_provider_proxy_unconfigured',
  'parallel_clean_room_broker_proxy_unconfigured',
  'parallel_clean_room_provider_egress_network_unconfigured',
  'parallel_clean_room_proxy_image_unconfigured',
  'parallel_clean_room_proxy_upstream_unconfigured',
  'main_agent_unconfigured',
  'main_agent_undeclared',
  'main_agent_tools_missing',
]);

function definitiveReadinessRejection(snapshot: OrchestrationReadinessSnapshot): boolean {
  return snapshot.status === 'unready' && DEFINITIVE_READINESS_REJECTIONS.has(snapshot.reason);
}

export async function waitForOrchestrationReadiness({
  ownerId,
  timeoutMs = positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_TURN_READINESS_TIMEOUT_MS',
    15_000,
    250,
    120_000,
  ),
  pollIntervalMs = positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_TURN_READINESS_POLL_MS',
    250,
    50,
    5_000,
  ),
}: {
  ownerId?: unknown;
  timeoutMs?: number;
  pollIntervalMs?: number;
} = {}): Promise<OrchestrationReadinessSnapshot> {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (normalizedOwnerId) observeOwner(normalizedOwnerId);
  let snapshot = orchestrationReadinessSnapshot({ ownerId: normalizedOwnerId });
  if (!snapshot.requested) return snapshot;
  if (!normalizedOwnerId) return snapshot;
  if (snapshot.available || definitiveReadinessRejection(snapshot)) return snapshot;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    snapshot = await refreshOrchestrationReadiness({
      ownerId: normalizedOwnerId,
      observed: false,
    });
    if (snapshot.available || definitiveReadinessRejection(snapshot) || Date.now() >= deadline)
      return snapshot;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(Math.max(1, Number(pollIntervalMs) || 1), deadline - Date.now()),
      ),
    );
  } while (Date.now() < deadline);
  return snapshot;
}

export function startOrchestrationReadinessWatcher(): ValueRecord {
  const intervalMs = readinessIntervalMs();
  if (!parallelWorkRequested()) return { started: false, reason: 'disabled', intervalMs };
  if (timer) return { started: false, reason: 'already_started', intervalMs };
  // Mongo/user discovery can legitimately be empty during startup. Retry discovery on every tick
  // until an owner is known; otherwise one early miss leaves Parallel unavailable forever.
  void refreshStartupOrchestrationReadiness();
  timer = setInterval(() => {
    const owners = observedOwnersForWatcher();
    void Promise.all([
      refreshStartupOrchestrationReadiness(),
      ...owners.map((ownerId) => refreshOrchestrationReadiness({ ownerId, observed: false })),
    ]);
  }, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs };
}

export function resetOrchestrationReadinessForTests(value: ValueRecord = {}): void {
  if (timer) clearInterval(timer);
  timer = null;
  inFlightByOwner.clear();
  readinessByOwner.clear();
  observedAtByOwner.clear();
  startupOwnerId = '';
  startupOwnerResolution = null;
  deploymentReadiness = null;
  deploymentInFlight = null;
  const ownerId = String(value.ownerId || '').trim();
  const seeded: InternalReadiness = {
    status: value.status || 'unknown',
    reason: safeReadinessReason(value.reason, ''),
    checkedAtMs: Number(value.checkedAtMs) || 0,
    ownerId,
    sourceOrder: value.sourceOrder || unknownSourceOrder(),
    storagePressure: value.storagePressure || unknownStoragePressure(),
    promptLayers: value.promptLayers || unknownPromptLayers(),
    workTraceContract: value.workTraceContract || unknownWorkTraceContract(),
  };
  if (ownerId) {
    observeOwner(ownerId, Number(value.observedAtMs) || Date.now());
    rememberReadiness(ownerId, seeded);
  }
  if (value.scope === 'deployment') deploymentReadiness = seeded;
}
