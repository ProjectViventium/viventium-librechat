/* === VIVENTIUM START ===
 * Feature: Canonical account-wide Parallel work mode resolution.
 * Purpose: Keep Web, Telegram, Voice, and Main on the same availability/default/user-override rule.
 * === VIVENTIUM END === */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

import type { Document } from 'mongodb';
import type { Worker as WorkerThread } from 'worker_threads';

type ValueRecord = Document;

interface CatalogRecord {
  case_id: string;
  status: string;
  source: string;
  detail?: string;
}

interface QaReceiptAuthority {
  ownerBindingSha256: string;
  verifierIds: ValueRecord;
  key?: Buffer;
}

interface DeploymentAvailabilityCache {
  fingerprint: string;
  available: boolean;
  checkedAtMs: number;
}

interface DeploymentAvailabilityInFlight {
  fingerprint: string;
  promise: Promise<boolean>;
}

interface ArtifactIdentityFacts {
  shapeValid: boolean;
  sourcePass: boolean;
  nestedPass: boolean;
  prebuiltPass: boolean;
  installedPass: boolean;
}

interface ReadinessFactsResult {
  shapeValid: boolean;
  promptPass: boolean;
  storagePass: boolean;
  prompt: ValueRecord;
}

interface ValidatedReleaseSnapshot {
  snapshot: ValueRecord;
  checks: ValueRecord[];
  artifactChecks: ValueRecord[];
  candidatePass: boolean;
  localQaShapePass: boolean;
}

export interface ParallelWorkReleaseGate {
  available: boolean;
  releaseReady: boolean;
  label: 'READY' | 'NOT READY' | 'PRE-GATE / NOT READY';
  blockers: string[];
}

export interface ParallelWorkClaimState {
  available: boolean;
  label: ParallelWorkReleaseGate['label'];
  blockers: string[];
}

export interface OrchestrationRuntimeTraceBinding {
  contractVersion: 1;
  candidateDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
}

export interface OrchestrationModeUser {
  id?: unknown;
  _id?: unknown;
  personalization?: { orchestration_mode?: unknown };
}

export interface OrchestrationModeDependencies {
  orchestrationReadinessSnapshot(input?: { ownerId?: string }): ValueRecord;
  orchestrationDeploymentReadinessSnapshot(): ValueRecord;
}

let orchestrationModeDependencies: OrchestrationModeDependencies | null = null;

export function configureOrchestrationMode(dependencies: OrchestrationModeDependencies): void {
  orchestrationModeDependencies = dependencies;
}

function runtimeDependencies(): OrchestrationModeDependencies {
  if (!orchestrationModeDependencies) {
    throw new Error('orchestration_mode_dependencies_unavailable');
  }
  return orchestrationModeDependencies;
}

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const SNAPSHOT_TTL_SECONDS = 86_400;
const QA_RECEIPT_TTL_SECONDS = 86_400;
const SNAPSHOT_RENEWAL_WINDOW_MS = 3_600_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const RELEASE_GATE_WORKER_ACTION = 'viventium.parallel-work.release-gate.v1';
const RELEASE_GATE_WORKER_TIMEOUT_MS = 135_000;
const RELEASE_GATE_FAST_READ_MAX_BYTES = 1_048_576;
const DEPLOYMENT_AVAILABILITY_REFRESH_MS = 5 * 60_000;
const RELEASE_GATE_WORKER_ENVIRONMENT_KEYS = Object.freeze([
  'CONFIG_PATH',
  'VIVENTIUM_LIBRECHAT_CONFIG_PATH',
  'VIVENTIUM_PARALLEL_WORK_LOCAL_QA_OVERRIDE',
  'VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE',
  'VIVENTIUM_RUNTIME_DIR',
]);
const releaseGateReusePermits = new WeakMap<object, ParallelWorkReleaseGate>();
const ownerClaimReusePermits = new WeakMap<object, string>();
let deploymentAvailabilityCache: DeploymentAvailabilityCache | null = null;
let deploymentAvailabilityInFlight: DeploymentAvailabilityInFlight | null = null;
const REQUIRED_READINESS_CHECK_IDS = Object.freeze(['PROMPT-LAYERS', 'STORAGE-PRESSURE']);
const REQUIRED_ARTIFACT_CHECK_IDS = Object.freeze([
  'SOURCE-IDENTITY',
  'NESTED-PINS',
  'PREBUILT-IDENTITY',
  'INSTALLED-ARTIFACT',
]);
const CANONICAL_DETACHED_OWNER_ARGV = Object.freeze([
  '{ownerExecutablePath}',
  '--app-support-dir',
  '{appSupportDir}',
  '--config-file',
  '{configFile}',
  '--runtime-dir',
  '{runtimeDir}',
  '--lock-file',
  '{componentsLockFile}',
  'start',
  '--restart',
]);
const CANONICAL_ATTACHED_OWNER_ARGV = Object.freeze([
  ['{ownerExecutablePath}', '{command}'],
  ['{ownerExecutablePath}', '{command}', '--restart'],
  [
    '{ownerExecutablePath}',
    '--app-support-dir',
    '{appSupportDir}',
    '--config-file',
    '{configFile}',
    '--runtime-dir',
    '{runtimeDir}',
    '--lock-file',
    '{componentsLockFile}',
    '{command}',
  ],
  [
    '{ownerExecutablePath}',
    '--app-support-dir',
    '{appSupportDir}',
    '--config-file',
    '{configFile}',
    '--runtime-dir',
    '{runtimeDir}',
    '--lock-file',
    '{componentsLockFile}',
    '{command}',
    '--restart',
  ],
]);
const CANONICAL_PROCESS_WRAPPERS = Object.freeze([
  '',
  '/bin/bash ',
  '/bin/sh ',
  '/bin/zsh ',
  '/usr/bin/env bash ',
  'bash ',
  'sh ',
  'zsh ',
]);
const INSTALLED_ARTIFACT_HASH_KEYS = Object.freeze([
  'componentsLockSha256',
  'nestedRevisionsHash',
  'prebuiltSourceSha256',
  'prebuiltBinarySha256',
  'promptBundleSha256',
  'runtimeEnvSha256',
  'libreChatConfigSha256',
  'frontendBuildSha256',
  'apiBuildSha256',
  'runningServiceSha256',
  'runtimeServiceManifestSha256',
  'runtimeOwnerExecutableSha256',
  'ownerCommandContractSha256',
]);
const READINESS_IDENTITY_HASH_KEYS = Object.freeze([
  'factsSha256',
  'storagePolicySha256',
  'storageMeasurementSha256',
]);
const QA_RECEIPT_SURFACES = new Set([
  'api',
  'cli',
  'installer',
  'scheduler',
  'telegram',
  'voice',
  'web',
  'workbench',
]);
const QA_RECEIPT_CASE_SURFACES: Readonly<Record<string, string>> = Object.freeze({
  'MPV-061': 'voice',
  'TGDOC-010': 'telegram',
});
const QA_RECEIPT_SERVICE_ACK_CASES = new Set([
  'TR-026',
  'EMO-UC-047',
  'EMO-UC-048',
  'PWK-UC-016',
  'PWK-UC-017',
  'REL-UC-004',
]);
const QA_RECEIPT_ATTESTATION_KEY_NAME = 'parallel-work-qa-attestation.key';
const QA_RECEIPT_ATTESTATION_FIELDS = Object.freeze([
  'attestation',
  'ownerBindingSha256',
  'receiptNonce',
  'verifierId',
  'verifierManifestSha256',
]);
const QA_RECEIPT_EXTERNAL_ATTESTATION_FIELDS = Object.freeze([
  'attestationContractVersion',
  'attestationPurpose',
  'attestationSequence',
  'producerAttestations',
  'publisherAttestation',
  'publisherIdentity',
  'serviceAcknowledgements',
]);
const TRUSTED_SYSTEM_PYTHON = '/usr/bin/python3';
const TRUSTED_PYTHON_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  PYTHONNOUSERSITE: '1',
  PYTHONSAFEPATH: '1',
});
const TRUSTED_PYTHON_GATE_RUNNER = [
  'import dataclasses,datetime,inspect,os,pathlib,runpy,sys',
  'if "follow_symlinks" not in inspect.signature(pathlib.Path.stat).parameters:',
  '    pathlib.Path.stat=lambda self,*,follow_symlinks=True: os.stat(self,follow_symlinks=follow_symlinks)',
  'if "slots" not in inspect.signature(dataclasses.dataclass).parameters:',
  '    original_dataclass=dataclasses.dataclass',
  '    def compatible_dataclass(cls=None,**options):',
  '        options.pop("slots",None)',
  '        return original_dataclass(cls,**options)',
  '    dataclasses.dataclass=compatible_dataclass',
  'if sys.version_info<(3,11):',
  '    class CompatibleDateTime(datetime.datetime):',
  '        @classmethod',
  '        def fromisoformat(cls,value):',
  '            if isinstance(value,str) and value.endswith("Z"): value=value[:-1]+"+00:00"',
  '            return super().fromisoformat(value)',
  '    datetime.datetime=CompatibleDateTime',
  'sys.argv=sys.argv[1:]',
  'runpy.run_path(sys.argv[0],run_name="__main__")',
].join('\n');
const QA_VERIFIER_REGISTRY_QUERY = [
  'import ast,json,sys',
  'tree=ast.parse(open(sys.argv[1],encoding="utf-8").read())',
  'matches=[]',
  'for node in tree.body:',
  '    targets=node.targets if isinstance(node,ast.Assign) else [node.target] if isinstance(node,ast.AnnAssign) else []',
  '    if any(isinstance(target,ast.Name) and target.id=="REGISTERED_SEMANTIC_VERIFIERS" for target in targets):',
  '        matches.append(node.value)',
  'if len(matches)!=1 or sum(1 for _ in ast.walk(matches[0]))>4096: raise SystemExit(2)',
  'def read(node,scope):',
  '    if isinstance(node,ast.Constant) and isinstance(node.value,(str,int)): return node.value',
  '    if isinstance(node,ast.Name) and node.id in scope: return scope[node.id]',
  '    if isinstance(node,ast.Tuple):',
  '        if len(node.elts)>1000: raise ValueError("unsafe tuple")',
  '        return tuple(read(item,scope) for item in node.elts)',
  '    if isinstance(node,ast.Dict):',
  '        result={}',
  '        for key,value in zip(node.keys,node.values):',
  '            if key is None: result.update(read(value,scope))',
  '            else: result[read(key,scope)]=read(value,scope)',
  '        return result',
  '    if isinstance(node,ast.JoinedStr): return "".join(str(read(part,scope)) for part in node.values)',
  '    if isinstance(node,ast.FormattedValue):',
  '        if node.conversion!=-1: raise ValueError("unsafe conversion")',
  '        return format(read(node.value,scope),read(node.format_spec,scope) if node.format_spec else "")',
  '    if isinstance(node,ast.Call):',
  '        if not isinstance(node.func,ast.Name) or node.keywords: raise ValueError("unsafe call")',
  '        arguments=[read(argument,scope) for argument in node.args]',
  '        if node.func.id=="Path" and len(arguments)==1 and isinstance(arguments[0],str): return arguments[0]',
  '        if node.func.id=="range" and 1<=len(arguments)<=3 and all(isinstance(value,int) and abs(value)<10000 for value in arguments): return range(*arguments)',
  '        raise ValueError("unsafe call")',
  '    if isinstance(node,ast.DictComp):',
  '        if not 1<=len(node.generators)<=2: raise ValueError("unsafe comprehension")',
  '        result={}',
  '        def collect(index,current):',
  '            if index==len(node.generators):',
  '                if len(result)>=1000: raise ValueError("unsafe comprehension size")',
  '                result[read(node.key,current)]=read(node.value,current)',
  '                return',
  '            generator=node.generators[index]',
  '            if generator.ifs or generator.is_async: raise ValueError("unsafe comprehension")',
  '            values=read(generator.iter,current)',
  '            if not isinstance(values,(range,tuple)) or len(values)>1000: raise ValueError("unsafe iteration")',
  '            for value in values:',
  '                if isinstance(generator.target,ast.Name): bindings={generator.target.id:value}',
  '                elif isinstance(generator.target,ast.Tuple) and isinstance(value,tuple) and len(generator.target.elts)==len(value) and all(isinstance(item,ast.Name) for item in generator.target.elts):',
  '                    bindings={item.id:item_value for item,item_value in zip(generator.target.elts,value)}',
  '                    if len(bindings)!=len(value): raise ValueError("duplicate binding")',
  '                else: raise ValueError("unsafe target")',
  '                collect(index+1,{**current,**bindings})',
  '        collect(0,scope)',
  '        return result',
  '    raise ValueError("unsupported verifier registry")',
  'registry=read(matches[0],{})',
  'if not isinstance(registry,dict): raise SystemExit(3)',
  'result={}',
  'for case_id,registration in registry.items():',
  '    verifier_id=registration if isinstance(registration,str) else registration.get("id") if isinstance(registration,dict) else None',
  '    if not isinstance(case_id,str) or not isinstance(verifier_id,str): raise SystemExit(4)',
  '    result[case_id]=verifier_id',
  'print(json.dumps(result,sort_keys=True,separators=(",",":")))',
].join('\n');
const CATALOG_STATUS_HEADERS = new Set(['current status', 'last run', 'latest result', 'status']);
const TABLE_CATALOGS: ReadonlyArray<readonly [string, RegExp, string]> = Object.freeze([
  ['qa/parallel-orchestrator/cases.md', /^PWK-.+$/, 'CATALOG-PWK'],
  ['qa/release-readiness/cases.md', /^REL-.+$/, 'CATALOG-REL'],
]);
const CROSS_OWNER_TABLE_CASES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['qa/emotional-cortex/cases.md', 'EMO-UC-047'],
  ['qa/emotional-cortex/cases.md', 'EMO-UC-048'],
  ['qa/telegram-document-attachments/cases.md', 'TGDOC-010'],
]);
const CROSS_OWNER_DETAIL_CASES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['qa/telegram-runtime/cases.md', 'TR-026'],
  ['qa/modern-playground-voice/cases.md', 'MPV-061'],
]);

