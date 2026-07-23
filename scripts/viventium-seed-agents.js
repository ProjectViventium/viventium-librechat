#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Seed Viventium agents into Mongo for new deployments.
 * Usage:
 *   node scripts/viventium-seed-agents.js --bundle tmp/viventium-agents.yaml [--email=...] [--dry-run]
 * === VIVENTIUM END === */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadLocalRuntimeEnv } = require('./viventium-runtime-env');
const {
  normalizeBundleForRuntime,
  buildCanonicalPersistedAgentFields,
  hasCanonicalPersistedAgentFieldDrift,
} = require('./viventium-agent-runtime-models');
const { resolvePromptRefs } = require('./viventium-sync-agents');

// App Support runtime env is the canonical local runtime source. Component-local env files are
// fallback-only and must not override the active generated runtime profile.
loadLocalRuntimeEnv(ROOT_DIR);
require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });

const yaml = require('js-yaml');
const { connectDb } = require('../api/db/connect');
const { seedDatabase } = require('../api/models');
const { Agent, User, AclEntry } = require('../api/db/models');
const { createAgent, updateAgent } = require('../api/models/Agent');
const { grantPermission } = require('../api/server/services/PermissionService');
const { AccessRoleIds, PrincipalType, ResourceType } = require('librechat-data-provider');

const DEFAULT_BUNDLE_PATH = path.join(ROOT_DIR, 'tmp', 'viventium-agents.yaml');
const DEFAULT_MANAGED_BASELINE_MIGRATION_PATH = path.join(
  ROOT_DIR,
  'viventium',
  'source_of_truth',
  'managed-agent-baseline-migration.json',
);
const DEFAULT_AGENT_SEED_OWNER_EMAIL = 'viventium-system@example.com';
const DEFAULT_PUBLIC_ACCESS_ROLE = 'viewer';
const OWNER_RECOVERY_GUIDANCE =
  'Restore the recorded administrator or the latest Viventium state backup, then restart; protected owner state was not changed.';

const AGENT_FIELDS = [
  'id',
  'name',
  'description',
  'instructions',
  'provider',
  'model',
  'tools',
  'tool_kwargs',
  'model_parameters',
  'end_after_tools',
  'hide_sequential_outputs',
  'support_contact',
  'background_cortices',
  'voice_llm_model',
  'voice_llm_provider',
  'voice_llm_model_parameters',
  'voice_fallback_llm_model',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model_parameters',
  'fallback_llm_model',
  'fallback_llm_provider',
  'fallback_llm_model_parameters',
  'agent_ids',
  'edges',
  'conversation_starters',
  'category',
];
/* === VIVENTIUM START ===
 * Feature: Protect live user-managed built-in agent state on startup reseed.
 * Purpose: Existing installs must keep editable agent fields until an intentional reviewed sync
 * reconciles them; startup seeding should only create missing agents or fill missing fields.
 * === VIVENTIUM END === */
const PRESERVE_EXISTING_EDITABLE_FIELDS = AGENT_FIELDS.filter((field) => field !== 'id');

const PUBLIC_ACCESS_ROLE_IDS = Object.freeze({
  viewer: {
    agent: AccessRoleIds.AGENT_VIEWER,
    remoteAgent: AccessRoleIds.REMOTE_AGENT_VIEWER,
  },
  editor: {
    agent: AccessRoleIds.AGENT_EDITOR,
    remoteAgent: AccessRoleIds.REMOTE_AGENT_EDITOR,
  },
  owner: {
    agent: AccessRoleIds.AGENT_OWNER,
    remoteAgent: AccessRoleIds.REMOTE_AGENT_OWNER,
  },
});

function parseArgs(argv) {
  const args = {
    bundlePath: DEFAULT_BUNDLE_PATH,
    email: '',
    ownerId: '',
    managedBaselinePath: process.env.VIVENTIUM_AGENT_MANAGED_BASELINE_PATH || '',
    managedBaselineMigrationPath:
      process.env.VIVENTIUM_AGENT_MANAGED_BASELINE_MIGRATION_PATH ||
      DEFAULT_MANAGED_BASELINE_MIGRATION_PATH,
    managedMigrationStatePath: '',
    predecessorSourceRef: '',
    dryRun: false,
    public: true,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--public') {
      args.public = true;
      continue;
    }
    if (arg === '--private') {
      args.public = false;
      continue;
    }
    if (arg.startsWith('--bundle=')) {
      args.bundlePath = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--email=')) {
      args.email = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--owner-id=')) {
      args.ownerId = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--managed-baseline=')) {
      args.managedBaselinePath = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--managed-baseline-migration=')) {
      args.managedBaselineMigrationPath = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--managed-migration-state=')) {
      args.managedMigrationStatePath = arg.split('=')[1];
      continue;
    }
  }

  return args;
}