function isRecord(value: unknown): value is ValueRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): boolean {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isSha256Ref(value: unknown): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ''));
}

function isGitRevision(value: unknown): boolean {
  return /^[0-9a-f]{40}$/.test(String(value || ''));
}

function isSafeName(value: unknown): boolean {
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(String(value || ''));
}

function isSafeReason(value: unknown): boolean {
  return value === '' || /^[a-z0-9_.-]{1,120}$/.test(String(value || ''));
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sha256Text(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath: string): string {
  try {
    return sha256Text(fs.readFileSync(filePath));
  } catch (_error) {
    return '';
  }
}

function canonicalJson(value: ValueRecord): string {
  const ordered = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
  return JSON.stringify(ordered);
}

function canonicalJsonDeep(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonDeep).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonDeep(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeCatalogStatus(value: unknown): string {
  const text = String(value || '');
  const statuses: ReadonlyArray<readonly [string, RegExp]> = [
    ['FAIL', /\bFAIL\b/],
    ['BLOCKED', /\bBLOCKED\b/],
    ['PARTIAL', /\bPARTIAL\b/],
    ['NOT_RUN', /\b(?:NOT YET RUN|NOT RUN|PENDING)\b/],
    ['PASS', /\bPASS\b/],
  ];
  for (const [status, pattern] of statuses) {
    if (pattern.test(text)) return status;
  }
  return 'UNKNOWN';
}

function markdownCells(line: string): string[] {
  if (!String(line).trimStart().startsWith('|')) return [];
  const content = String(line)
    .trim()
    .replace(/^\|+|\|+$/g, '');
  const cells = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const character of content) {
    if (character === '|' && !escaped && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
    if (character === '`' && !escaped) inCode = !inCode;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
  }
  cells.push(cell.trim());
  return cells;
}

function statusHeaderIndex(cells: string[]): number {
  return cells.findIndex((cell) =>
    CATALOG_STATUS_HEADERS.has(
      String(cell)
        .toLowerCase()
        .replace(/[^a-z]+/g, ' ')
        .trim(),
    ),
  );
}

function statusDetail(cells: string[], statusIndex: number): string {
  if (statusIndex < 0) return 'status column missing';
  if (statusIndex >= cells.length) return 'status cell missing';
  const first = cells[statusIndex];
  return /^(?:(?:\d{4}-\d{2}-\d{2})(?:\s+(?:local|UTC))?\s*(?:\/\s*)?)*(?:NOT YET RUN|NOT RUN|PENDING|FAIL|BLOCKED|PARTIAL|PASS)\b/.test(
    first,
  )
    ? cells.slice(statusIndex).join(' | ')
    : first;
}

function tableRecords(
  repoRoot: string,
  relativePath: string,
  pattern: RegExp,
  catalogId = '',
): CatalogRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (_error) {
    return catalogId ? [{ case_id: catalogId, status: 'MISSING', source: relativePath }] : [];
  }
  const records: CatalogRecord[] = [];
  let statusIndex = -1;
  for (const line of text.split(/\r?\n/)) {
    const cells = markdownCells(line);
    if (!cells.length) {
      statusIndex = -1;
      continue;
    }
    if (cells.length < 2) continue;
    const caseId = cells[0]
      .trim()
      .replace(/^`+|`+$/g, '')
      .trim();
    if (pattern.test(caseId)) {
      records.push({
        case_id: caseId,
        status: normalizeCatalogStatus(statusDetail(cells, statusIndex)),
        source: relativePath,
      });
      continue;
    }
    const headerIndex = statusHeaderIndex(cells);
    if (headerIndex >= 0) statusIndex = headerIndex;
  }
  return records.length || !catalogId
    ? records
    : [{ case_id: catalogId, status: 'MISSING', source: relativePath }];
}

function exactTableRecord(repoRoot: string, relativePath: string, caseId: string): CatalogRecord {
  const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const records = tableRecords(repoRoot, relativePath, new RegExp(`^${escaped}$`));
  if (records.length === 1) return records[0];
  if (records.length > 1) throw new Error(`duplicate release gate ${caseId}`);
  return { case_id: caseId, status: 'MISSING', source: relativePath };
}

function detailRecord(repoRoot: string, relativePath: string, caseId: string): CatalogRecord {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (_error) {
    return { case_id: caseId, status: 'MISSING', source: relativePath };
  }
  const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headings = [
    ...text.matchAll(new RegExp(`^(#{2,6})\\s+(?:Case\\s+)?${escaped}\\b.*$`, 'gm')),
  ];
  if (headings.length > 1) throw new Error(`duplicate release gate ${caseId}`);
  const heading = headings[0];
  if (!heading) return { case_id: caseId, status: 'MISSING', source: relativePath };
  const rest = text.slice((heading.index ?? 0) + heading[0].length);
  const headingLevel = heading[1].length;
  const nextHeading = new RegExp(`^#{2,${headingLevel}}\\s+`, 'm').exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const lastRun = /^\s*-\s*(?:\*\*)?Last\s+run\s*:(?:\*\*)?\s*(.+)$/im.exec(section);
  return {
    case_id: caseId,
    status: lastRun ? normalizeCatalogStatus(lastRun[1].trim()) : 'UNKNOWN',
    source: relativePath,
  };
}

function trustedInstalledGateInventory(
  snapshot: ValueRecord,
  runtimeDir: string,
): CatalogRecord[] | null {
  try {
    const profile = String(snapshot?.owner_binding?.runtimeProfile || '');
    if (!isSafeName(profile)) return null;
    const ownerPath = fs.realpathSync(
      path.join(path.dirname(runtimeDir), 'state', 'runtime', profile, 'stack-owner.json'),
    );
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    const repoRoot = fs.realpathSync(String(owner.repoRoot || ''));
    if (fs.realpathSync(String(owner.runtimeDir || '')) !== runtimeDir) return null;
    const records: CatalogRecord[] = [];
    for (const [relativePath, pattern, catalogId] of TABLE_CATALOGS) {
      records.push(...tableRecords(repoRoot, relativePath, pattern, catalogId));
    }
    for (const [relativePath, caseId] of CROSS_OWNER_TABLE_CASES) {
      records.push(exactTableRecord(repoRoot, relativePath, caseId));
    }
    for (const [relativePath, caseId] of CROSS_OWNER_DETAIL_CASES) {
      records.push(detailRecord(repoRoot, relativePath, caseId));
    }
    const ids = records.map((record) => record.case_id);
    if (new Set(ids).size !== ids.length) return null;
    return records.sort((left, right) =>
      left.case_id < right.case_id ? -1 : left.case_id > right.case_id ? 1 : 0,
    );
  } catch (_error) {
    return null;
  }
}

function trustedSystemPython(): string {
  const details = fs.statSync(TRUSTED_SYSTEM_PYTHON);
  if (!details.isFile() || details.uid !== 0 || (details.mode & 0o022) !== 0) {
    throw new Error('trusted system Python is unavailable');
  }
  fs.accessSync(TRUSTED_SYSTEM_PYTHON, fs.constants.X_OK);
  return TRUSTED_SYSTEM_PYTHON;
}

function trustedQaVerifierRegistry(repoRoot: string): ValueRecord | null {
  try {
    const expectedGateScript = path.join(
      repoRoot,
      'scripts',
      'viventium',
      'parallel_work_release_gate.py',
    );
    const gateScript = fs.realpathSync(expectedGateScript);
    if (gateScript !== expectedGateScript) return null;
    const registry = JSON.parse(
      execFileSync(trustedSystemPython(), ['-I', '-c', QA_VERIFIER_REGISTRY_QUERY, gateScript], {
        encoding: 'utf8',
        env: TRUSTED_PYTHON_ENVIRONMENT,
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }),
    );
    if (
      !isRecord(registry) ||
      !Object.entries(registry).every(
        ([caseId, verifierId]) => isSafeName(caseId) && isSafeName(verifierId),
      )
    ) {
      return null;
    }
    return registry;
  } catch (_error) {
    return null;
  }
}

function qaReceiptAttestationAuthority(
  snapshot: ValueRecord,
  runtimeDir: string,
  { requireLocalKey = true }: { requireLocalKey?: boolean } = {},
): QaReceiptAuthority | null {
  let descriptor: number | null = null;
  try {
    if (typeof process.getuid !== 'function' || !Number.isInteger(fs.constants.O_NOFOLLOW)) {
      return null;
    }
    const realRuntimeDir = fs.realpathSync(runtimeDir);
    const runtimeStat = fs.statSync(realRuntimeDir);
    if (
      runtimeDir !== realRuntimeDir ||
      !runtimeStat.isDirectory() ||
      (runtimeStat.mode & 0o777) !== 0o700 ||
      runtimeStat.uid !== process.getuid()
    ) {
      return null;
    }
    const profile = String(snapshot?.owner_binding?.runtimeProfile || '');
    if (!isSafeName(profile)) return null;
    const ownerPath = path.join(
      path.dirname(realRuntimeDir),
      'state',
      'runtime',
      profile,
      'stack-owner.json',
    );
    if (fs.realpathSync(ownerPath) !== ownerPath) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    const repoRoot = fs.realpathSync(String(owner.repoRoot || ''));
    if (
      owner.repoRoot !== repoRoot ||
      fs.realpathSync(String(owner.runtimeDir || '')) !== realRuntimeDir ||
      owner.runtimeProfile !== profile ||
      snapshot.owner_binding.repoRootSha256 !== sha256Text(repoRoot) ||
      snapshot.owner_binding.runtimeDirSha256 !== sha256Text(realRuntimeDir)
    ) {
      return null;
    }
    const verifierIds = trustedQaVerifierRegistry(repoRoot);
    if (!verifierIds) return null;
    const ownerAuthority = {
      ownerBindingSha256: sha256Text(
        canonicalJsonDeep({
          contractVersion: 1,
          ownerUid: Number(runtimeStat.uid),
          repoRootSha256: sha256Text(owner.repoRoot),
          runtimeDirSha256: sha256Text(realRuntimeDir),
          runtimeProfile: owner.runtimeProfile,
        }),
      ),
      verifierIds,
    };
    if (!requireLocalKey) return ownerAuthority;

    const keyPath = path.join(realRuntimeDir, QA_RECEIPT_ATTESTATION_KEY_NAME);
    descriptor = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const keyStat = fs.fstatSync(descriptor);
    if (
      !keyStat.isFile() ||
      (keyStat.mode & 0o777) !== 0o600 ||
      keyStat.nlink !== 1 ||
      keyStat.uid !== runtimeStat.uid ||
      keyStat.size !== 32
    ) {
      return null;
    }
    const key = Buffer.alloc(33);
    if (fs.readSync(descriptor, key, 0, key.length, 0) !== 32) return null;
    const currentStat = fs.lstatSync(keyPath);
    if (
      !currentStat.isFile() ||
      currentStat.dev !== keyStat.dev ||
      currentStat.ino !== keyStat.ino ||
      currentStat.nlink !== 1
    ) {
      return null;
    }
    return {
      ...ownerAuthority,
      key: key.subarray(0, 32),
    };
  } catch (_error) {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_error) {
        // Closing an already invalidated descriptor cannot create a trusted authority.
      }
    }
  }
}

function qaReceiptAttestationValid(
  receipt: ValueRecord,
  authority: QaReceiptAuthority | null,
): boolean {
  if (
    !authority?.key ||
    !/^hmac-sha256:[0-9a-f]{64}$/.test(String(receipt.attestation || ''))
  ) {
    return false;
  }
  const { attestation, ...unsigned } = receipt;
  const expected = crypto
    .createHmac('sha256', authority.key)
    .update(canonicalJsonDeep(unsigned))
    .digest();
  const presented = Buffer.from(attestation.slice('hmac-sha256:'.length), 'hex');
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function externalQaReceiptEnvelopeValid(receipt: ValueRecord, caseId: string): boolean {
  return (
    receipt.attestationContractVersion === 1 &&
    receipt.attestationPurpose === 'viventium.qa.release.receipt.v1' &&
    Number.isSafeInteger(receipt.attestationSequence) &&
    receipt.attestationSequence > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,159}$/.test(String(receipt.publisherIdentity || '')) &&
    typeof receipt.publisherAttestation === 'string' &&
    Buffer.byteLength(receipt.publisherAttestation, 'utf8') <= 16 * 1024 &&
    receipt.publisherAttestation.startsWith('-----BEGIN SSH SIGNATURE-----\n') &&
    receipt.publisherAttestation.includes('-----END SSH SIGNATURE-----') &&
    !receipt.publisherAttestation.includes('\0') &&
    Array.isArray(receipt.producerAttestations) &&
    receipt.producerAttestations.length > 0 &&
    receipt.producerAttestations.length <= 64 &&
    receipt.producerAttestations.every(isRecord) &&
    Array.isArray(receipt.serviceAcknowledgements) &&
    receipt.serviceAcknowledgements.length <= 64 &&
    receipt.serviceAcknowledgements.every(isRecord) &&
    (QA_RECEIPT_SERVICE_ACK_CASES.has(caseId)
      ? receipt.serviceAcknowledgements.length > 0
      : receipt.serviceAcknowledgements.length === 0)
  );
}