function loadBundle(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bundle not found: ${filePath}`);
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(contents);
  }
  return yaml.load(contents, { schema: yaml.JSON_SCHEMA });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function valuesEqual(left, right) {
  return stableSerialize(left) === stableSerialize(right);
}

function buildManagedValueFingerprint(value) {
  return { $viventium_managed_sha256: sha256Stable(value) };
}

function isManagedValueFingerprint(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    /^[a-f0-9]{64}$/.test(String(value.$viventium_managed_sha256 || ''))
  );
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function keyedByAgentId(values) {
  if (!Array.isArray(values) || values.some((value) => !isPlainObject(value) || !value.agent_id)) {
    return null;
  }
  return new Map(values.map((value) => [String(value.agent_id), value]));
}

function mergeManagedObject(previous, live, incoming, pathParts) {
  const merged = {};
  const drift = [];
  const keys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(live || {}),
    ...Object.keys(incoming || {}),
  ]);
  for (const key of keys) {
    const priorHas = Object.prototype.hasOwnProperty.call(previous || {}, key);
    const liveHas = Object.prototype.hasOwnProperty.call(live || {}, key);
    const incomingHas = Object.prototype.hasOwnProperty.call(incoming || {}, key);
    const fieldPath = [...pathParts, key];
    if (!liveHas) {
      if (!priorHas && incomingHas) {
        merged[key] = deepClone(incoming[key]);
      } else if (priorHas && incomingHas) {
        drift.push(fieldPath.join('.'));
      }
      continue;
    }
    if (!incomingHas) {
      if (!priorHas || !valuesEqual(live[key], previous[key])) {
        merged[key] = deepClone(live[key]);
        drift.push(fieldPath.join('.'));
      }
      continue;
    }
    const result = mergeManagedValue(
      priorHas,
      previous?.[key],
      live[key],
      incoming[key],
      fieldPath,
    );
    merged[key] = result.value;
    drift.push(...result.drift);
  }
  return { value: merged, drift };
}

function mergeManagedAgentArray(previous, live, incoming, pathParts) {
  const previousById = keyedByAgentId(previous);
  const liveById = keyedByAgentId(live);
  const incomingById = keyedByAgentId(incoming);
  if (!previousById || !liveById || !incomingById) {
    return null;
  }
  const merged = [];
  const drift = [];
  const orderedIds = [
    ...incomingById.keys(),
    ...[...liveById.keys()].filter((id) => !incomingById.has(id)),
  ];
  for (const id of orderedIds) {
    const priorHas = previousById.has(id);
    const liveHas = liveById.has(id);
    const incomingHas = incomingById.has(id);
    const itemPath = [...pathParts, id];
    if (!liveHas) {
      if (!priorHas && incomingHas) {
        merged.push(deepClone(incomingById.get(id)));
      } else if (priorHas && incomingHas) {
        drift.push(itemPath.join('.'));
      }
      continue;
    }
    if (!incomingHas) {
      const liveValue = liveById.get(id);
      if (!priorHas || !valuesEqual(liveValue, previousById.get(id))) {
        merged.push(deepClone(liveValue));
        drift.push(itemPath.join('.'));
      }
      continue;
    }
    const result = mergeManagedValue(
      priorHas,
      previousById.get(id),
      liveById.get(id),
      incomingById.get(id),
      itemPath,
    );
    merged.push(result.value);
    drift.push(...result.drift);
  }
  return { value: merged, drift };
}

function mergeManagedValue(priorKnown, previous, live, incoming, pathParts) {
  if (valuesEqual(live, incoming)) {
    return { value: deepClone(incoming), drift: [] };
  }
  if (!priorKnown) {
    return { value: deepClone(live), drift: [pathParts.join('.')] };
  }
  if (
    valuesEqual(live, previous) ||
    (isManagedValueFingerprint(previous) &&
      previous.$viventium_managed_sha256 === sha256Stable(live))
  ) {
    return { value: deepClone(incoming), drift: [] };
  }
  if (isPlainObject(previous) && isPlainObject(live) && isPlainObject(incoming)) {
    return mergeManagedObject(previous, live, incoming, pathParts);
  }
  if (pathParts[0] === 'background_cortices') {
    const keyed = mergeManagedAgentArray(previous, live, incoming, pathParts);
    if (keyed) {
      return keyed;
    }
  }
  return { value: deepClone(live), drift: [pathParts.join('.')] };
}

function buildManagedBaseline(bundle) {
  const agents = [bundle.mainAgent, ...(bundle.backgroundAgents || [])].filter(
    (agent) => agent && agent.id && !agent.missing,
  );
  const managedAgents = {};
  for (const agent of agents) {
    const fields = {};
    for (const field of PRESERVE_EXISTING_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(agent, field)) {
        fields[field] = deepClone(agent[field]);
      }
    }
    managedAgents[agent.id] = { fields };
  }
  const canonical = { agents: managedAgents };
  return {
    schema_version: 1,
    bundle_sha256: sha256Stable(canonical),
    agents: managedAgents,
  };
}

function validateManagedBaseline(value, { label = 'Managed baseline' } = {}) {
  if (
    value?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(value.bundle_sha256 || '')) ||
    !value.agents ||
    typeof value.agents !== 'object' ||
    Array.isArray(value.agents)
  ) {
    throw new Error(`${label} file is invalid.`);
  }
  const expectedHash = sha256Stable({ agents: value.agents });
  if (value.bundle_sha256 !== expectedHash) {
    throw new Error(`${label} content hash does not match.`);
  }
  if (value.owner_id != null && !/^[a-f0-9]{24}$/i.test(String(value.owner_id))) {
    throw new Error(`${label} canonical owner user id is invalid. ${OWNER_RECOVERY_GUIDANCE}`);
  }
  return value;
}

function loadManagedBaseline(filePath) {
  if (!filePath) {
    return null;
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error('Managed baseline path must be absolute.');
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const metadata = fs.lstatSync(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Managed baseline file is unsafe.');
  }
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return validateManagedBaseline(value);
}

function buildManagedBaselineMigrationArtifact({
  migrationId,
  predecessorSourceRefs,
  predecessorSourceBundleSha256,
  baseline,
}) {
  const normalizedMigrationId = String(migrationId || '').trim();
  const normalizedRefs = [...new Set(predecessorSourceRefs || [])].sort();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalizedMigrationId)) {
    throw new Error('Managed baseline migration id is invalid.');
  }
  if (
    normalizedRefs.length === 0 ||
    normalizedRefs.some((value) => !/^[a-f0-9]{40}$/.test(String(value)))
  ) {
    throw new Error('Managed baseline migration predecessor refs are invalid.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(predecessorSourceBundleSha256 || ''))) {
    throw new Error('Managed baseline migration predecessor bundle hash is invalid.');
  }
  validateManagedBaseline(baseline, { label: 'Managed baseline migration baseline' });
  const migration = {
    migration_id: normalizedMigrationId,
    predecessor_source_refs: normalizedRefs,
    predecessor_source_bundle_sha256: predecessorSourceBundleSha256,
    baseline: deepClone(baseline),
  };
  const content = {
    schema_version: 1,
    migrations: [migration],
  };
  return {
    ...content,
    artifact_sha256: sha256Stable(content),
  };
}

function migrationArtifactContent(value) {
  if (value?.schema_version === 1) {
    return { schema_version: 1, migrations: value.migrations };
  }
  if (value?.schema_version === 2) {
    return {
      schema_version: 2,
      support_floor: value.support_floor,
      history_boundary: value.history_boundary,
      public_lock_revision_count: value.public_lock_revision_count,
      invalid_predecessors: value.invalid_predecessors,
      migrations: value.migrations,
    };
  }
  return null;
}

function loadManagedBaselineMigrationArtifact(filePath) {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
    throw new Error('Managed baseline migration artifact is unavailable.');
  }
  const metadata = fs.lstatSync(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error('Managed baseline migration artifact is unsafe.');
  }
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const content = migrationArtifactContent(value);
  if (
    !content ||
    !Array.isArray(value.migrations) ||
    value.migrations.length === 0 ||
    !/^[a-f0-9]{64}$/.test(String(value.artifact_sha256 || ''))
  ) {
    throw new Error('Managed baseline migration artifact is invalid.');
  }
  if (value.schema_version === 2) {
    if (
      !/^[a-f0-9]{40}$/.test(String(value.support_floor?.parent_commit || '')) ||
      !/^[a-f0-9]{40}$/.test(String(value.support_floor?.predecessor_source_ref || '')) ||
      typeof value.support_floor?.published_at !== 'string' ||
      !/^[a-f0-9]{40}$/.test(String(value.history_boundary?.parent_commit || '')) ||
      typeof value.history_boundary?.published_at !== 'string' ||
      !Number.isInteger(value.public_lock_revision_count) ||
      value.public_lock_revision_count < 1 ||
      !Array.isArray(value.invalid_predecessors)
    ) {
      throw new Error('Managed baseline migration artifact support floor is invalid.');
    }
  }
  if (value.artifact_sha256 !== sha256Stable(content)) {
    throw new Error('Managed baseline migration content hash does not match.');
  }
  const allRefs = new Set();
  for (const migration of value.migrations) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(String(migration?.migration_id || '')) ||
      !Array.isArray(migration?.predecessor_source_refs) ||
      migration.predecessor_source_refs.length === 0 ||
      migration.predecessor_source_refs.some((item) => !/^[a-f0-9]{40}$/.test(String(item))) ||
      !/^[a-f0-9]{64}$/.test(String(migration?.predecessor_source_bundle_sha256 || '')) ||
      (value.schema_version === 2 &&
        !/^[a-f0-9]{64}$/.test(String(migration?.predecessor_managed_bundle_sha256 || '')))
    ) {
      throw new Error('Managed baseline migration artifact is invalid.');
    }
    for (const ref of migration.predecessor_source_refs) {
      if (allRefs.has(ref)) {
        throw new Error('Managed baseline migration artifact contains a duplicate predecessor.');
      }
      allRefs.add(ref);
    }
    validateManagedBaseline(migration.baseline, {
      label: 'Managed baseline migration baseline',
    });
  }
  for (const item of value.invalid_predecessors || []) {
    if (
      !/^[a-f0-9]{40}$/.test(String(item?.predecessor_source_ref || '')) ||
      !/^[a-f0-9]{40}$/.test(String(item?.parent_commit || '')) ||
      item?.reason !== 'nested_object_was_never_published' ||
      allRefs.has(item.predecessor_source_ref)
    ) {
      throw new Error('Managed baseline migration invalid-predecessor record is invalid.');
    }
  }
  return value;
}

function loadManagedBaselineMigration(filePath, { predecessorSourceRef }) {
  if (!/^[a-f0-9]{40}$/.test(String(predecessorSourceRef || ''))) {
    throw new Error('Managed baseline migration predecessor ref is invalid.');
  }
  const value = loadManagedBaselineMigrationArtifact(filePath);
  if (
    (value.invalid_predecessors || []).some(
      (item) => item.predecessor_source_ref === predecessorSourceRef,
    )
  ) {
    throw new Error(`Published predecessor ${predecessorSourceRef} was never installable.`);
  }
  const matches = [];
  for (const migration of value.migrations) {
    if (migration.predecessor_source_refs.includes(predecessorSourceRef)) {
      matches.push(migration);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`No managed baseline migration matches predecessor ${predecessorSourceRef}.`);
  }
  return matches[0].baseline;
}

function buildManagedMigrationState({
  predecessorSourceRef,
  successorSourceRef,
  successorBundleSha256,
  registryArtifactSha256,
  transactionId,
}) {
  const content = {
    schema_version: 1,
    predecessor_source_ref: String(predecessorSourceRef || ''),
    successor_source_ref: String(successorSourceRef || ''),
    successor_bundle_sha256: String(successorBundleSha256 || ''),
    registry_artifact_sha256: String(registryArtifactSha256 || ''),
    transaction_id: String(transactionId || ''),
  };
  if (
    !/^[a-f0-9]{40}$/.test(content.predecessor_source_ref) ||
    !/^[a-f0-9]{40}$/.test(content.successor_source_ref) ||
    !/^[a-f0-9]{64}$/.test(content.successor_bundle_sha256) ||
    !/^[a-f0-9]{64}$/.test(content.registry_artifact_sha256) ||
    !/^upgrade-[A-Za-z0-9._-]{8,160}$/.test(content.transaction_id)
  ) {
    throw new Error('Managed migration state fields are invalid.');
  }
  return { ...content, content_sha256: sha256Stable(content) };
}

function readProtectedManagedMigrationState(filePath) {
  if (!filePath) return null;
  if (!path.isAbsolute(filePath)) {
    throw new Error('Managed migration state path must be absolute.');
  }
  if (!fs.existsSync(filePath)) return null;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error('Managed migration state file is unsafe.');
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const expected = buildManagedMigrationState({
      predecessorSourceRef: value.predecessor_source_ref,
      successorSourceRef: value.successor_source_ref,
      successorBundleSha256: value.successor_bundle_sha256,
      registryArtifactSha256: value.registry_artifact_sha256,
      transactionId: value.transaction_id,
    });
    if (value.content_sha256 !== expected.content_sha256) {
      throw new Error('Managed migration state content hash does not match.');
    }
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveCurrentManagedSourceRef(rootDir = ROOT_DIR) {
  const resolvedRoot = fs.realpathSync(rootDir);
  const topLevel = spawnSync('git', ['-C', resolvedRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  let sourceRef = '';
  if (topLevel.status === 0 && fs.realpathSync(topLevel.stdout.trim()) === resolvedRoot) {
    sourceRef = spawnSync('git', ['-C', resolvedRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim();
  }
  const lockPath = path.resolve(resolvedRoot, '..', '..', 'components.lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const component = lock.components?.find(
      (item) => item.name === 'LibreChat' || item.path === 'viventium_v0_4/LibreChat',
    );
    const lockedRef = String(component?.ref || '');
    if (!/^[a-f0-9]{40}$/.test(lockedRef)) {
      throw new Error('Current LibreChat lock identity is invalid.');
    }
    if (sourceRef && sourceRef !== lockedRef) {
      throw new Error('Current LibreChat checkout does not match its component lock.');
    }
    sourceRef ||= lockedRef;
  }
  if (!/^[a-f0-9]{40}$/.test(sourceRef)) {
    throw new Error('Current LibreChat source identity is unavailable.');
  }
  return sourceRef;
}

function loadManagedMigrationState(
  filePath,
  { bundlePath, managedBaselineMigrationPath, currentSourceRef },
) {
  const value = readProtectedManagedMigrationState(filePath);
  if (!value) return null;
  if (value.successor_source_ref !== currentSourceRef) {
    throw new Error('Managed migration state targets a different source release.');
  }
  if (!bundlePath || !path.isAbsolute(bundlePath) || !fs.existsSync(bundlePath)) {
    throw new Error('Managed migration target bundle is unavailable.');
  }
  const bundleHash = crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
  if (bundleHash !== value.successor_bundle_sha256) {
    throw new Error('Managed migration state targets a different agent bundle.');
  }
  const artifact = loadManagedBaselineMigrationArtifact(managedBaselineMigrationPath);
  if (artifact.artifact_sha256 !== value.registry_artifact_sha256) {
    throw new Error('Managed migration state targets a different migration registry.');
  }
  loadManagedBaselineMigration(managedBaselineMigrationPath, {
    predecessorSourceRef: value.predecessor_source_ref,
  });
  return value;
}

function consumeManagedMigrationState(filePath, expectedContentSha256) {
  const current = readProtectedManagedMigrationState(filePath);
  if (!current) return false;
  if (current.content_sha256 !== expectedContentSha256) {
    throw new Error('Managed migration state changed before successful consumption.');
  }
  fs.unlinkSync(filePath);
  const directoryDescriptor = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  return true;
}

function writeManagedBaseline(filePath, baseline, drift, ownerId = '') {
  if (!filePath) {
    return;
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error('Managed baseline path must be absolute.');
  }
  const parent = path.dirname(filePath);
  const parentMetadata = fs.lstatSync(parent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    parentMetadata.uid !== process.getuid()
  ) {
    throw new Error('Managed baseline directory is unsafe.');
  }
  const value = {
    ...baseline,
    unresolved_user_fields: drift,
    updated_at: new Date().toISOString(),
  };
  if (ownerId) {
    if (!/^[a-f0-9]{24}$/i.test(String(ownerId))) {
      throw new Error(`Canonical owner user id is invalid. ${OWNER_RECOVERY_GUIDANCE}`);
    }
    value.owner_id = String(ownerId);
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function reconcileManagedAgentFields(existing, incoming, previousFields = null) {
  if (!existing || !incoming) {
    return { agentData: incoming, drift: [] };
  }
  const merged = deepClone(incoming);
  const drift = [];
  for (const field of PRESERVE_EXISTING_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) || existing[field] === undefined) {
      continue;
    }
    const priorKnown =
      previousFields != null && Object.prototype.hasOwnProperty.call(previousFields, field);
    const result = mergeManagedValue(
      priorKnown,
      previousFields?.[field],
      existing[field],
      incoming[field],
      [field],
    );
    merged[field] = result.value;
    drift.push(...result.drift);
  }
  return { agentData: merged, drift };
}

function normalizePublicAccessRole(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (!normalized) {
    return DEFAULT_PUBLIC_ACCESS_ROLE;
  }

  if (normalized === 'view' || normalized === 'agent_viewer') {
    return 'viewer';
  }
  if (normalized === 'edit' || normalized === 'agent_editor') {
    return 'editor';
  }
  if (normalized === 'agent_owner') {
    return 'owner';
  }
  if (normalized in PUBLIC_ACCESS_ROLE_IDS) {
    return normalized;
  }
  return DEFAULT_PUBLIC_ACCESS_ROLE;
}

function resolvePublicAccessRoleIds(value) {
  const normalizedRole = normalizePublicAccessRole(value);
  return {
    normalizedRole,
    accessRoleIds: PUBLIC_ACCESS_ROLE_IDS[normalizedRole],
  };
}

function normalizeBundleForRuntimeWithOwner(bundle, { env = process.env } = {}) {
  const resolvedBundle = resolvePromptRefs(bundle);
  const normalized = normalizeBundleForRuntime(resolvedBundle, { env });
  normalized.meta = {
    ...(normalized.meta || {}),
    user: {
      email:
        (env.VIVENTIUM_AGENT_SEED_OWNER_EMAIL || DEFAULT_AGENT_SEED_OWNER_EMAIL)
          .toString()
          .trim() || DEFAULT_AGENT_SEED_OWNER_EMAIL,
    },
  };
  delete normalized.meta.user.id;

  return normalized;
}

function pickAgentFields(agent) {
  const picked = {};
  for (const field of AGENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(agent, field)) {
      picked[field] = agent[field];
    }
  }
  return picked;
}

function buildUpdateData(agentData) {
  const updateData = {};
  for (const field of AGENT_FIELDS) {
    if (field === 'id') {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(agentData, field)) {
      updateData[field] = agentData[field];
    }
  }
  return updateData;
}

function buildSeedAgentUpdatePlan(existing, agentData, { previousFields = null } = {}) {
  const reconciliation = reconcileManagedAgentFields(existing, agentData, previousFields);
  const effectiveAgentData = reconciliation.agentData;
  return {
    updateData: buildUpdateData(effectiveAgentData),
    runtimeRepairAgentData: effectiveAgentData,
    managedDrift: reconciliation.drift,
  };
}

function preserveExistingEditableFields(existing, agentData) {
  return reconcileManagedAgentFields(existing, agentData, null).agentData;
}

async function ensureUser(email) {
  let user = await User.findOne({ email }).lean();
  if (user) {
    return user;
  }
  user = await User.create({
    email,
    emailVerified: true,
    provider: 'local',
  });
  return user.toObject ? user.toObject() : user;
}

function selectCanonicalOwnerId({ ownerId = '', storedOwnerId = '', existingAgentOwnerId = '' }) {
  const selected = [ownerId, storedOwnerId, existingAgentOwnerId]
    .map((value) => String(value || '').trim())
    .find(Boolean);
  if (!selected) {
    return '';
  }
  if (!/^[a-f0-9]{24}$/i.test(selected)) {
    throw new Error(`Canonical owner user id is invalid. ${OWNER_RECOVERY_GUIDANCE}`);
  }
  return selected;
}

async function findEligibleExistingOwner(ownerId) {
  if (!/^[a-f0-9]{24}$/i.test(String(ownerId || ''))) {
    return null;
  }
  const user = await User.findById(ownerId).lean();
  if (!user || user.role !== 'ADMIN' || user.email === DEFAULT_AGENT_SEED_OWNER_EMAIL) {
    return null;
  }
  return user;
}

async function requireExistingOwner(ownerId) {
  if (!/^[a-f0-9]{24}$/i.test(String(ownerId || ''))) {
    throw new Error(`Owner user id is invalid. ${OWNER_RECOVERY_GUIDANCE}`);
  }
  const user = await User.findById(ownerId).lean();
  if (!user) {
    throw new Error(`Owner user does not exist. ${OWNER_RECOVERY_GUIDANCE}`);
  }
  if (user.email === DEFAULT_AGENT_SEED_OWNER_EMAIL) {
    throw new Error(
      `Placeholder owner cannot own Native built-in agents. ${OWNER_RECOVERY_GUIDANCE}`,
    );
  }
  if (user.role !== 'ADMIN') {
    throw new Error(
      `Stored built-in agent owner is not an administrator. ${OWNER_RECOVERY_GUIDANCE}`,
    );
  }
  return user;
}

async function resolveSeedOwner({ ownerId, storedOwnerId, existingAgentOwnerId, requestedEmail }) {
  const canonicalOwnerId = selectCanonicalOwnerId({
    ownerId,
    storedOwnerId,
    existingAgentOwnerId,
  });
  if (ownerId || storedOwnerId) {
    return await requireExistingOwner(canonicalOwnerId);
  }
  if (canonicalOwnerId) {
    const existingOwner = await findEligibleExistingOwner(canonicalOwnerId);
    if (existingOwner) {
      return existingOwner;
    }
  }
  if (requestedEmail && requestedEmail !== DEFAULT_AGENT_SEED_OWNER_EMAIL) {
    return await ensureUser(requestedEmail);
  }
  const administrators = await User.find({
    role: 'ADMIN',
    email: { $ne: DEFAULT_AGENT_SEED_OWNER_EMAIL },
  })
    .limit(2)
    .lean();
  if (administrators.length === 1) {
    return administrators[0];
  }
  if (administrators.length > 1) {
    throw new Error('Multiple administrators exist; pass --owner-id explicitly.');
  }
  return await ensureUser(DEFAULT_AGENT_SEED_OWNER_EMAIL);
}

function assertExistingAgentOwnersCompatible({
  existingAgents,
  ownerId,
  placeholderOwnerId = null,
}) {
  const canonicalOwnerId = String(ownerId || '');
  const allowedPlaceholderId = String(placeholderOwnerId || '');
  for (const agent of existingAgents || []) {
    const authorId = String(agent?.author || '');
    if (
      authorId === canonicalOwnerId ||
      (allowedPlaceholderId && authorId === allowedPlaceholderId)
    ) {
      continue;
    }
    throw new Error(
      `Built-in agent ${String(agent?.id || 'unknown')} has an existing non-placeholder author ` +
        `that differs from the canonical owner. ${OWNER_RECOVERY_GUIDANCE}`,
    );
  }
}

async function preflightExistingAgentOwners({ agentIds, ownerId, placeholderOwnerId = null }) {
  const existingAgents = await Agent.find({ id: { $in: agentIds } })
    .select('id author')
    .lean();
  assertExistingAgentOwnersCompatible({ existingAgents, ownerId, placeholderOwnerId });
  return existingAgents;
}

async function repairPersistedAgentRuntimeFields({ agentData, dryRun }) {
  if (!agentData?.id) {
    return { repaired: false, reason: 'missing-agent-id' };
  }

  const existing = await Agent.findOne({ id: agentData.id }).lean();
  if (!existing) {
    return { repaired: false, reason: 'missing-agent' };
  }

  const patch = buildCanonicalPersistedAgentFields(agentData, existing);
  if (!patch || !hasCanonicalPersistedAgentFieldDrift(existing, patch)) {
    return { repaired: false, reason: 'already-canonical' };
  }

  if (!dryRun) {
    await Agent.findOneAndUpdate({ id: agentData.id }, patch, { new: true }).lean();
  }

  return {
    repaired: true,
    fieldsUpdated: Object.keys(patch),
  };
}

async function upsertAgent({
  agentData,
  userId,
  dryRun,
  previousFields = null,
  placeholderOwnerId = null,
}) {
  if (!agentData || !agentData.id) {
    return { id: null, status: 'skipped', reason: 'missing agent id' };
  }
  const existing = await Agent.findOne({ id: agentData.id }).lean();
  if (!existing) {
    if (!dryRun) {
      const created = await createAgent({
        ...pickAgentFields(agentData),
        author: userId,
        category: agentData.category || 'viventium',
      });
      const runtimeRepair = await repairPersistedAgentRuntimeFields({ agentData, dryRun });
      return { id: agentData.id, status: 'created', resourceId: created._id, runtimeRepair };
    }
    return {
      id: agentData.id,
      status: 'dry-run',
      resourceId: null,
      runtimeRepair: await repairPersistedAgentRuntimeFields({ agentData, dryRun }),
    };
  }

  if (
    placeholderOwnerId &&
    String(existing.author || '') === String(placeholderOwnerId) &&
    String(userId) !== String(placeholderOwnerId)
  ) {
    if (!dryRun) {
      await Agent.updateOne(
        { _id: existing._id, author: placeholderOwnerId },
        { $set: { author: userId } },
      );
      await AclEntry.deleteMany({
        resourceId: existing._id,
        principalType: PrincipalType.USER,
        principalId: placeholderOwnerId,
      });
    }
    existing.author = userId;
  }

  const { updateData, runtimeRepairAgentData, managedDrift } = buildSeedAgentUpdatePlan(
    existing,
    agentData,
    { previousFields },
  );
  if (!dryRun && Object.keys(updateData).length > 0) {
    await updateAgent({ id: agentData.id }, updateData, { updatingUserId: userId });
  }
  const runtimeRepair = await repairPersistedAgentRuntimeFields({
    agentData: runtimeRepairAgentData,
    dryRun,
  });
  return {
    id: agentData.id,
    status: dryRun ? 'dry-run' : 'updated',
    resourceId: existing._id,
    runtimeRepair,
    managedDrift,
  };
}

async function ensureAgentPermissions({
  resourceId,
  ownerId,
  publicAccess,
  publicAccessRole,
  dryRun,
}) {
  if (!resourceId || dryRun) {
    return [];
  }

  const grants = [
    {
      principalType: PrincipalType.USER,
      principalId: ownerId,
      resourceType: ResourceType.AGENT,
      resourceId,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: ownerId,
    },
    {
      principalType: PrincipalType.USER,
      principalId: ownerId,
      resourceType: ResourceType.REMOTE_AGENT,
      resourceId,
      accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      grantedBy: ownerId,
    },
  ];

  if (publicAccess) {
    const { accessRoleIds } = resolvePublicAccessRoleIds(publicAccessRole);
    grants.push(
      {
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId,
        accessRoleId: accessRoleIds.agent,
        grantedBy: ownerId,
      },
      {
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId,
        accessRoleId: accessRoleIds.remoteAgent,
        grantedBy: ownerId,
      },
    );
  }

  const applied = [];
  for (const grant of grants) {
    try {
      await grantPermission(grant);
      applied.push({
        principalType: grant.principalType,
        resourceType: grant.resourceType,
        accessRoleId: grant.accessRoleId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      if (/^Role .* not found$/.test(message)) {
        console.warn(
          `[viventium-seed-agents] Skipping missing access role ${grant.accessRoleId} for ${grant.resourceType}`,
        );
        continue;
      }
      throw error;
    }
  }

  return applied;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = normalizeBundleForRuntimeWithOwner(loadBundle(args.bundlePath));
  if (!bundle || !bundle.mainAgent) {
    throw new Error('Invalid bundle: missing mainAgent');
  }

  const meta = bundle.meta || {};
  const requestedEmail = args.email || (meta.user && meta.user.email) || '';
  if (!args.ownerId && !requestedEmail) {
    throw new Error('Owner email is required (use --email= or bundle.meta.user.email).');
  }

  const mainAgentId = (meta.mainAgentId || bundle.mainAgent.id || '').toString();
  if (!mainAgentId) {
    throw new Error('Bundle missing main agent id.');
  }

  const migrationState = args.managedMigrationStatePath
    ? loadManagedMigrationState(args.managedMigrationStatePath, {
        bundlePath: path.resolve(args.bundlePath),
        managedBaselineMigrationPath: path.resolve(args.managedBaselineMigrationPath),
        currentSourceRef: resolveCurrentManagedSourceRef(),
      })
    : null;

  await connectDb();
  await seedDatabase();
  const localManagedBaseline = loadManagedBaseline(args.managedBaselinePath);
  const previousBaseline =
    localManagedBaseline ||
    (migrationState
      ? loadManagedBaselineMigration(args.managedBaselineMigrationPath, {
          predecessorSourceRef: migrationState.predecessor_source_ref,
        })
      : null);
  const nextBaseline = buildManagedBaseline(bundle);
  const existingMainAgent = await Agent.findOne({ id: mainAgentId }).select('author').lean();
  const owner = await resolveSeedOwner({
    ownerId: args.ownerId,
    storedOwnerId: localManagedBaseline?.owner_id || '',
    existingAgentOwnerId: existingMainAgent?.author || '',
    requestedEmail,
  });
  const email = String(owner.email || '');
  if (!email) {
    throw new Error('Resolved owner has no email.');
  }
  const { normalizedRole: publicAccessRole } = resolvePublicAccessRoleIds(
    process.env.VIVENTIUM_BUILTIN_AGENT_PUBLIC_ROLE,
  );
  const placeholderOwner = await User.findOne({ email: DEFAULT_AGENT_SEED_OWNER_EMAIL })
    .select('_id')
    .lean();
  const shippedAgentIds = [bundle.mainAgent, ...(bundle.backgroundAgents || [])]
    .filter((agent) => agent?.id && !agent.missing)
    .map((agent) => String(agent.id));
  await preflightExistingAgentOwners({
    agentIds: shippedAgentIds,
    ownerId: owner._id,
    placeholderOwnerId: placeholderOwner?._id || null,
  });

  const results = [];
  const unresolvedUserFields = [];
  const mainResult = await upsertAgent({
    agentData: bundle.mainAgent,
    userId: owner._id,
    dryRun: args.dryRun,
    previousFields: previousBaseline?.agents?.[bundle.mainAgent.id]?.fields || null,
    placeholderOwnerId: placeholderOwner?._id || null,
  });
  for (const field of mainResult.managedDrift || []) {
    unresolvedUserFields.push({ agent_id: bundle.mainAgent.id, field });
  }
  delete mainResult.managedDrift;
  mainResult.permissions = await ensureAgentPermissions({
    resourceId: mainResult.resourceId,
    ownerId: owner._id,
    publicAccess: args.public,
    publicAccessRole,
    dryRun: args.dryRun,
  });
  results.push(mainResult);

  if (Array.isArray(bundle.backgroundAgents)) {
    for (const agentData of bundle.backgroundAgents) {
      if (agentData && agentData.missing) {
        results.push({ id: agentData.id || null, status: 'missing', reason: 'marked missing' });
        continue;
      }
      const result = await upsertAgent({
        agentData,
        userId: owner._id,
        dryRun: args.dryRun,
        previousFields: previousBaseline?.agents?.[agentData.id]?.fields || null,
        placeholderOwnerId: placeholderOwner?._id || null,
      });
      for (const field of result.managedDrift || []) {
        unresolvedUserFields.push({ agent_id: agentData.id, field });
      }
      delete result.managedDrift;
      result.permissions = await ensureAgentPermissions({
        resourceId: result.resourceId,
        ownerId: owner._id,
        publicAccess: args.public,
        publicAccessRole,
        dryRun: args.dryRun,
      });
      results.push(result);
    }
  }

  if (!args.dryRun) {
    const canonicalOwnerId =
      owner.role === 'ADMIN' && email !== DEFAULT_AGENT_SEED_OWNER_EMAIL ? String(owner._id) : '';
    writeManagedBaseline(
      args.managedBaselinePath,
      nextBaseline,
      unresolvedUserFields,
      canonicalOwnerId,
    );
    if (migrationState) {
      consumeManagedMigrationState(args.managedMigrationStatePath, migrationState.content_sha256);
    }
  }

  const summary = {
    action: 'seed',
    bundle: args.bundlePath,
    owner_email: email,
    main_agent_id: mainAgentId,
    public: args.public,
    public_access_role: args.public ? publicAccessRole : null,
    managed_bundle_sha256: nextBaseline.bundle_sha256,
    preserved_user_field_count: unresolvedUserFields.length,
    managed_migration_consumed: Boolean(migrationState && !args.dryRun),
    results,
  };
  process.stdout.write(JSON.stringify(summary));
}

async function shutdown(code) {
  const mongoose = require('mongoose');
  try {
    if (mongoose.connection?.readyState === 1) {
      await mongoose.disconnect();
    }
  } catch (err) {
    console.error(err);
  }
  process.exit(code);
}

if (require.main === module) {
  run()
    .then(() => shutdown(0))
    .catch((err) => {
      console.error(err);
      return shutdown(1);
    });
}

module.exports = {
  parseArgs,
  loadBundle,
  normalizeBundleForRuntimeWithOwner,
  normalizePublicAccessRole,
  buildSeedAgentUpdatePlan,
  pickAgentFields,
  resolvePublicAccessRoleIds,
  selectCanonicalOwnerId,
  assertExistingAgentOwnersCompatible,
  preflightExistingAgentOwners,
  preserveExistingEditableFields,
  repairPersistedAgentRuntimeFields,
  requireExistingOwner,
  resolveSeedOwner,
  stableSerialize,
  buildManagedBaseline,
  buildManagedValueFingerprint,
  buildManagedBaselineMigrationArtifact,
  buildManagedMigrationState,
  consumeManagedMigrationState,
  loadManagedBaseline,
  loadManagedBaselineMigration,
  loadManagedBaselineMigrationArtifact,
  loadManagedMigrationState,
  resolveCurrentManagedSourceRef,
  writeManagedBaseline,
  reconcileManagedAgentFields,
};