function qaReceiptContractValid(
  snapshot: ValueRecord,
  runtimeDir: string,
  gates: unknown,
): boolean {
  const trustedGates = trustedInstalledGateInventory(snapshot, runtimeDir);
  if (!trustedGates) return false;
  const identity = snapshot.artifact_identity;
  if (!isRecord(identity)) return false;
  const candidateDigest = sha256Text(
    canonicalJsonDeep({
      readiness: identity.readiness,
      source: identity.source,
      nestedComponents: identity.nestedComponents,
      prebuiltHelper: identity.prebuiltHelper,
    }),
  );
  const artifactDigest = sha256Text(canonicalJsonDeep(identity.installed));
  let receiptsPayload: unknown = null;
  try {
    receiptsPayload = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, 'parallel-work-qa-case-receipts.json'), 'utf8'),
    );
  } catch (error: unknown) {
    receiptsPayload = isRecord(error) && error.code === 'ENOENT' ? null : {};
  }
  const receipts =
    isRecord(receiptsPayload) && Array.isArray(receiptsPayload.receipts)
      ? receiptsPayload.receipts
      : [];
  const expectedIds = new Set<string>(
    trustedGates
      .filter((gate) => gate.source.startsWith('qa/') && !gate.case_id.startsWith('CATALOG-'))
      .map((gate) => gate.case_id),
  );
  const localQa = snapshot.mode === 'local-qa';
  const authority = qaReceiptAttestationAuthority(snapshot, runtimeDir, {
    requireLocalKey: localQa,
  });
  const indexed = new Map<string, ValueRecord>();
  const nonceOwners = new Map<string, string>();
  const replayedCases = new Set<string>();
  let allVerified =
    isRecord(receiptsPayload) &&
    Object.keys(receiptsPayload).sort().join(',') === 'contractVersion,receipts' &&
    receiptsPayload.contractVersion === 1;
  for (const candidate of receipts) {
    const receipt = isRecord(candidate) ? candidate : {};
    const caseId = String(receipt.caseId || '');
    if (!expectedIds.has(caseId) || indexed.has(caseId)) {
      allVerified = false;
      continue;
    }
    indexed.set(caseId, receipt);
    const nonce = String(receipt?.receiptNonce || '');
    if (/^[0-9a-f]{32}$/.test(nonce)) {
      const previousCase = nonceOwners.get(nonce);
      if (previousCase) {
        replayedCases.add(previousCase);
        replayedCases.add(caseId);
      } else {
        nonceOwners.set(nonce, caseId);
      }
    }
  }
  if (indexed.size !== expectedIds.size) allVerified = false;
  const now = Date.now();
  const receiptValidity = new Map<string, boolean>();
  for (const caseId of expectedIds) {
    const receipt = indexed.get(caseId) || {};
    const runAt = Date.parse(String(receipt?.runAt || ''));
    const fields = isRecord(receipt) ? Object.keys(receipt).sort().join(',') : '';
    const expectedFields = [
      'artifactDigest',
      'candidateDigest',
      'caseId',
      'evidenceDigest',
      'runAt',
      'status',
      'surface',
      ...(localQa
        ? QA_RECEIPT_ATTESTATION_FIELDS
        : [
            ...QA_RECEIPT_ATTESTATION_FIELDS.filter((field) => field !== 'attestation'),
            ...QA_RECEIPT_EXTERNAL_ATTESTATION_FIELDS,
          ]),
      ...(QA_RECEIPT_SERVICE_ACK_CASES.has(caseId)
        ? ['serviceAckDigest', 'serviceAckSessionRef']
        : []),
    ]
      .sort()
      .join(',');
    const valid =
      fields === expectedFields &&
      receipt.caseId === caseId &&
      receipt.status === 'PASS' &&
      QA_RECEIPT_SURFACES.has(receipt.surface) &&
      (!QA_RECEIPT_CASE_SURFACES[caseId] || receipt.surface === QA_RECEIPT_CASE_SURFACES[caseId]) &&
      isSha256(receipt.evidenceDigest) &&
      (!QA_RECEIPT_SERVICE_ACK_CASES.has(caseId) ||
        (isSha256Ref(receipt.serviceAckDigest) &&
          /^qa_[0-9a-f]{24}$/.test(String(receipt.serviceAckSessionRef || '')))) &&
      receipt.candidateDigest === candidateDigest &&
      receipt.artifactDigest === artifactDigest &&
      authority !== null &&
      isSha256(receipt.ownerBindingSha256) &&
      receipt.ownerBindingSha256 === authority.ownerBindingSha256 &&
      /^[0-9a-f]{32}$/.test(String(receipt.receiptNonce || '')) &&
      !replayedCases.has(caseId) &&
      isSafeName(receipt.verifierId) &&
      receipt.verifierId === authority.verifierIds[caseId] &&
      isSha256(receipt.verifierManifestSha256) &&
      (localQa
        ? qaReceiptAttestationValid(receipt, authority)
        : externalQaReceiptEnvelopeValid(receipt, caseId)) &&
      Number.isFinite(runAt) &&
      runAt <= now + MAX_FUTURE_SKEW_MS &&
      now - runAt <= QA_RECEIPT_TTL_SECONDS * 1000;
    if (!valid) allVerified = false;
    receiptValidity.set(caseId, valid);
  }
  const expectedGates = trustedGates.map((gate) => ({
    case_id: gate.case_id,
    status: receiptValidity.get(gate.case_id)
      ? 'PASS'
      : gate.status === 'PASS'
        ? 'UNKNOWN'
        : gate.status,
    source: gate.source,
    detail: '[redacted]',
  }));
  if (!sameRecords(gates, expectedGates)) return false;
  const summary = snapshot.qa_receipt_summary;
  return (
    isRecord(summary) &&
    Object.keys(summary).sort().join(',') ===
      'artifactDigest,candidateDigest,contractVersion,maxAgeSeconds,receiptCount,receiptDigest,status' &&
    summary.contractVersion === 1 &&
    summary.status === (allVerified ? 'verified' : 'blocked') &&
    summary.receiptCount === receipts.length &&
    summary.receiptDigest === sha256Text(canonicalJsonDeep(receiptsPayload)) &&
    summary.candidateDigest === candidateDigest &&
    summary.artifactDigest === artifactDigest &&
    summary.maxAgeSeconds === QA_RECEIPT_TTL_SECONDS
  );
}

function nestedRevisionsHash(nested: unknown[]): string {
  return sha256Json(
    nested.map((component) => {
      const record = isRecord(component) ? component : {};
      return {
        name: record.name,
        pin: record.pin,
        revision: record.revision,
      };
    }),
  );
}

function artifactIdentityFacts(
  identity: unknown,
  promptBundleSha256 = '',
): ArtifactIdentityFacts {
  if (!isRecord(identity) || identity.contractVersion !== 1) {
    return {
      shapeValid: false,
      sourcePass: false,
      nestedPass: false,
      prebuiltPass: false,
      installedPass: false,
    };
  }
  const source = identity.source;
  const nested = identity.nestedComponents;
  const prebuilt = identity.prebuiltHelper;
  const installed = identity.installed;
  const readiness = identity.readiness;
  const nestedNames = Array.isArray(nested)
    ? nested.map((component: unknown) =>
        String(isRecord(component) ? component.name || '' : ''),
      )
    : [];
  const sourceShapeValid =
    isRecord(source) &&
    isGitRevision(source.revision) &&
    typeof source.clean === 'boolean' &&
    isSha256(source.worktreeHash) &&
    isSha256(source.componentsLockSha256);
  const nestedShapeValid =
    Array.isArray(nested) &&
    nested.length > 0 &&
    new Set(nestedNames).size === nested.length &&
    nestedNames.every((name) => isSafeName(name)) &&
    nestedNames.every((name, index) => index === 0 || nestedNames[index - 1] < name) &&
    nested.every(
      (component: unknown) =>
        isRecord(component) &&
        isSafeName(component.name) &&
        isGitRevision(component.pin) &&
        isGitRevision(component.revision) &&
        typeof component.clean === 'boolean' &&
        isSha256(component.worktreeHash),
    );
  const prebuiltShapeValid =
    isRecord(prebuilt) &&
    isSha256(prebuilt.sourceDeclaredSha256) &&
    isSha256(prebuilt.sourceMeasuredSha256) &&
    isSha256(prebuilt.binaryDeclaredSha256) &&
    isSha256(prebuilt.binaryMeasuredSha256) &&
    typeof prebuilt.binaryExecutable === 'boolean';
  const installedShapeValid =
    isRecord(installed) &&
    isGitRevision(installed.rootRevision) &&
    INSTALLED_ARTIFACT_HASH_KEYS.every((key) => isSha256(installed[key]));
  const readinessShapeValid =
    isRecord(readiness) && READINESS_IDENTITY_HASH_KEYS.every((key) => isSha256(readiness[key]));
  const shapeValid =
    readinessShapeValid &&
    sourceShapeValid &&
    nestedShapeValid &&
    prebuiltShapeValid &&
    installedShapeValid;
  const sourcePass =
    sourceShapeValid && source.clean === true && source.worktreeHash === EMPTY_SHA256;
  const nestedPass =
    nestedShapeValid &&
    nested.every(
      (component: unknown) =>
        isRecord(component) &&
        component.pin === component.revision &&
        component.clean === true &&
        component.worktreeHash === EMPTY_SHA256,
    );
  const prebuiltPass =
    prebuiltShapeValid &&
    prebuilt.sourceDeclaredSha256 === prebuilt.sourceMeasuredSha256 &&
    prebuilt.binaryDeclaredSha256 === prebuilt.binaryMeasuredSha256 &&
    prebuilt.binaryExecutable === true;
  const installedPass =
    shapeValid &&
    sourcePass &&
    nestedPass &&
    prebuiltPass &&
    installed.rootRevision === source.revision &&
    installed.componentsLockSha256 === source.componentsLockSha256 &&
    installed.nestedRevisionsHash === nestedRevisionsHash(nested) &&
    installed.prebuiltSourceSha256 === prebuilt.sourceMeasuredSha256 &&
    installed.prebuiltBinarySha256 === prebuilt.binaryMeasuredSha256 &&
    installed.promptBundleSha256 === promptBundleSha256;
  return { shapeValid, sourcePass, nestedPass, prebuiltPass, installedPass };
}

function sameRecords(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    canonicalJsonDeep(left) === canonicalJsonDeep(right)
  );
}

function validGateRecord(gate: unknown): boolean {
  return (
    isRecord(gate) &&
    isSafeName(gate.case_id) &&
    ['PASS', 'FAIL', 'BLOCKED', 'PARTIAL', 'NOT_RUN', 'UNKNOWN', 'MISSING'].includes(
      String(gate.status || ''),
    ) &&
    typeof gate.source === 'string' &&
    gate.source.length > 0 &&
    !path.isAbsolute(gate.source) &&
    !gate.source.split('/').includes('..') &&
    (gate.source === 'config.schema.yaml' || gate.source.startsWith('qa/')) &&
    gate.detail === '[redacted]'
  );
}

function validCheckRecord(
  check: unknown,
  allowedIds: readonly string[],
  allowedStatuses: readonly string[],
): boolean {
  return (
    isRecord(check) &&
    allowedIds.includes(String(check.check_id || '')) &&
    allowedStatuses.includes(String(check.status || '')) &&
    typeof check.reason === 'string' &&
    isSafeReason(check.reason) &&
    (check.status === 'PASS' ? check.reason === '' : check.reason.length > 0)
  );
}

function readinessFacts(snapshot: ValueRecord): ReadinessFactsResult {
  const facts = snapshot?.readiness_facts;
  const prompt = facts?.promptLayers;
  const storage = facts?.storagePressure;
  const promptNames = Array.isArray(prompt?.unknownLayerNames) ? prompt.unknownLayerNames : [];
  const layerNames = Array.isArray(prompt?.layerNames) ? prompt.layerNames : [];
  const promptShapeValid =
    isRecord(facts) &&
    facts.contractVersion === 1 &&
    isRecord(prompt) &&
    prompt.contractVersion === 1 &&
    prompt.producerScope === 'viventium.prompt_registry.v1' &&
    ['verified', 'unknown', 'mismatch'].includes(String(prompt.status || '')) &&
    Number.isInteger(prompt.unknownLayerCount) &&
    prompt.unknownLayerCount >= 0 &&
    prompt.unknownLayerCount <= 10_000 &&
    promptNames.length === prompt.unknownLayerCount &&
    promptNames.every((name: unknown) => isSafeName(name)) &&
    new Set(promptNames).size === promptNames.length &&
    Number.isInteger(prompt.promptCount) &&
    prompt.promptCount > 0 &&
    prompt.promptCount <= 100_000 &&
    Number.isInteger(prompt.layerCount) &&
    prompt.layerCount === layerNames.length &&
    layerNames.every((name: unknown) => isSafeName(name)) &&
    new Set(layerNames).size === layerNames.length &&
    isSha256(prompt.registryHash) &&
    (prompt.reason === undefined || isSafeReason(prompt.reason));
  const finiteStorageNumbers = [
    storage?.usedPercent,
    storage?.availableBytes,
    storage?.thresholdPercent,
    storage?.warningMarginPercent,
  ].every((value) => typeof value === 'number' && Number.isFinite(value));
  const storageShapeValid =
    isRecord(storage) &&
    storage.version === 1 &&
    ['healthy', 'warning', 'critical'].includes(String(storage.status || '')) &&
    finiteStorageNumbers &&
    storage.usedPercent >= 0 &&
    storage.usedPercent <= 100 &&
    Number.isInteger(storage.availableBytes) &&
    storage.availableBytes >= 0 &&
    storage.availableBytes <= Number.MAX_SAFE_INTEGER &&
    storage.thresholdPercent >= 0 &&
    storage.thresholdPercent <= 100 &&
    storage.thresholdPercent > 0 &&
    storage.warningMarginPercent > 0 &&
    storage.warningMarginPercent < storage.thresholdPercent &&
    (storage.reason === undefined || isSafeReason(storage.reason));
  const warningThreshold = storageShapeValid
    ? Math.max(0, storage.thresholdPercent - storage.warningMarginPercent)
    : 0;
  const measuredStorageStatus = !storageShapeValid
    ? 'invalid'
    : storage.usedPercent >= storage.thresholdPercent
      ? 'critical'
      : storage.usedPercent >= warningThreshold
        ? 'warning'
        : 'healthy';
  const storageConsistent = storageShapeValid && storage.status === measuredStorageStatus;
  return {
    shapeValid: promptShapeValid && storageShapeValid && storageConsistent,
    promptPass: promptShapeValid && prompt.status === 'verified' && prompt.unknownLayerCount === 0,
    storagePass: storageConsistent && storage.status === 'healthy',
    prompt: isRecord(prompt) ? prompt : {},
  };
}

function normalizedOwnerId(value: unknown): string {
  return String(value || '').trim();
}

function ownerIdFromUser(user?: OrchestrationModeUser): string {
  return normalizedOwnerId(user?.id || user?._id);
}

function configuredReleaseSnapshotPath(): string {
  const explicit = String(process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE || '').trim();
  if (explicit) return explicit;
  const runtimeDir = String(process.env.VIVENTIUM_RUNTIME_DIR || '').trim();
  if (runtimeDir) return path.join(runtimeDir, 'parallel-work-release-gate.json');
  const configPath = String(
    process.env.CONFIG_PATH || process.env.VIVENTIUM_LIBRECHAT_CONFIG_PATH || '',
  ).trim();
  return configPath ? path.join(path.dirname(configPath), 'parallel-work-release-gate.json') : '';
}

function configuredRuntimeDirectory(snapshotPath: string): string {
  const explicit = String(process.env.VIVENTIUM_RUNTIME_DIR || '').trim();
  const candidate = explicit || (snapshotPath ? path.dirname(snapshotPath) : '');
  if (!candidate) return '';
  try {
    const runtimeDir = fs.realpathSync(candidate);
    const snapshotDir = fs.realpathSync(path.dirname(snapshotPath));
    return snapshotDir === runtimeDir &&
      path.basename(snapshotPath) === 'parallel-work-release-gate.json'
      ? runtimeDir
      : '';
  } catch (_error) {
    return '';
  }
}

function normalizedProcessValue(value: unknown): string {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function commandExecutesPath(command: unknown, owner: ValueRecord): boolean {
  try {
    const repoRoot = fs.realpathSync(String(owner.repoRoot || ''));
    const contractPath = fs.realpathSync(
      path.join(repoRoot, 'scripts', 'viventium', 'runtime_owner_command_contract.json'),
    );
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    if (
      contract.contractVersion !== 1 ||
      !Array.isArray(contract.processWrappers) ||
      contract.processWrappers.length === 0 ||
      !contract.processWrappers.every((wrapper: unknown) => typeof wrapper === 'string') ||
      JSON.stringify(contract.detached?.argvTemplate) !==
        JSON.stringify(CANONICAL_DETACHED_OWNER_ARGV) ||
      contract.detached?.command !== 'start' ||
      contract.detached?.allowTrailingArguments !== false ||
      JSON.stringify(contract.attached?.argvTemplates) !==
        JSON.stringify(CANONICAL_ATTACHED_OWNER_ARGV) ||
      JSON.stringify(contract.attached?.commands) !== JSON.stringify(['start', 'launch']) ||
      contract.attached?.allowTrailingArguments !== false ||
      JSON.stringify(contract.processWrappers) !== JSON.stringify(CANONICAL_PROCESS_WRAPPERS)
    ) {
      return false;
    }
    const values: Record<string, unknown> = {
      ownerExecutablePath: owner.ownerExecutablePath,
      appSupportDir: owner.appSupportDir,
      configFile: owner.configFile,
      runtimeDir: owner.runtimeDir,
      componentsLockFile: owner.componentsLockFile,
      command: owner.command,
    };
    let templates: unknown[] = [];
    if (
      owner.ownerLaunchMode === 'detached' &&
      owner.command === contract.detached?.command &&
      owner.ownerProcessCwd === repoRoot
    ) {
      templates = [contract.detached?.argvTemplate];
    } else if (
      owner.ownerLaunchMode === 'attached' &&
      contract.attached?.commands?.includes(owner.command)
    ) {
      templates = contract.attached?.argvTemplates;
    }
    const validTemplates = templates.filter(
      (template): template is string[] =>
        Array.isArray(template) &&
        template.length > 0 &&
        template.every((token: unknown) => typeof token === 'string' && token.length > 0),
    );
    if (!templates.length || validTemplates.length !== templates.length) {
      return false;
    }
    const bases = validTemplates.map((template) =>
      template
        .map((token) =>
          token.replace(/\{([^}]+)\}/g, (_match: string, key: string) => {
            if (!Object.prototype.hasOwnProperty.call(values, key))
              throw new Error('unknown token');
            return String(values[key]);
          }),
        )
        .join(' '),
    );
    const normalized = normalizedProcessValue(command);
    return contract.processWrappers.some(
      (wrapper: unknown) =>
        typeof wrapper === 'string' && bases.some((base) => normalized === `${wrapper}${base}`),
    );
  } catch (_error) {
    return false;
  }
}

function canonicalOwnerProcessProof(ownerPath: string, repoRoot: string): boolean {
  try {
    const gateScript = fs.realpathSync(
      path.join(repoRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py'),
    );
    if (
      gateScript !== path.join(repoRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py')
    ) {
      return false;
    }
    execFileSync(
      trustedSystemPython(),
      [
        '-I',
        '-B',
        '-c',
        TRUSTED_PYTHON_GATE_RUNNER,
        gateScript,
        '--validate-owner-state',
        ownerPath,
      ],
      {
        encoding: 'utf8',
        env: TRUSTED_PYTHON_ENVIRONMENT,
        maxBuffer: 256 * 1024,
        timeout: 10_000,
        stdio: 'pipe',
      },
    );
    return true;
  } catch (_error) {
    return false;
  }
}

function validSnapshotFreshness(projection: unknown): boolean {
  if (!isRecord(projection) || projection.maxAgeSeconds !== SNAPSHOT_TTL_SECONDS) return false;
  const generatedAt = Date.parse(String(projection.generatedAt || ''));
  const expiresAt = Date.parse(String(projection.expiresAt || ''));
  const now = Date.now();
  return (
    Number.isFinite(generatedAt) &&
    Number.isFinite(expiresAt) &&
    generatedAt <= now + MAX_FUTURE_SKEW_MS &&
    expiresAt > now &&
    expiresAt - generatedAt === SNAPSHOT_TTL_SECONDS * 1000
  );
}

function liveRuntimeOwnerMatches(snapshot: ValueRecord, runtimeDir: string): boolean {
  const projection = snapshot?.owner_binding;
  if (
    !isRecord(projection) ||
    projection.contractVersion !== 1 ||
    !isSafeName(projection.runtimeProfile) ||
    !['start', 'launch'].includes(String(projection.command || '')) ||
    !/^[0-9]+$/.test(String(projection.ownerPid || '')) ||
    Number(projection.ownerPid) <= 1 ||
    !normalizedProcessValue(projection.ownerProcessStartedAt) ||
    !['attached', 'detached'].includes(String(projection.ownerLaunchMode || '')) ||
    !validSnapshotFreshness(projection)
  ) {
    return false;
  }
  const hashKeys = [
    'ownerBindingSha256',
    'ownerStateSha256',
    'repoRootSha256',
    'runtimeDirSha256',
    'configFileSha256',
    'componentsLockFileSha256',
    'ownerExecutablePathSha256',
    'ownerProcessCwdSha256',
    'ownerProcessCommandSha256',
  ];
  if (!hashKeys.every((key) => isSha256(projection[key]))) return false;

  try {
    const profile = String(projection.runtimeProfile);
    const ownerPath = path.join(
      path.dirname(runtimeDir),
      'state',
      'runtime',
      profile,
      'stack-owner.json',
    );
    const exactOwnerPath = fs.realpathSync(ownerPath);
    const ownerText = fs.readFileSync(exactOwnerPath, 'utf8');
    const owner = JSON.parse(ownerText);
    const repoRoot = fs.realpathSync(String(owner.repoRoot || ''));
    const appSupportDir = fs.realpathSync(String(owner.appSupportDir || ''));
    const configFile = fs.realpathSync(String(owner.configFile || ''));
    const ownerRuntimeDir = fs.realpathSync(String(owner.runtimeDir || ''));
    const componentsLockFile = fs.realpathSync(String(owner.componentsLockFile || ''));
    const executable = fs.realpathSync(String(owner.ownerExecutablePath || ''));
    const ownerCwd = fs.realpathSync(String(owner.ownerProcessCwd || ''));
    const expectedExecutable = fs.realpathSync(path.join(repoRoot, 'bin', 'viventium'));
    const pid = Number(owner.ownerPid);
    const startedAt = normalizedProcessValue(
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }),
    );
    const command = normalizedProcessValue(
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }),
    );
    const cwdOutput = execFileSync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      {
        encoding: 'utf8',
      },
    );
    const cwdLines = cwdOutput
      .split('\n')
      .filter((line: string) => line.startsWith('n') && line.length > 1);
    if (cwdLines.length !== 1) return false;
    const liveCwd = fs.realpathSync(cwdLines[0].slice(1));
    const ownerStartedAt = normalizedProcessValue(owner.ownerProcessStartedAt);
    const ownerCommand = normalizedProcessValue(owner.ownerProcessCommand);
    const binding = {
      contractVersion: owner.contractVersion,
      repoRoot: owner.repoRoot,
      appSupportDir: owner.appSupportDir,
      configFile: owner.configFile,
      runtimeDir: owner.runtimeDir,
      componentsLockFile: owner.componentsLockFile,
      runtimeProfile: owner.runtimeProfile,
      command: owner.command,
      ownerLaunchMode: owner.ownerLaunchMode,
      ownerPid: owner.ownerPid,
      ownerExecutablePath: owner.ownerExecutablePath,
      ownerProcessCwd: owner.ownerProcessCwd,
      ownerProcessStartedAt: owner.ownerProcessStartedAt,
      ownerProcessCommand: owner.ownerProcessCommand,
    };
    const commandExecutesOwner = commandExecutesPath(command, {
      ...owner,
      ownerExecutablePath: executable,
      appSupportDir,
      configFile,
      runtimeDir: ownerRuntimeDir,
      componentsLockFile,
    });
    return (
      owner.contractVersion === 1 &&
      owner.repoRoot === repoRoot &&
      owner.appSupportDir === appSupportDir &&
      owner.configFile === configFile &&
      owner.runtimeDir === ownerRuntimeDir &&
      owner.componentsLockFile === componentsLockFile &&
      owner.ownerExecutablePath === executable &&
      owner.ownerProcessCwd === ownerCwd &&
      ownerRuntimeDir === runtimeDir &&
      appSupportDir === path.dirname(runtimeDir) &&
      path.dirname(configFile) === appSupportDir &&
      ownerRuntimeDir === path.join(appSupportDir, 'runtime') &&
      componentsLockFile === path.join(repoRoot, 'components.lock.json') &&
      exactOwnerPath ===
        path.join(appSupportDir, 'state', 'runtime', profile, 'stack-owner.json') &&
      owner.runtimeProfile === profile &&
      owner.command === projection.command &&
      owner.ownerLaunchMode === projection.ownerLaunchMode &&
      String(owner.ownerPid) === String(projection.ownerPid) &&
      executable === expectedExecutable &&
      startedAt === ownerStartedAt &&
      startedAt === normalizedProcessValue(projection.ownerProcessStartedAt) &&
      command === ownerCommand &&
      liveCwd === ownerCwd &&
      commandExecutesOwner &&
      canonicalOwnerProcessProof(exactOwnerPath, repoRoot) &&
      sha256Text(canonicalJson(binding)) === owner.ownerBindingSha256 &&
      projection.ownerBindingSha256 === owner.ownerBindingSha256 &&
      projection.ownerStateSha256 === sha256Text(ownerText) &&
      projection.repoRootSha256 === sha256Text(repoRoot) &&
      projection.runtimeDirSha256 === sha256Text(runtimeDir) &&
      projection.configFileSha256 === sha256Text(configFile) &&
      projection.componentsLockFileSha256 === sha256Text(componentsLockFile) &&
      projection.ownerExecutablePathSha256 === sha256Text(executable) &&
      projection.ownerProcessCwdSha256 === sha256Text(ownerCwd) &&
      projection.ownerProcessCommandSha256 === sha256Text(ownerCommand)
    );
  } catch (_error) {
    return false;
  }
}

function persistedLocalQaRequest(runtimeDir: string): boolean {
  if (!runtimeDir) return false;
  try {
    const requestPath = path.join(runtimeDir, 'parallel-work-local-qa-request.json');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    return (
      isRecord(request) &&
      Object.keys(request).sort().join(',') === 'contractVersion,mode,requested' &&
      request.contractVersion === 1 &&
      request.mode === 'local-qa' &&
      request.requested === true
    );
  } catch (_error) {
    return false;
  }
}

function localQaOverrideRequested(snapshot: ValueRecord | null = null, runtimeDir = ''): boolean {
  return (
    snapshot?.local_qa_override === true ||
    persistedLocalQaRequest(runtimeDir) ||
    process.env.VIVENTIUM_PARALLEL_WORK_LOCAL_QA_OVERRIDE === 'true'
  );
}

function runCanonicalSnapshotAction(
  snapshot: ValueRecord,
  runtimeDir: string,
  snapshotPath: string,
  action: string,
): boolean {
  try {
    const profile = String(snapshot?.owner_binding?.runtimeProfile || '');
    if (!isSafeName(profile)) return false;
    const ownerPath = fs.realpathSync(
      path.join(path.dirname(runtimeDir), 'state', 'runtime', profile, 'stack-owner.json'),
    );
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    const repoRoot = fs.realpathSync(String(owner.repoRoot || ''));
    const gateScript = fs.realpathSync(
      path.join(repoRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py'),
    );
    const exactSnapshot = fs.realpathSync(snapshotPath);
    if (
      exactSnapshot !== path.join(runtimeDir, 'parallel-work-release-gate.json') ||
      gateScript !== path.join(repoRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py')
    ) {
      return false;
    }
    execFileSync(
      trustedSystemPython(),
      ['-I', '-B', '-c', TRUSTED_PYTHON_GATE_RUNNER, gateScript, action, exactSnapshot],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: TRUSTED_PYTHON_ENVIRONMENT,
        maxBuffer: 256 * 1024,
        stdio: 'ignore',
        timeout: 30_000,
      },
    );
    return true;
  } catch (_error) {
    return false;
  }
}

function shouldRenewLocalQaSnapshot(snapshot: ValueRecord): boolean {
  const expiresAt = Date.parse(String(snapshot?.owner_binding?.expiresAt || ''));
  const remaining = expiresAt - Date.now();
  return (
    snapshot?.mode === 'local-qa' &&
    snapshot?.local_qa_override === true &&
    Number.isFinite(expiresAt) &&
    remaining > 0 &&
    remaining <= SNAPSHOT_RENEWAL_WINDOW_MS
  );
}

function validatedReleaseSnapshot(
  snapshot: unknown,
  runtimeDir: string,
): ValidatedReleaseSnapshot | null {
  if (!isRecord(snapshot) || snapshot.contract_version !== 1) return null;
  if (!validSnapshotFreshness(snapshot.owner_binding)) return null;
  const gates = snapshot.gates;
  const openGates = snapshot.open_gates;
  const checks = snapshot?.readiness_checks;
  const blockingChecks = snapshot?.blocking_checks;
  const artifactChecks = snapshot?.artifact_checks;
  const blockingArtifactChecks = snapshot?.blocking_artifact_checks;
  const gateIds = Array.isArray(gates) ? gates.map((gate) => String(gate?.case_id || '')) : [];
  const readinessCheckIds = Array.isArray(checks)
    ? checks.map((check) => String(check?.check_id || ''))
    : [];
  const artifactCheckIds = Array.isArray(artifactChecks)
    ? artifactChecks.map((check) => String(check?.check_id || ''))
    : [];
  if (
    !['default', 'release', 'local-qa'].includes(String(snapshot.mode || '')) ||
    typeof snapshot.release_ready !== 'boolean' ||
    typeof snapshot.exposure_allowed !== 'boolean' ||
    typeof snapshot.local_qa_override !== 'boolean' ||
    typeof snapshot.source_defaults_dark !== 'boolean' ||
    !Number.isInteger(snapshot.gate_count) ||
    !Number.isInteger(snapshot.open_gate_count) ||
    !Array.isArray(gates) ||
    gates.length === 0 ||
    snapshot.gate_count !== gates.length ||
    new Set(gateIds).size !== gates.length ||
    !gates.every(validGateRecord) ||
    !Array.isArray(openGates) ||
    snapshot.open_gate_count !== openGates.length ||
    !sameRecords(
      openGates,
      gates.filter((gate) => gate.status !== 'PASS'),
    ) ||
    !Array.isArray(checks) ||
    checks.length !== REQUIRED_READINESS_CHECK_IDS.length
  ) {
    return null;
  }
  if (
    new Set(readinessCheckIds).size !== REQUIRED_READINESS_CHECK_IDS.length ||
    !REQUIRED_READINESS_CHECK_IDS.every((checkId) => readinessCheckIds.includes(checkId)) ||
    !checks.every((check) =>
      validCheckRecord(check, REQUIRED_READINESS_CHECK_IDS, ['PASS', 'FAIL', 'UNKNOWN']),
    ) ||
    !sameRecords(
      blockingChecks,
      checks.filter((check) => check.status !== 'PASS'),
    ) ||
    !Array.isArray(artifactChecks) ||
    artifactChecks.length !== REQUIRED_ARTIFACT_CHECK_IDS.length ||
    new Set(artifactCheckIds).size !== REQUIRED_ARTIFACT_CHECK_IDS.length ||
    !REQUIRED_ARTIFACT_CHECK_IDS.every((checkId) => artifactCheckIds.includes(checkId)) ||
    !artifactChecks.every((check) =>
      validCheckRecord(check, REQUIRED_ARTIFACT_CHECK_IDS, ['PASS', 'FAIL']),
    ) ||
    !sameRecords(
      blockingArtifactChecks,
      artifactChecks.filter((check) => check.status !== 'PASS'),
    )
  ) {
    return null;
  }

  const readiness = readinessFacts(snapshot);
  const promptCheck = checks.find((check) => check.check_id === 'PROMPT-LAYERS');
  const storageCheck = checks.find((check) => check.check_id === 'STORAGE-PRESSURE');
  const promptFactsPass = readiness.promptPass;
  const promptFactsFailReason = isSafeReason(readiness.prompt?.reason)
    ? readiness.prompt.reason || 'prompt_layers_unknown'
    : 'prompt_layers_unknown';
  const promptCheckConsistent = promptFactsPass
    ? (promptCheck.status === 'PASS' && promptCheck.reason === '') ||
      (promptCheck.status === 'FAIL' && promptCheck.reason === 'prompt_layer_hash_mismatch')
    : promptCheck.status === 'FAIL' && promptCheck.reason === promptFactsFailReason;
  if (
    !readiness.shapeValid ||
    !promptCheckConsistent ||
    storageCheck.status !== (readiness.storagePass ? 'PASS' : 'FAIL') ||
    (storageCheck.status === 'FAIL' && storageCheck.reason !== 'storage_pressure')
  ) {
    return null;
  }

  const artifact = artifactIdentityFacts(
    snapshot.artifact_identity,
    sha256File(path.join(runtimeDir, 'prompt-bundle.json')),
  );
  const artifactExpected: Record<string, { pass: boolean; reasons: string[] }> = {
    'SOURCE-IDENTITY': {
      pass: artifact.sourcePass,
      reasons: ['source_dirty', 'source_identity_mismatch'],
    },
    'NESTED-PINS': {
      pass: artifact.nestedPass,
      reasons: ['nested_dirty', 'nested_pin_mismatch'],
    },
    'PREBUILT-IDENTITY': {
      pass: artifact.prebuiltPass,
      reasons: ['prebuilt_identity_mismatch'],
    },
    'INSTALLED-ARTIFACT': {
      pass: artifact.installedPass,
      reasons: [
        'installed_root_missing',
        'installed_root_invalid',
        'installed_runtime_not_active',
        'installed_candidate_dirty',
        'installed_artifact_mismatch',
      ],
    },
  };
  if (
    !artifact.shapeValid ||
    !artifactChecks.every((check) => {
      const expected = artifactExpected[check.check_id];
      return expected.pass
        ? check.status === 'PASS' && check.reason === ''
        : check.status === 'FAIL' && expected.reasons.includes(check.reason);
    })
  ) {
    return null;
  }
  if (!qaReceiptContractValid(snapshot, runtimeDir, gates)) return null;

  const gatesPass = openGates.length === 0;
  const readinessPass = checks.every((check) => check.status === 'PASS');
  const artifactsPass = artifactChecks.every((check) => check.status === 'PASS');
  const integrityPass = readinessPass && artifactsPass && snapshot.source_defaults_dark === true;
  const candidatePass =
    gatesPass && integrityPass && snapshot.qa_receipt_summary.status === 'verified';
  const localQaShapePass = snapshot.source_defaults_dark === true;
  const isLocalQa = snapshot.mode === 'local-qa';
  const expectedReleaseReady = candidatePass && !isLocalQa;
  const expectedExposureAllowed = isLocalQa ? localQaShapePass : expectedReleaseReady;
  const expectedLabel = isLocalQa
    ? 'PRE-GATE / NOT READY'
    : expectedReleaseReady
      ? 'READY'
      : 'NOT READY';
  if (
    snapshot.local_qa_override !== isLocalQa ||
    snapshot.release_ready !== expectedReleaseReady ||
    snapshot.exposure_allowed !== expectedExposureAllowed ||
    snapshot.label !== expectedLabel
  ) {
    return null;
  }
  const typedChecks = checks.filter(isRecord);
  const typedArtifactChecks = artifactChecks.filter(isRecord);
  if (typedChecks.length !== checks.length || typedArtifactChecks.length !== artifactChecks.length) {
    return null;
  }
  return {
    snapshot,
    checks: typedChecks,
    artifactChecks: typedArtifactChecks,
    candidatePass,
    localQaShapePass,
  };
}

export function parallelWorkReleaseGateSnapshot(): ParallelWorkReleaseGate {
  const snapshotPath = configuredReleaseSnapshotPath();
  const runtimeDir = configuredRuntimeDirectory(snapshotPath);
  let snapshot: ValueRecord | null = null;
  try {
    snapshot = snapshotPath ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
  } catch (_error) {
    snapshot = null;
  }
  let validated = runtimeDir ? validatedReleaseSnapshot(snapshot, runtimeDir) : null;
  if (!validated || !snapshot) {
    return permitReleaseGateReuse({
      available: false,
      releaseReady: false,
      label: localQaOverrideRequested(snapshot, runtimeDir) ? 'PRE-GATE / NOT READY' : 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  }
  if (!liveRuntimeOwnerMatches(snapshot, runtimeDir)) {
    return permitReleaseGateReuse({
      available: false,
      releaseReady: false,
      label: snapshot.local_qa_override === true ? 'PRE-GATE / NOT READY' : 'NOT READY',
      blockers: ['release_owner_unavailable'],
    });
  }
  if (!runCanonicalSnapshotAction(snapshot, runtimeDir, snapshotPath, '--validate-snapshot')) {
    return permitReleaseGateReuse({
      available: false,
      releaseReady: false,
      label: snapshot.local_qa_override === true ? 'PRE-GATE / NOT READY' : 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  }
  if (shouldRenewLocalQaSnapshot(snapshot)) {
    if (
      !runCanonicalSnapshotAction(snapshot, runtimeDir, snapshotPath, '--renew-local-qa-snapshot')
    ) {
      return permitReleaseGateReuse({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
    }
    try {
      snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (_error) {
      snapshot = null;
    }
    validated = validatedReleaseSnapshot(snapshot, runtimeDir);
    if (
      !validated ||
      !liveRuntimeOwnerMatches(validated.snapshot, runtimeDir) ||
      !runCanonicalSnapshotAction(
        validated.snapshot,
        runtimeDir,
        snapshotPath,
        '--validate-snapshot',
      )
    ) {
      return permitReleaseGateReuse({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
    }
  }
  const { checks, artifactChecks, candidatePass, localQaShapePass } = validated;
  const releaseSnapshot = validated.snapshot;
  const blockers = [
    ...releaseSnapshot.open_gates
      .map((gate: unknown) => String(isRecord(gate) ? gate.case_id || '' : '').trim())
      .filter(Boolean),
    ...checks
      .filter((check) => String(check.status || '').toUpperCase() !== 'PASS')
      .map((check) => String(check.check_id || '').trim())
      .filter(Boolean),
    ...artifactChecks
      .filter((check) => String(check.status || '').toUpperCase() !== 'PASS')
      .map((check) => String(check.check_id || '').trim())
      .filter(Boolean),
  ];
  if (releaseSnapshot.source_defaults_dark !== true) blockers.push('source_defaults_not_dark');
  if (releaseSnapshot.local_qa_override === true) blockers.push('local_qa_override_active');
  if (releaseSnapshot.exposure_allowed !== true) blockers.push('release_exposure_disabled');
  if (releaseSnapshot.release_ready !== true && releaseSnapshot.local_qa_override !== true) {
    blockers.push('release_gate_not_ready');
  }
  const available =
    (releaseSnapshot.local_qa_override === true ? localQaShapePass : candidatePass) &&
    releaseSnapshot.exposure_allowed === true &&
    (releaseSnapshot.release_ready === true || releaseSnapshot.local_qa_override === true);
  const releaseReady =
    available &&
    releaseSnapshot.release_ready === true &&
    releaseSnapshot.local_qa_override !== true;
  return permitReleaseGateReuse({
    available,
    releaseReady,
    label:
      releaseSnapshot.local_qa_override === true
        ? 'PRE-GATE / NOT READY'
        : releaseReady
          ? 'READY'
          : 'NOT READY',
    blockers: releaseReady
      ? []
      : [...new Set(blockers.length ? blockers : ['release_gate_not_ready'])],
  });
}

function unavailableWorkerReleaseGate(): ParallelWorkReleaseGate {
  return permitReleaseGateReuse({
    available: false,
    releaseReady: false,
    label: 'NOT READY',
    blockers: ['release_snapshot_unavailable'],
  });
}

function normalizedWorkerReleaseGate(value: unknown): ParallelWorkReleaseGate | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'available,blockers,label,releaseReady' ||
    typeof value.available !== 'boolean' ||
    typeof value.releaseReady !== 'boolean' ||
    !['READY', 'NOT READY', 'PRE-GATE / NOT READY'].includes(value.label) ||
    !Array.isArray(value.blockers) ||
    value.blockers.some(
      (blocker: unknown) =>
        typeof blocker !== 'string' || !blocker.trim() || blocker.length > 160,
    ) ||
    new Set(value.blockers).size !== value.blockers.length ||
    !(
      (value.available &&
        value.releaseReady &&
        value.label === 'READY' &&
        value.blockers.length === 0) ||
      (value.available &&
        !value.releaseReady &&
        value.label === 'PRE-GATE / NOT READY' &&
        value.blockers.length > 0) ||
      (!value.available &&
        !value.releaseReady &&
        value.label !== 'READY' &&
        value.blockers.length > 0)
    )
  ) {
    return null;
  }
  return {
    available: value.available,
    releaseReady: value.releaseReady,
    label: value.label,
    blockers: [...value.blockers],
  };
}

export function parallelWorkReleaseGateSnapshotAsync(): Promise<ParallelWorkReleaseGate> {
  return new Promise((resolve) => {
    let worker: WorkerThread;
    try {
      const env = Object.fromEntries(
        RELEASE_GATE_WORKER_ENVIRONMENT_KEYS.filter((key) => process.env[key] != null).map(
          (key) => [key, String(process.env[key])],
        ),
      );
      worker = new Worker(__filename, {
        env,
        workerData: { action: RELEASE_GATE_WORKER_ACTION },
      });
    } catch (_error) {
      resolve(unavailableWorkerReleaseGate());
      return;
    }

    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: ParallelWorkReleaseGate): void => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      worker.removeAllListeners();
      if (worker.threadId !== -1) void worker.terminate().catch(() => {});
      resolve(value);
    };
    const failClosed = () => finish(unavailableWorkerReleaseGate());

    worker.once('message', (value: unknown) => {
      const normalized = normalizedWorkerReleaseGate(value);
      finish(normalized ? permitReleaseGateReuse(normalized) : unavailableWorkerReleaseGate());
    });
    worker.once('error', failClosed);
    worker.once('exit', (code: number) => {
      if (code !== 0 || !settled) failClosed();
    });
    watchdog = setTimeout(failClosed, RELEASE_GATE_WORKER_TIMEOUT_MS);
    watchdog.unref();
  });
}

function rawReleaseSnapshotExposureFingerprint(): string {
  const snapshotPath = configuredReleaseSnapshotPath();
  const runtimeDir = configuredRuntimeDirectory(snapshotPath);
  if (!runtimeDir) return '';

  let descriptor: number | undefined;
  try {
    const pathStat = fs.lstatSync(snapshotPath);
    if (
      !pathStat.isFile() ||
      pathStat.size <= 0 ||
      pathStat.size > RELEASE_GATE_FAST_READ_MAX_BYTES
    ) {
      return '';
    }
    descriptor = fs.openSync(snapshotPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const fileStat = fs.fstatSync(descriptor);
    if (
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > RELEASE_GATE_FAST_READ_MAX_BYTES
    ) {
      return '';
    }
    const contents = Buffer.alloc(fileStat.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) return '';
      offset += bytesRead;
    }
    const snapshot = JSON.parse(contents.toString('utf8'));
    const projection = snapshot?.owner_binding;
    if (
      !isRecord(snapshot) ||
      snapshot.exposure_allowed !== true ||
      (snapshot.release_ready !== true && snapshot.local_qa_override !== true) ||
      !isRecord(projection) ||
      !validSnapshotFreshness(projection) ||
      !isSafeName(projection.runtimeProfile) ||
      !isSha256(projection.ownerStateSha256) ||
      !/^[0-9]+$/.test(String(projection.ownerPid || '')) ||
      Number(projection.ownerPid) <= 1
    ) {
      return '';
    }
    const ownerPath = path.join(
      path.dirname(runtimeDir),
      'state',
      'runtime',
      String(projection.runtimeProfile),
      'stack-owner.json',
    );
    const exactOwnerPath = fs.realpathSync(ownerPath);
    if (exactOwnerPath !== ownerPath) return '';
    const ownerStat = fs.lstatSync(exactOwnerPath);
    if (
      !ownerStat.isFile() ||
      ownerStat.size <= 0 ||
      ownerStat.size > RELEASE_GATE_FAST_READ_MAX_BYTES
    ) {
      return '';
    }
    const ownerText = fs.readFileSync(exactOwnerPath);
    if (sha256Text(ownerText) !== projection.ownerStateSha256) return '';
    process.kill(Number(projection.ownerPid), 0);
    return sha256Text(Buffer.concat([contents, Buffer.from([0]), ownerText]));
  } catch (_error) {
    return '';
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function refreshDeploymentAvailability(fingerprint: string): Promise<boolean> {
  if (
    deploymentAvailabilityInFlight?.fingerprint === fingerprint &&
    deploymentAvailabilityInFlight.promise
  ) {
    return deploymentAvailabilityInFlight.promise;
  }
  const promise = parallelWorkReleaseGateSnapshotAsync()
    .then((releaseGate) => {
      if (rawReleaseSnapshotExposureFingerprint() !== fingerprint) {
        deploymentAvailabilityCache = null;
        return false;
      }
      deploymentAvailabilityCache = {
        fingerprint,
        available: releaseGate.available === true,
        checkedAtMs: Date.now(),
      };
      return deploymentAvailabilityCache.available;
    })
    .catch(() => {
      deploymentAvailabilityCache = null;
      return false;
    })
    .finally(() => {
      if (deploymentAvailabilityInFlight?.promise === promise) {
        deploymentAvailabilityInFlight = null;
      }
    });
  deploymentAvailabilityInFlight = { fingerprint, promise };
  return promise;
}

function prewarmDeploymentAvailability(): void {
  const fingerprint = rawReleaseSnapshotExposureFingerprint();
  if (!fingerprint) {
    deploymentAvailabilityCache = null;
    return;
  }
  if (
    deploymentAvailabilityCache?.fingerprint === fingerprint &&
    Date.now() - deploymentAvailabilityCache.checkedAtMs < DEPLOYMENT_AVAILABILITY_REFRESH_MS
  ) {
    return;
  }
  void refreshDeploymentAvailability(fingerprint);
}

/* === VIVENTIUM START ===
 * Feature: Installed runtime trace binding.
 * Purpose: Let production producers bind evidence to the same validated source/component/prebuilt
 * candidate, installed artifact, and live runtime owner as the release gate. No caller supplies
 * these facts and no raw machine path or process identity leaves this module.
 * === VIVENTIUM END === */
export function orchestrationRuntimeTraceBinding(): OrchestrationRuntimeTraceBinding | null {
  const snapshotPath = configuredReleaseSnapshotPath();
  const runtimeDir = configuredRuntimeDirectory(snapshotPath);
  if (!runtimeDir) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (_error) {
    return null;
  }
  if (
    !validatedReleaseSnapshot(snapshot, runtimeDir) ||
    !liveRuntimeOwnerMatches(snapshot, runtimeDir)
  ) {
    return null;
  }
  const identity = snapshot.artifact_identity;
  const candidateDigest = `sha256:${sha256Text(
    canonicalJsonDeep({
      readiness: identity.readiness,
      source: identity.source,
      nestedComponents: identity.nestedComponents,
      prebuiltHelper: identity.prebuiltHelper,
    }),
  )}`;
  const installedArtifactDigest = `sha256:${sha256Text(canonicalJsonDeep(identity.installed))}`;
  const runtimeOwnerBindingHash = `sha256:${String(
    snapshot.owner_binding?.ownerBindingSha256 || '',
  )}`;
  if (
    !isSha256Ref(candidateDigest) ||
    !isSha256Ref(installedArtifactDigest) ||
    !isSha256Ref(runtimeOwnerBindingHash)
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: 1,
    candidateDigest,
    installedArtifactDigest,
    runtimeOwnerBindingHash,
  });
}

function permitReleaseGateReuse(value: ParallelWorkReleaseGate): ParallelWorkReleaseGate {
  const result = Object.freeze(value);
  releaseGateReusePermits.set(result, result);
  return result;
}

function consumeReleaseGateReuse(value: unknown): ParallelWorkReleaseGate | null {
  if (!value || typeof value !== 'object') return null;
  const result = releaseGateReusePermits.get(value) || null;
  releaseGateReusePermits.delete(value);
  return result;
}

function permitOwnerClaimReuse(
  value: ParallelWorkClaimState,
  ownerId: string,
): ParallelWorkClaimState {
  const result = Object.freeze(value);
  ownerClaimReusePermits.set(result, ownerId);
  return result;
}

export function consumeTrustedParallelWorkClaimState(value: unknown, ownerId?: unknown): boolean {
  const normalized = normalizedOwnerId(ownerId);
  if (!value || typeof value !== 'object' || ownerClaimReusePermits.get(value) !== normalized) {
    return false;
  }
  ownerClaimReusePermits.delete(value);
  return true;
}

export function parallelWorkClaimState(
  ownerId?: unknown,
  reusableReleaseGate?: unknown,
): ParallelWorkClaimState {
  const normalized = normalizedOwnerId(ownerId);
  const releaseGate =
    consumeReleaseGateReuse(reusableReleaseGate) || parallelWorkReleaseGateSnapshot();
  if (!normalized) {
    return permitOwnerClaimReuse(
      {
        available: false,
        label: releaseGate.label,
        blockers: [...releaseGate.blockers, 'owner_required'],
      },
      normalized,
    );
  }
  const operational = runtimeDependencies().orchestrationReadinessSnapshot({
    ownerId: normalized,
  });
  const operationalBlocker =
    operational.available === true
      ? []
      : [String(operational.reason || operational.status || 'operational_readiness_unavailable')];
  return permitOwnerClaimReuse(
    {
      available: operational.available === true && releaseGate.available === true,
      label: releaseGate.label,
      blockers: [...new Set([...releaseGate.blockers, ...operationalBlocker].filter(Boolean))],
    },
    normalized,
  );
}

export async function parallelWorkClaimStateAsync(ownerId?: unknown): Promise<ParallelWorkClaimState> {
  const releaseGate = await parallelWorkReleaseGateSnapshotAsync();
  return parallelWorkClaimState(ownerId, releaseGate);
}

export function parallelWorkAvailable(ownerId?: unknown): boolean {
  return parallelWorkClaimState(ownerId).available;
}

export async function parallelWorkAvailableAsync(ownerId?: unknown): Promise<boolean> {
  return (await parallelWorkClaimStateAsync(ownerId)).available;
}

export function parallelWorkDeploymentAvailable(): boolean {
  return (
    runtimeDependencies().orchestrationDeploymentReadinessSnapshot().available === true &&
    parallelWorkReleaseGateSnapshot().available === true
  );
}

export async function parallelWorkDeploymentAvailableAsync(): Promise<boolean> {
  if (runtimeDependencies().orchestrationDeploymentReadinessSnapshot().available !== true) {
    deploymentAvailabilityCache = null;
    return false;
  }
  // Raw state can prove that exposure is impossible, but only the worker may authorize it.
  const fingerprint = rawReleaseSnapshotExposureFingerprint();
  if (!fingerprint) {
    deploymentAvailabilityCache = null;
    return false;
  }
  if (deploymentAvailabilityCache?.fingerprint === fingerprint) {
    if (
      Date.now() - deploymentAvailabilityCache.checkedAtMs >=
      DEPLOYMENT_AVAILABILITY_REFRESH_MS
    ) {
      void refreshDeploymentAvailability(fingerprint);
    }
    return deploymentAvailabilityCache.available === true;
  }
  return refreshDeploymentAvailability(fingerprint);
}

export function configuredOrchestrationDefault(): 'parallel' | 'focused' {
  return process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE === 'parallel' ? 'parallel' : 'focused';
}

export function effectiveOrchestrationMode(
  user?: OrchestrationModeUser,
  { available }: { available?: boolean } = {},
): 'parallel' | 'focused' {
  const ownerAvailable =
    typeof available === 'boolean' ? available : parallelWorkAvailable(ownerIdFromUser(user));
  if (!ownerAvailable) return 'focused';
  const explicit = user?.personalization?.orchestration_mode;
  if (explicit === 'parallel' || explicit === 'focused') return explicit;
  return configuredOrchestrationDefault();
}

if (isMainThread && process.env.NODE_ENV !== 'test') {
  const prewarm = setTimeout(prewarmDeploymentAvailability, 0);
  prewarm.unref?.();
  const refresh = setInterval(prewarmDeploymentAvailability, DEPLOYMENT_AVAILABILITY_REFRESH_MS);
  refresh.unref?.();
}

if (!isMainThread && parentPort && workerData?.action === RELEASE_GATE_WORKER_ACTION) {
  parentPort.postMessage(parallelWorkReleaseGateSnapshot());
}
