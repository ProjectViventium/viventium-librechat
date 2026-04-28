#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Viventium pull/push sync script for main + background agents.
 * Usage:
 *   node scripts/viventium-sync-agents.js pull [--email=... --agent-id=...]
 *   node scripts/viventium-sync-agents.js push [--email=... --dry-run]
 * Defaults:
 *   pull => .viventium/artifacts/agents-sync/runs/<timestamp>/viventium-agents.yaml
 *   pull => also writes: viventium/source_of_truth/<env>.viventium-agents.yaml (normalized for clean git diffs)
 *   push => viventium/source_of_truth/<env>.viventium-agents.yaml if present,
 *           else latest agents-sync run (fallback: tmp/viventium-agents.yaml)
 * === VIVENTIUM END === */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const CORE_DIR = path.resolve(ROOT_DIR, '..', '..');
const { loadLocalRuntimeEnv } = require('./viventium-runtime-env');
const {
  normalizeBundleForRuntime,
  buildCanonicalPersistedAgentFields,
  hasCanonicalPersistedAgentFieldDrift,
} = require('./viventium-agent-runtime-models');

loadLocalRuntimeEnv(ROOT_DIR);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const {
  buildRunDir,
  getLatestRun,
  resolveArtifactsRoot,
  sanitizeSlug,
  setLatestRun,
} = require('./viv-artifact-paths');

const yaml = require('js-yaml');
const mongoose = require('mongoose');
const { Agent, User } = require('../api/db/models');
const { updateAgent, createAgent } = require('../api/models/Agent');
/* === VIVENTIUM START ===
 * Feature: Grant ACL when sync script creates new agents.
 * Root cause: Agent.create() alone is insufficient — LibreChat's agent list is filtered by ACL.
 * Without grantPermission + AclEntry, agents are invisible in the UI despite existing in MongoDB.
 * Note: PermissionService cannot be used in standalone scripts (depends on GraphApiService
 * which requires the full app server context). Use raw AclEntry instead.
 * === VIVENTIUM END === */
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');

const DEFAULT_EMAIL = (process.env.VIVENTIUM_AGENT_SYNC_EMAIL || '').trim();
const DEFAULT_MAIN_AGENT_ID = process.env.VIVENTIUM_MAIN_AGENT_ID || 'agent_viventium_main_95aeb3';
const ARTIFACT_CATEGORY = 'agents-sync';
const LEGACY_DEFAULT_OUT_PATH = path.join(ROOT_DIR, 'tmp', 'viventium-agents.yaml');
const DEFAULT_OUT_PATH = LEGACY_DEFAULT_OUT_PATH;
const DEFAULT_ENV_SLUG = sanitizeSlug(process.env.VIVENTIUM_ENV || 'local');
const SOURCE_OF_TRUTH_DIR = path.join(ROOT_DIR, 'viventium', 'source_of_truth');
const SOURCE_OF_TRUTH_OWNER_EMAIL = 'user@viventium.local';
const SOURCE_OF_TRUTH_OWNER_ID = 'placeholder-owner';
const NON_RUNTIME_OWNER_EMAILS = new Set([
  '',
  SOURCE_OF_TRUTH_OWNER_EMAIL.toLowerCase(),
  'viventium-system@example.com',
]);

const DEFAULT_SCHEDULES_DB_PATH = path.join(
  process.env.HOME || '~',
  '.viventium',
  'scheduling',
  'schedules.db',
);

function resolveSourceOfTruthAgentsPath(envSlug) {
  return path.join(SOURCE_OF_TRUTH_DIR, `${sanitizeSlug(envSlug)}.viventium-agents.yaml`);
}

function resolveSourceOfTruthLibrechatYamlPath(envSlug) {
  return path.join(SOURCE_OF_TRUTH_DIR, `${sanitizeSlug(envSlug)}.librechat.yaml`);
}

function normalizeBundleForSourceOfTruth(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return bundle;
  }

  // Remove "diff noise" fields that change every pull regardless of functional config changes.
  const normalized = JSON.parse(JSON.stringify(bundle));
  if (normalized.meta && typeof normalized.meta === 'object') {
    normalized.meta.exportedAt = null;
    normalized.meta.user = {
      email: SOURCE_OF_TRUTH_OWNER_EMAIL,
      id: SOURCE_OF_TRUTH_OWNER_ID,
    };
  }
  return normalized;
}

function writeSourceOfTruthFiles({ envSlug, bundle }) {
  const agentsPath = resolveSourceOfTruthAgentsPath(envSlug);
  ensureDirForFile(agentsPath);
  writeBundle(agentsPath, 'yaml', normalizeBundleForSourceOfTruth(bundle));

  const librechatYamlSrc = path.join(ROOT_DIR, 'librechat.yaml');
  const librechatYamlPath = resolveSourceOfTruthLibrechatYamlPath(envSlug);
  let librechatYamlCopied = false;
  if (fs.existsSync(librechatYamlSrc)) {
    ensureDirForFile(librechatYamlPath);
    fs.copyFileSync(librechatYamlSrc, librechatYamlPath);
    librechatYamlCopied = true;
  }

  return {
    env: sanitizeSlug(envSlug),
    agentsPath,
    librechatYamlPath: librechatYamlCopied ? librechatYamlPath : null,
  };
}

function resolveDefaultPullOutPath(envSlug) {
  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  const runDir = buildRunDir({ artifactsRoot, category: ARTIFACT_CATEGORY, label: envSlug });
  return path.join(runDir, 'viventium-agents.yaml');
}

function resolveDefaultPushInPath(envSlug) {
  const sourceOfTruthPath = resolveSourceOfTruthAgentsPath(envSlug);
  if (fs.existsSync(sourceOfTruthPath)) {
    return sourceOfTruthPath;
  }

  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  const latestRun = getLatestRun({ artifactsRoot, category: ARTIFACT_CATEGORY });
  if (!latestRun) {
    return LEGACY_DEFAULT_OUT_PATH;
  }
  return path.join(latestRun, 'viventium-agents.yaml');
}

function markLatestRunFromFile(filePath) {
  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  setLatestRun({
    artifactsRoot,
    category: ARTIFACT_CATEGORY,
    runDir: path.dirname(path.resolve(filePath)),
  });
}

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

// Safe fields that only affect prompts/instructions, not tool configurations
const PROMPTS_ONLY_FIELDS = [
  'id',
  'name',
  'description',
  'instructions',
  'conversation_starters',
  'background_cortices', // Will be handled specially to only update activation prompts
];
const MODEL_CONFIG_ONLY_FIELDS = [
  'id',
  'provider',
  'model',
  'model_parameters',
  'voice_llm_model',
  'voice_llm_provider',
  'voice_llm_model_parameters',
  'voice_fallback_llm_model',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model_parameters',
  'fallback_llm_model',
  'fallback_llm_provider',
  'fallback_llm_model_parameters',
];
const REVIEW_FIELDS = [
  'name',
  'description',
  'instructions',
  'tools',
  'tool_kwargs',
  'provider',
  'model',
  'model_parameters',
  'voice_llm_model',
  'voice_llm_provider',
  'voice_llm_model_parameters',
  'voice_fallback_llm_model',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model_parameters',
  'fallback_llm_model',
  'fallback_llm_provider',
  'fallback_llm_model_parameters',
  'conversation_starters',
  'background_cortices',
];
const LIBRECHAT_REVIEW_FIELDS = [
  { path: ['interface', 'webSearch'], label: 'interface.webSearch' },
  { path: ['interface', 'fileSearch'], label: 'interface.fileSearch' },
  { path: ['interface', 'defaultAgent'], label: 'interface.defaultAgent' },
  { path: ['webSearch'], label: 'webSearch' },
  { path: ['viventium', 'primaryProvider'], label: 'viventium.primaryProvider' },
  { path: ['viventium', 'consciousAgent', 'provider'], label: 'viventium.consciousAgent.provider' },
  { path: ['viventium', 'consciousAgent', 'model'], label: 'viventium.consciousAgent.model' },
];

const DEFAULT_PROMPTS_ONLY_ACTIVATION_FIELDS = [
  'enabled',
  'prompt',
  'confidence_threshold',
  'fallbacks',
];
const DEFAULT_ACTIVATION_CONFIG_FIELDS = [
  'enabled',
  'prompt',
  'confidence_threshold',
  'model',
  'provider',
  'fallbacks',
  'cooldown_ms',
  'max_history',
  'intent_scope',
];
const SAFE_ACTIVATION_FIELD_SET = new Set(DEFAULT_ACTIVATION_CONFIG_FIELDS);

function loadConnectDb() {
  return require('../api/db/connect').connectDb;
}

function configureMongoUri(mongoUri) {
  if (!mongoUri) {
    return;
  }
  process.env.MONGO_URI = mongoUri;
}

function parseActivationFields(rawValue) {
  if (!rawValue) {
    return [];
  }

  return Array.from(
    new Set(
      String(rawValue)
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  );
}

function parseIdList(rawValue) {
  if (!rawValue) {
    return [];
  }

  return Array.from(
    new Set(
      String(rawValue)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeOwnerEmail(email) {
  return String(email || '').trim();
}

function isPlaceholderOwnerEmail(email) {
  return NON_RUNTIME_OWNER_EMAILS.has(normalizeOwnerEmail(email).toLowerCase());
}

async function resolveUserByAgentAuthor(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    return null;
  }
  const agent = await Agent.findOne({ id: normalizedAgentId }, { author: 1 }).lean();
  if (!agent?.author) {
    return null;
  }
  return User.findById(agent.author).lean();
}

async function resolveSyncUser({ explicitEmail, agentId = null, bundle = null } = {}) {
  const emailCandidates = [
    normalizeOwnerEmail(explicitEmail),
    normalizeOwnerEmail(bundle?.meta?.user?.email),
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);

  for (const candidate of emailCandidates) {
    if (isPlaceholderOwnerEmail(candidate)) {
      continue;
    }
    const user = await User.findOne({ email: candidate }).lean();
    if (user) {
      return user;
    }
  }

  const agentIdCandidates = [
    agentId,
    bundle?.mainAgent?.id,
    bundle?.meta?.mainAgentId,
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);

  for (const candidate of agentIdCandidates) {
    const user = await resolveUserByAgentAuthor(candidate);
    if (user) {
      return user;
    }
  }

  return null;
}

function resolveSafeActivationFields({
  promptsOnly = false,
  activationConfigOnly = false,
  activationFields = null,
} = {}) {
  if (Array.isArray(activationFields) && activationFields.length) {
    return activationFields;
  }
  if (promptsOnly) {
    return DEFAULT_PROMPTS_ONLY_ACTIVATION_FIELDS;
  }
  if (activationConfigOnly) {
    return DEFAULT_ACTIVATION_CONFIG_FIELDS;
  }
  return [];
}

function validateSafeActivationFields(fields) {
  const invalid = (fields || []).filter((field) => !SAFE_ACTIVATION_FIELD_SET.has(field));
  if (!invalid.length) {
    return;
  }

  throw new Error(
    `Unsupported activation field(s): ${invalid.join(', ')}. ` +
      `Allowed: ${Array.from(SAFE_ACTIVATION_FIELD_SET).join(', ')}`,
  );
}

function parseArgs(argv) {
  const args = {
    action: null,
    help: false,
    outPath: null,
    inPath: null,
    sourcePath: null,
    livePath: null,
    email: DEFAULT_EMAIL,
    agentId: DEFAULT_MAIN_AGENT_ID,
    env: DEFAULT_ENV_SLUG,
    noSourceOfTruth: false,
    dryRun: false,
    format: null,
    positionalFile: null,
    mongoUri: null,
    promptsOnly: false, // Safe mode: only update prompts/instructions, not tools
    activationConfigOnly: false, // Safe mode: only update selected background cortex activation fields
    modelConfigOnly: false, // Safe mode: only update agent model/provider fields
    runtimeAware: null, // Apply canonical runtime model/activation overrides before push
    activationFields: null,
    selectedAgentIds: null,
    schedules: false,
    schedulesDbPath: DEFAULT_SCHEDULES_DB_PATH,
    schedulesOutPath: null,
    schedulesInPath: null,
    schedulesUserId: null,
    schedulesResolveUsers: false,
    schedulesMcpUrl: null,
    schedulesLibrechatYamlPath: null,
    schedulesPrune: false,
    schedulesCreateMissing: false,
    compareReviewed: false,
  };

  const readValue = (arg, prefix) => arg.slice(prefix.length);

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      args.help = true;
      continue;
    }
    if (arg === 'pull' || arg === '--pull') {
      args.action = 'pull';
      continue;
    }
    if (arg === 'push' || arg === '--push') {
      args.action = 'push';
      continue;
    }
    if (arg === 'compare' || arg === '--compare') {
      args.action = 'compare';
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--compare-reviewed') {
      args.compareReviewed = true;
      continue;
    }
    if (arg === '--prompts-only') {
      args.promptsOnly = true;
      continue;
    }
    if (arg === '--activation-config-only') {
      args.activationConfigOnly = true;
      continue;
    }
    if (arg === '--model-config-only') {
      args.modelConfigOnly = true;
      continue;
    }
    if (arg === '--runtime-aware') {
      args.runtimeAware = true;
      continue;
    }
    if (arg === '--raw-source-of-truth' || arg === '--no-runtime-aware') {
      args.runtimeAware = false;
      continue;
    }
    if (arg === '--no-source-of-truth' || arg === '--no-sot') {
      args.noSourceOfTruth = true;
      continue;
    }
    if (arg === '--schedules' || arg === '--with-schedules') {
      args.schedules = true;
      continue;
    }
    if (arg === '--schedules-resolve-users') {
      args.schedulesResolveUsers = true;
      continue;
    }
    if (arg === '--schedules-prune') {
      args.schedulesPrune = true;
      continue;
    }
    if (arg === '--schedules-create-missing') {
      args.schedulesCreateMissing = true;
      continue;
    }
    if (arg === '--json') {
      args.format = 'json';
      continue;
    }
    if (arg === '--yaml') {
      args.format = 'yaml';
      continue;
    }
    if (arg.startsWith('--mongo-uri=')) {
      args.mongoUri = readValue(arg, '--mongo-uri=');
      continue;
    }
    if (arg.startsWith('--mongo=')) {
      args.mongoUri = readValue(arg, '--mongo=');
      continue;
    }
    if (arg.startsWith('--env=')) {
      args.env = sanitizeSlug(readValue(arg, '--env='));
      continue;
    }
    if (arg.startsWith('--out=')) {
      args.outPath = readValue(arg, '--out=');
      continue;
    }
    if (arg.startsWith('--in=')) {
      args.inPath = readValue(arg, '--in=');
      continue;
    }
    if (arg.startsWith('--source=')) {
      args.sourcePath = readValue(arg, '--source=');
      continue;
    }
    if (arg.startsWith('--live=')) {
      args.livePath = readValue(arg, '--live=');
      continue;
    }
    if (arg.startsWith('--file=')) {
      const filePath = readValue(arg, '--file=');
      args.outPath = filePath;
      args.inPath = filePath;
      continue;
    }
    if (arg.startsWith('--email=')) {
      args.email = readValue(arg, '--email=');
      continue;
    }
    if (arg.startsWith('--agent-id=')) {
      args.agentId = readValue(arg, '--agent-id=');
      continue;
    }
    if (arg.startsWith('--activation-fields=')) {
      args.activationFields = parseActivationFields(readValue(arg, '--activation-fields='));
      continue;
    }
    if (arg.startsWith('--agent-ids=')) {
      args.selectedAgentIds = parseIdList(readValue(arg, '--agent-ids='));
      continue;
    }
    if (arg.startsWith('--only-agent-ids=')) {
      args.selectedAgentIds = parseIdList(readValue(arg, '--only-agent-ids='));
      continue;
    }
    if (arg.startsWith('--schedules-db=')) {
      args.schedulesDbPath = readValue(arg, '--schedules-db=');
      continue;
    }
    if (arg.startsWith('--schedules-out=')) {
      args.schedulesOutPath = readValue(arg, '--schedules-out=');
      continue;
    }
    if (arg.startsWith('--schedules-in=')) {
      args.schedulesInPath = readValue(arg, '--schedules-in=');
      continue;
    }
    if (arg.startsWith('--schedules-user-id=')) {
      args.schedulesUserId = readValue(arg, '--schedules-user-id=');
      continue;
    }
    if (arg.startsWith('--schedules-mcp-url=')) {
      args.schedulesMcpUrl = readValue(arg, '--schedules-mcp-url=');
      continue;
    }
    if (arg.startsWith('--schedules-librechat-yaml=')) {
      args.schedulesLibrechatYamlPath = readValue(arg, '--schedules-librechat-yaml=');
      continue;
    }
    if (!arg.startsWith('-') && !args.positionalFile && arg !== 'pull' && arg !== 'push') {
      args.positionalFile = arg;
    }
  }

  if (args.positionalFile) {
    if (args.action === 'pull') {
      args.outPath = args.positionalFile;
    } else if (args.action === 'push') {
      args.inPath = args.positionalFile;
    } else {
      args.outPath = args.positionalFile;
      args.inPath = args.positionalFile;
    }
  }

  if ([args.promptsOnly, args.activationConfigOnly, args.modelConfigOnly].filter(Boolean).length > 1) {
    throw new Error(
      'Choose only one safe push mode: --prompts-only, --activation-config-only, or --model-config-only',
    );
  }
  if (args.activationFields && !args.promptsOnly && !args.activationConfigOnly) {
    throw new Error('--activation-fields requires --prompts-only or --activation-config-only');
  }
  validateSafeActivationFields(resolveSafeActivationFields(args));

  return args;
}

function shouldApplyRuntimeOverrides({
  action,
  env = DEFAULT_ENV_SLUG,
  runtimeAware = null,
} = {}) {
  if (action !== 'push') {
    return false;
  }
  if (runtimeAware === true) {
    return true;
  }
  if (runtimeAware === false) {
    return false;
  }
  return sanitizeSlug(env) === 'local';
}

function resolveSchedulesPath({ baseFilePath, explicitPath, defaultBasename }) {
  if (explicitPath) {
    return explicitPath;
  }
  const dir = path.dirname(baseFilePath);
  return path.join(dir, defaultBasename);
}

function runVivScheduleSync(args) {
  const scriptPath = path.join(__dirname, 'viv-schedule-sync.js');
  const output = execFileSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // The schedule script may emit logger output before printing JSON.
  const marker = '{\n  "action":';
  const idx = output.lastIndexOf(marker);
  if (idx !== -1) {
    const candidate = output.slice(idx).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(output);
  } catch (err) {
    return { raw: output };
  }
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

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function resolveFormat({ filePath, explicitFormat }) {
  if (explicitFormat === 'json' || explicitFormat === 'yaml') {
    return explicitFormat;
  }
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.json') {
    return 'json';
  }
  if (ext === '.yaml' || ext === '.yml') {
    return 'yaml';
  }
  return 'yaml';
}

function loadBundle(filePath, explicitFormat) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return loadBundleFromContents({ contents, filePath, explicitFormat });
}

function loadBundleFromContents({ contents, filePath, explicitFormat }) {
  const format = resolveFormat({ filePath, explicitFormat });
  if (format === 'json') {
    return JSON.parse(contents);
  }
  return yaml.load(contents, { schema: yaml.JSON_SCHEMA });
}

function writeBundle(filePath, explicitFormat, bundle) {
  const format = resolveFormat({ filePath, explicitFormat });
  if (format === 'json') {
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2));
    return format;
  }
  const output = yaml.dump(bundle, { schema: yaml.JSON_SCHEMA, lineWidth: -1 });
  fs.writeFileSync(filePath, output);
  return format;
}

function buildBundleAgentIndex(bundle) {
  const map = new Map();
  if (!bundle || typeof bundle !== 'object') {
    return map;
  }

  if (bundle.mainAgent && typeof bundle.mainAgent === 'object') {
    const id = bundle.mainAgent.id || bundle.meta?.mainAgentId || 'mainAgent';
    map.set(id, { kind: 'mainAgent', data: bundle.mainAgent });
  }

  for (const agent of bundle.backgroundAgents || []) {
    if (!agent || typeof agent !== 'object' || !agent.id) {
      continue;
    }
    map.set(agent.id, { kind: 'backgroundAgent', data: agent });
  }

  return map;
}

function summarizeScalar(value) {
  const text = String(value ?? '');
  return {
    length: text.length,
    preview: text.slice(0, 240),
  };
}

function sortValueForComparison(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValueForComparison(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValueForComparison(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function stableSerialize(value) {
  return JSON.stringify(sortValueForComparison(value ?? null));
}

function summarizeStringArrayDiff(leftValue, rightValue) {
  const left = Array.isArray(leftValue) ? leftValue.map((value) => String(value)) : [];
  const right = Array.isArray(rightValue) ? rightValue.map((value) => String(value)) : [];
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  return {
    leftCount: left.length,
    rightCount: right.length,
    added: right.filter((value) => !leftSet.has(value)).slice(0, 20),
    removed: left.filter((value) => !rightSet.has(value)).slice(0, 20),
  };
}

function summarizeBackgroundCorticesDiff(leftValue, rightValue) {
  const left = Array.isArray(leftValue) ? leftValue : [];
  const right = Array.isArray(rightValue) ? rightValue : [];
  const leftById = new Map(left.map((entry) => [entry?.agent_id, entry]).filter(([id]) => id));
  const rightById = new Map(right.map((entry) => [entry?.agent_id, entry]).filter(([id]) => id));
  const leftIds = Array.from(leftById.keys());
  const rightIds = Array.from(rightById.keys());
  const leftSet = new Set(leftIds);
  const rightSet = new Set(rightIds);
  const changedAgents = [];

  for (const agentId of leftIds) {
    if (!rightSet.has(agentId)) {
      continue;
    }
    const leftEntry = leftById.get(agentId) || {};
    const rightEntry = rightById.get(agentId) || {};
    const activationChangedFields = [];
    const activationDetails = {};
    const metadataChangedFields = [];
    const metadataDetails = {};
    const leftActivation = leftEntry.activation || {};
    const rightActivation = rightEntry.activation || {};
    const activationFieldNames = Array.from(
      new Set([...Object.keys(leftActivation), ...Object.keys(rightActivation)]),
    ).sort();

    for (const field of activationFieldNames) {
      if (stableSerialize(leftActivation[field]) === stableSerialize(rightActivation[field])) {
        continue;
      }
      activationChangedFields.push(field);
      activationDetails[field] = summarizeFieldDiff(field, leftActivation[field], rightActivation[field]);
    }

    const entryFieldNames = Array.from(
      new Set([...Object.keys(leftEntry), ...Object.keys(rightEntry)]),
    )
      .filter((field) => field !== 'agent_id' && field !== 'activation')
      .sort();

    for (const field of entryFieldNames) {
      if (stableSerialize(leftEntry[field]) === stableSerialize(rightEntry[field])) {
        continue;
      }
      metadataChangedFields.push(field);
      metadataDetails[field] = summarizeFieldDiff(field, leftEntry[field], rightEntry[field]);
    }

    if (activationChangedFields.length > 0 || metadataChangedFields.length > 0) {
      changedAgents.push({
        agentId,
        activationChangedFields,
        activationDetails,
        metadataChangedFields,
        metadataDetails,
      });
    }
  }

  return {
    leftCount: left.length,
    rightCount: right.length,
    addedAgentIds: rightIds.filter((id) => !leftSet.has(id)).slice(0, 20),
    removedAgentIds: leftIds.filter((id) => !rightSet.has(id)).slice(0, 20),
    changedAgentIds: changedAgents.map((entry) => entry.agentId).slice(0, 20),
    changedAgents: changedAgents.slice(0, 20),
  };
}

function summarizeFieldDiff(field, leftValue, rightValue) {
  if (typeof leftValue === 'string' || typeof rightValue === 'string') {
    return {
      left: summarizeScalar(leftValue),
      right: summarizeScalar(rightValue),
    };
  }

  if (
    Array.isArray(leftValue) &&
    Array.isArray(rightValue) &&
    leftValue.every((value) => typeof value === 'string') &&
    rightValue.every((value) => typeof value === 'string')
  ) {
    return summarizeStringArrayDiff(leftValue, rightValue);
  }

  if (field === 'background_cortices') {
    return summarizeBackgroundCorticesDiff(leftValue, rightValue);
  }

  return {
    left: summarizeScalar(stableSerialize(leftValue)),
    right: summarizeScalar(stableSerialize(rightValue)),
  };
}

function getNestedValue(value, pathSegments) {
  return pathSegments.reduce((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return current[segment];
  }, value);
}

function compareNamedFields({
  leftValue,
  rightValue,
  fields,
}) {
  const diffs = [];

  for (const field of fields || []) {
    const fieldPath = Array.isArray(field.path) ? field.path : [];
    const label = field.label || fieldPath.join('.');
    const leftFieldValue = getNestedValue(leftValue, fieldPath);
    const rightFieldValue = getNestedValue(rightValue, fieldPath);
    if (stableSerialize(leftFieldValue) === stableSerialize(rightFieldValue)) {
      continue;
    }
    diffs.push({
      field: label,
      left: summarizeScalar(stableSerialize(leftFieldValue)),
      right: summarizeScalar(stableSerialize(rightFieldValue)),
    });
  }

  return {
    totalFieldsCompared: (fields || []).length,
    diffCount: diffs.length,
    diffs,
  };
}

function loadYamlDocument(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  return yaml.load(contents);
}

function compareBundlesByAgent({
  leftBundle,
  rightBundle,
  fields = REVIEW_FIELDS,
}) {
  const leftMap = buildBundleAgentIndex(leftBundle);
  const rightMap = buildBundleAgentIndex(rightBundle);
  const ids = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort();
  const diffs = [];

  for (const id of ids) {
    const leftEntry = leftMap.get(id);
    const rightEntry = rightMap.get(id);
    const leftAgent = leftEntry?.data || {};
    const rightAgent = rightEntry?.data || {};
    const changedFields = [];
    const fieldDetails = {};

    for (const field of fields) {
      const leftValue = leftAgent[field];
      const rightValue = rightAgent[field];
      if (stableSerialize(leftValue) === stableSerialize(rightValue)) {
        continue;
      }
      const summary = summarizeFieldDiff(field, leftValue, rightValue);
      if (
        field === 'background_cortices' &&
        summary &&
        Array.isArray(summary.addedAgentIds) &&
        Array.isArray(summary.removedAgentIds) &&
        Array.isArray(summary.changedAgentIds) &&
        Array.isArray(summary.changedAgents) &&
        summary.addedAgentIds.length === 0 &&
        summary.removedAgentIds.length === 0 &&
        summary.changedAgentIds.length === 0 &&
        summary.changedAgents.length === 0
      ) {
        continue;
      }
      changedFields.push(field);
      fieldDetails[field] = summary;
    }

    if (!changedFields.length) {
      continue;
    }

    diffs.push({
      id,
      kind: leftEntry?.kind || rightEntry?.kind || 'unknown',
      changedFields,
      details: fieldDetails,
    });
  }

  return {
    totalAgentsCompared: ids.length,
    diffCount: diffs.length,
    diffs,
  };
}

function loadBundleFromGitHead(filePath, explicitFormat) {
  const relativePath = path.relative(ROOT_DIR, path.resolve(filePath)).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  try {
    const contents = execFileSync('git', ['show', `HEAD:${relativePath}`], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return loadBundleFromContents({ contents, filePath, explicitFormat });
  } catch {
    return null;
  }
}

function buildCompareRecommendations({
  liveVsSource,
  workingTreeVsHead,
  sourceExists,
  adjacentLibrechat = null,
}) {
  const recommendations = [];
  const liveDiffFields = new Set(
    (liveVsSource?.diffs || []).flatMap((entry) => entry.changedFields || []),
  );
  const workingTreeDiffFields = new Set(
    (workingTreeVsHead?.diffs || []).flatMap((entry) => entry.changedFields || []),
  );
  const adjacentLiveDiffFields = new Set(
    (adjacentLibrechat?.liveVsSource?.diffs || []).map((entry) => entry.field),
  );
  const adjacentWorkingDiffFields = new Set(
    (adjacentLibrechat?.workingTreeVsHead?.diffs || []).map((entry) => entry.field),
  );

  if (!sourceExists) {
    recommendations.push(
      'Tracked source-of-truth bundle is missing; do not push until a reviewed source-of-truth file exists for this environment.',
    );
  } else if ((liveVsSource?.diffCount || 0) === 0) {
    recommendations.push(
      'Live user-level agent config and tracked source-of-truth currently match for the reviewed sync fields.',
    );
  } else {
    recommendations.push(
      `Live user-level config differs from tracked source-of-truth for ${liveVsSource.diffCount} agent(s); review those drifts before any push.`,
    );
  }

  if (liveDiffFields.has('tools')) {
    recommendations.push(
      'Live tool arrays drift from source-of-truth. Do not use full push until those live tool changes are intentionally reconciled.',
    );
  }
  if (workingTreeDiffFields.has('tools')) {
    recommendations.push(
      'The tracked source-of-truth proposes tool-array changes versus HEAD. Review those removals/additions before any push so user-configured tool access is not silently lost.',
    );
  }
  if (liveDiffFields.has('instructions') || liveDiffFields.has('conversation_starters')) {
    recommendations.push(
      'Live prompt/instruction drift exists. Present the differences to the user and decide whether live or tracked prompt text should win before pushing.',
    );
  }
  if (
    liveDiffFields.has('provider') ||
    liveDiffFields.has('model') ||
    liveDiffFields.has('model_parameters') ||
    liveDiffFields.has('voice_llm_model') ||
    liveDiffFields.has('voice_llm_provider') ||
    liveDiffFields.has('voice_llm_model_parameters') ||
    liveDiffFields.has('voice_fallback_llm_model') ||
    liveDiffFields.has('voice_fallback_llm_provider') ||
    liveDiffFields.has('voice_fallback_llm_model_parameters') ||
    liveDiffFields.has('fallback_llm_model') ||
    liveDiffFields.has('fallback_llm_provider') ||
    liveDiffFields.has('fallback_llm_model_parameters')
  ) {
    recommendations.push(
      'Live model/provider drift exists. Reconcile that explicitly and use --model-config-only only when the reviewed target state is clear.',
    );
  }
  if (liveDiffFields.has('background_cortices')) {
    recommendations.push(
      'Background cortex config drift exists. Reconcile it with --prompts-only or --activation-config-only plus --agent-ids instead of a broad rewrite.',
    );
    const hasMissingLiveFallbacks = liveVsSource?.changedAgents?.some((agentDiff) =>
      agentDiff?.backgroundCortices?.changedAgents?.some((cortexDiff) =>
        Array.isArray(cortexDiff?.activationChangedFields) &&
        cortexDiff.activationChangedFields.includes('fallbacks'),
      ),
    );
    if (hasMissingLiveFallbacks) {
      recommendations.push(
        'Live cortex activation is missing reviewed fallback changes on at least one agent. Propagate them with --prompts-only or --activation-config-only plus --activation-fields=fallbacks before relying on classifier failover.',
      );
    }
  }

  if ((workingTreeVsHead?.diffCount || 0) > 0) {
    recommendations.push(
      `The tracked source-of-truth file has local repo changes for ${workingTreeVsHead.diffCount} agent(s) versus HEAD. Treat those as proposed changes (C) and compare them against live user drift (A) before any sync.`,
    );
  } else {
    recommendations.push('The tracked source-of-truth file has no local repo drift versus HEAD.');
  }

  if ((adjacentLibrechat?.liveVsSource?.diffCount || 0) > 0) {
    recommendations.push(
      `Adjacent librechat config differs from tracked source-of-truth for ${adjacentLibrechat.liveVsSource.diffCount} reviewed field(s). Review runtime toggles before assuming the agent bundle alone explains the behavior.`,
    );
  }
  if ((adjacentLibrechat?.workingTreeVsHead?.diffCount || 0) > 0) {
    recommendations.push(
      `The tracked librechat scaffold has local repo changes for ${adjacentLibrechat.workingTreeVsHead.diffCount} reviewed field(s) versus HEAD. Treat those as proposed adjacent-config changes (C) too.`,
    );
  }
  if (
    adjacentLiveDiffFields.has('interface.webSearch') ||
    adjacentWorkingDiffFields.has('interface.webSearch') ||
    adjacentLiveDiffFields.has('webSearch') ||
    adjacentWorkingDiffFields.has('webSearch')
  ) {
    recommendations.push(
      'Web search capability drift exists in adjacent librechat config. Review both interface.webSearch and the top-level webSearch block before concluding that the agent tool array is the only problem.',
    );
  }

  recommendations.push(
    'Recommended flow: pull/compare, show A/B/C diffs to the user, choose the narrowest push mode with --agent-ids when possible, dry-run, apply, pull again, and verify the resulting live bundle.',
  );

  return recommendations;
}

function readViventiumConfig() {
  const configPath = path.join(ROOT_DIR, 'librechat.yaml');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const contents = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(contents);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (!parsed.viventium) {
      return null;
    }
    return parsed.viventium;
  } catch (err) {
    return { error: `Failed to parse librechat.yaml: ${err.message}` };
  }
}

async function resolveMainAgent({ agentId, userId }) {
  let agent = await Agent.findOne({ id: agentId }).lean();
  if (agent) {
    return agent;
  }
  agent = await Agent.findOne({
    author: userId,
    category: 'viventium',
    name: { $regex: /viventium/i },
  }).lean();
  return agent;
}

async function pullBundle({ email, agentId, outPath, format }) {
  const connectDb = loadConnectDb();
  await connectDb();
  const user = await resolveSyncUser({ explicitEmail: email, agentId });
  if (!user) {
    throw new Error(
      `User not found for email/agent context: ${email || agentId}. ` +
        'Use --email=... when the main agent cannot be resolved automatically.',
    );
  }
  const resolvedEmail = user.email;

  const mainAgent = await resolveMainAgent({ agentId, userId: user._id });
  if (!mainAgent) {
    throw new Error(`Main agent not found for id: ${agentId}`);
  }

  const backgroundIds = Array.isArray(mainAgent.background_cortices)
    ? Array.from(new Set(mainAgent.background_cortices.map((entry) => entry.agent_id).filter(Boolean)))
    : [];

  const backgroundAgents = backgroundIds.length
    ? await Agent.find({ id: { $in: backgroundIds } }).lean()
    : [];
  const backgroundById = new Map(backgroundAgents.map((agent) => [agent.id, agent]));

  const warnings = [];
  for (const id of backgroundIds) {
    if (!backgroundById.has(id)) {
      warnings.push(`Background agent missing: ${id}`);
    }
  }

  const bundle = {
    meta: {
      version: 1,
      exportedAt: new Date().toISOString(),
      user: { email: resolvedEmail, id: user._id.toString() },
      mainAgentId: mainAgent.id,
    },
    config: {
      viventium: readViventiumConfig(),
    },
    mainAgent: pickAgentFields(mainAgent),
    backgroundAgents: backgroundIds.map((id) => {
      const agent = backgroundById.get(id);
      if (!agent) {
        return { id, missing: true };
      }
      return pickAgentFields(agent);
    }),
    warnings,
  };

  ensureDirForFile(outPath);
  const actualFormat = writeBundle(outPath, format, bundle);
  return {
    outPath,
    format: actualFormat,
    backgroundCount: backgroundIds.length,
    warnings,
    userEmail: resolvedEmail,
    userId: user._id.toString(),
    sourceOfTruth: null,
  };
}

/**
 * Safely merge background_cortices by updating only the selected activation fields.
 * Does NOT change agent_id references or unrelated top-level agent settings.
 */
function mergeBackgroundCorticesActivationFields(
  existingCortices,
  newCortices,
  activationFields,
  selectedAgentIds = null,
) {
  if (!Array.isArray(existingCortices) || !Array.isArray(newCortices)) {
    return existingCortices; // Keep existing if either is invalid
  }

  const newByAgentId = new Map(newCortices.map((c) => [c.agent_id, c]));
  const selectedIdSet =
    Array.isArray(selectedAgentIds) && selectedAgentIds.length > 0
      ? new Set(selectedAgentIds)
      : null;

  return existingCortices.map((existing) => {
    if (selectedIdSet && !selectedIdSet.has(existing.agent_id)) {
      return existing;
    }

    const updated = newByAgentId.get(existing.agent_id);
    if (!updated || !updated.activation) {
      return existing; // Keep unchanged if no update provided
    }

    const mergedActivation = {
      ...(existing.activation || {}),
    };
    for (const field of activationFields || []) {
      if (Object.prototype.hasOwnProperty.call(updated.activation, field)) {
        mergedActivation[field] = updated.activation[field];
      }
    }

    return {
      ...existing,
      activation: mergedActivation,
    };
  });
}

function buildUpdateData(
  agentData,
  {
    promptsOnly = false,
    activationConfigOnly = false,
    modelConfigOnly = false,
    activationFields = null,
    existingAgent = null,
    selectedAgentIds = null,
  } = {},
) {
  const updateData = {};
  const fieldsToUse = promptsOnly
    ? PROMPTS_ONLY_FIELDS
    : activationConfigOnly
      ? ['background_cortices']
      : modelConfigOnly
        ? MODEL_CONFIG_ONLY_FIELDS
      : AGENT_FIELDS;
  const safeActivationFields = resolveSafeActivationFields({
    promptsOnly,
    activationConfigOnly,
    activationFields,
  });

  for (const field of fieldsToUse) {
    if (field === 'id') {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(agentData, field)) {
      continue;
    }

    // Special handling for background_cortices in prompts-only mode
    if (field === 'background_cortices' && existingAgent && (promptsOnly || activationConfigOnly)) {
      updateData[field] = mergeBackgroundCorticesActivationFields(
        existingAgent.background_cortices,
        agentData.background_cortices,
        safeActivationFields,
        selectedAgentIds,
      );
      continue;
    }

    updateData[field] = agentData[field];
  }
  return updateData;
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

function shouldRepairRuntimeFieldsForPushMode({
  promptsOnly = false,
  activationConfigOnly = false,
  runtimeAware = false,
}) {
  if (!runtimeAware) {
    return false;
  }
  if (promptsOnly || activationConfigOnly) {
    return false;
  }
  return true;
}

function shouldPushStandaloneBackgroundAgent({
  agentId,
  selectedAgentIds = null,
  activationConfigOnly = false,
}) {
  if (activationConfigOnly) {
    return false;
  }

  if (Array.isArray(selectedAgentIds) && selectedAgentIds.length > 0) {
    return selectedAgentIds.includes(agentId);
  }

  return true;
}

async function pushAgent({
  agentData,
  userId,
  dryRun,
  promptsOnly = false,
  activationConfigOnly = false,
  modelConfigOnly = false,
  runtimeAware = false,
  activationFields = null,
  selectedAgentIds = null,
}) {
  if (!agentData || !agentData.id) {
    return { id: null, status: 'skipped', reason: 'missing agent id' };
  }
  const existing = await Agent.findOne({ id: agentData.id }).lean();
  const shouldRepairRuntimeFields = shouldRepairRuntimeFieldsForPushMode({
    promptsOnly,
    activationConfigOnly,
    runtimeAware,
  });
  /* === VIVENTIUM START ===
   * Feature: Auto-create agents that exist in source-of-truth YAML but not yet in MongoDB.
   * Root cause: --prompts-only push added activation entries to mainAgent.background_cortices
   * but could not create the referenced agent documents, causing "Unknown Agent" in the UI.
   * Fix: When an agent is missing, create it from the YAML data (safe — YAML is canonical).
   * === VIVENTIUM END === */
  if (!existing) {
    if (promptsOnly || activationConfigOnly || modelConfigOnly) {
      const modeLabel = promptsOnly
        ? 'prompts-only'
        : activationConfigOnly
          ? 'activation-config-only'
          : 'model-config-only';
      return {
        id: agentData.id,
        status: 'missing',
        reason: `agent not in DB (${modeLabel} cannot create; run full push once)`,
      };
    }
    const createData = {};
    for (const field of AGENT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(agentData, field)) {
        createData[field] = agentData[field];
      }
    }
    createData.author = userId;
    createData.authorName = (await User.findById(userId, 'name').lean())?.name || '';
    if (dryRun) {
      return { id: agentData.id, status: 'dry-run-create', fieldsSet: Object.keys(createData) };
    }
    const created = await createAgent(createData);
    try {
      const AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry');
      const AccessRole = mongoose.models.AccessRole || mongoose.model('AccessRole');
      const ownerRole = await AccessRole.findOne({ resourceType: 'agent', permBits: 15 }).lean();
      if (ownerRole) {
        await AclEntry.findOneAndUpdate(
          { principalId: userId, resourceType: ResourceType.AGENT, resourceId: created._id },
          {
            principalType: PrincipalType.USER,
            principalModel: PrincipalModel.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId: created._id,
            permBits: ownerRole.permBits,
            roleId: ownerRole._id,
            grantedBy: userId,
            grantedAt: new Date(),
          },
          { upsert: true, new: true },
        );
      }
    } catch (permErr) {
      console.warn(`[pushAgent] Created agent ${agentData.id} but failed to grant ACL:`, permErr.message);
    }
    return {
      id: agentData.id,
      status: 'created',
      fieldsSet: Object.keys(createData),
      runtimeRepair: shouldRepairRuntimeFields
        ? await repairPersistedAgentRuntimeFields({ agentData, dryRun })
        : { repaired: false, reason: 'safe-mode-skipped' },
    };
  }

  const updateData = buildUpdateData(agentData, {
    promptsOnly,
    activationConfigOnly,
    modelConfigOnly,
    activationFields,
    existingAgent: existing,
    selectedAgentIds,
  });
  if (Object.keys(updateData).length === 0) {
    return { id: agentData.id, status: 'skipped', reason: 'no updatable fields' };
  }

  const fieldsUpdated = Object.keys(updateData);
  if (!dryRun) {
    await updateAgent({ id: agentData.id }, updateData, { updatingUserId: userId });
  }
  const runtimeRepair = shouldRepairRuntimeFields
    ? await repairPersistedAgentRuntimeFields({ agentData, dryRun })
    : { repaired: false, reason: 'safe-mode-skipped' };

  return {
    id: agentData.id,
    status: dryRun ? 'dry-run' : 'updated',
    mode: promptsOnly
      ? 'prompts-only'
      : activationConfigOnly
        ? 'activation-config-only'
        : modelConfigOnly
          ? 'model-config-only'
          : 'full',
    fieldsUpdated,
    runtimeRepair,
  };
}

async function pushBundle({
  email,
  inPath,
  dryRun,
  format,
  env = DEFAULT_ENV_SLUG,
  promptsOnly = false,
  activationConfigOnly = false,
  modelConfigOnly = false,
  runtimeAware = false,
  activationFields = null,
  selectedAgentIds = null,
  compareReviewed = false,
}) {
  const connectDb = loadConnectDb();
  await connectDb();

  if (!fs.existsSync(inPath)) {
    throw new Error(`Input file not found: ${inPath}`);
  }

  const bundle = runtimeAware
    ? normalizeBundleForRuntime(loadBundle(inPath, format))
    : loadBundle(inPath, format);
  if (!bundle || !bundle.mainAgent) {
    throw new Error('Invalid bundle: missing mainAgent');
  }
  const compareResult = await compareBundles({
    email,
    agentId: bundle.mainAgent.id || bundle.meta?.mainAgentId || null,
    env,
    sourcePath: inPath,
    format,
  });
  const pushGuardError = buildPushGuardError({
    compareResult,
    dryRun,
    compareReviewed,
  });
  if (pushGuardError) {
    throw new Error(pushGuardError);
  }
  const user = await resolveSyncUser({
    explicitEmail: email,
    agentId: bundle.mainAgent.id || bundle.meta?.mainAgentId || null,
    bundle,
  });
  if (!user) {
    throw new Error(
      `User not found for email/agent context: ${email || bundle.mainAgent.id || bundle.meta?.mainAgentId || 'unknown'}. ` +
        'Use --email=... when the owner cannot be resolved automatically.',
    );
  }

  const results = [];
  const selectedIdSet =
    Array.isArray(selectedAgentIds) && selectedAgentIds.length > 0
      ? new Set(selectedAgentIds)
      : null;
  const mainAgentBackgroundIds = Array.isArray(bundle.mainAgent.background_cortices)
    ? bundle.mainAgent.background_cortices.map((entry) => entry?.agent_id).filter(Boolean)
    : [];
  const shouldPushMainAgent =
    !selectedIdSet ||
    selectedIdSet.has(bundle.mainAgent.id) ||
    ((promptsOnly || activationConfigOnly) &&
      mainAgentBackgroundIds.some((agentId) => selectedIdSet.has(agentId)));

  if (shouldPushMainAgent) {
    results.push(
      await pushAgent({
        agentData: bundle.mainAgent,
        userId: user._id,
        dryRun,
        promptsOnly,
        activationConfigOnly,
        modelConfigOnly,
        runtimeAware,
        activationFields,
        selectedAgentIds,
      }),
    );
  } else {
    results.push({
      id: bundle.mainAgent.id,
      status: 'skipped',
      reason: 'main agent filtered out by --agent-ids',
    });
  }

  if (Array.isArray(bundle.backgroundAgents)) {
    for (const agentData of bundle.backgroundAgents) {
      if (agentData && agentData.missing) {
        results.push({ id: agentData.id || null, status: 'missing', reason: 'marked missing' });
        continue;
      }
      if (
        !shouldPushStandaloneBackgroundAgent({
          agentId: agentData.id,
          selectedAgentIds,
          activationConfigOnly,
        })
      ) {
        results.push({
          id: agentData.id,
          status: 'skipped',
          reason: activationConfigOnly
            ? 'activation-config-only is owned by main agent background_cortices'
            : 'filtered out by --agent-ids',
        });
        continue;
      }
      results.push(
        await pushAgent({
          agentData,
          userId: user._id,
          dryRun,
          promptsOnly,
          activationConfigOnly,
          modelConfigOnly,
          runtimeAware,
          activationFields,
          selectedAgentIds,
        }),
      );
    }
  }

  return {
    inPath,
    mode: promptsOnly
      ? 'prompts-only'
      : activationConfigOnly
        ? 'activation-config-only'
        : modelConfigOnly
          ? 'model-config-only'
          : 'full',
    runtimeAwareApplied: runtimeAware,
    results,
    userId: user._id.toString(),
    selectedAgentIds: selectedAgentIds || [],
  };
}

async function compareBundles({
  email,
  agentId,
  env,
  livePath = null,
  sourcePath = null,
  format,
}) {
  void format;
  const compareInputFormat = null;
  let resolvedLivePath = livePath;
  let livePull = null;

  if (resolvedLivePath) {
    if (!fs.existsSync(resolvedLivePath)) {
      throw new Error(`Live bundle not found: ${resolvedLivePath}`);
    }
  } else {
    resolvedLivePath = resolveDefaultPullOutPath(env);
    livePull = await pullBundle({
      email,
      agentId,
      outPath: resolvedLivePath,
      format: compareInputFormat,
    });
    markLatestRunFromFile(resolvedLivePath);
  }

  const resolvedSourcePath = sourcePath || resolveSourceOfTruthAgentsPath(env);
  const sourceExists = fs.existsSync(resolvedSourcePath);

  const liveBundle = loadBundle(resolvedLivePath, compareInputFormat);
  const sourceBundle = sourceExists ? loadBundle(resolvedSourcePath, compareInputFormat) : null;
  const headBundle = sourceExists ? loadBundleFromGitHead(resolvedSourcePath, compareInputFormat) : null;
  const liveLibrechatPath = path.join(ROOT_DIR, 'librechat.yaml');
  const sourceLibrechatPath = resolveSourceOfTruthLibrechatYamlPath(env);
  const liveLibrechatExists = fs.existsSync(liveLibrechatPath);
  const sourceLibrechatExists = fs.existsSync(sourceLibrechatPath);
  const liveLibrechat = liveLibrechatExists ? loadYamlDocument(liveLibrechatPath) : null;
  const sourceLibrechat = sourceLibrechatExists ? loadYamlDocument(sourceLibrechatPath) : null;
  const headLibrechat = sourceLibrechatExists ? loadBundleFromGitHead(sourceLibrechatPath, 'yaml') : null;

  const liveVsSource = sourceBundle
    ? compareBundlesByAgent({
        leftBundle: liveBundle,
        rightBundle: sourceBundle,
      })
    : {
        totalAgentsCompared: 0,
        diffCount: 0,
        diffs: [],
      };

  const workingTreeVsHead = headBundle
    ? compareBundlesByAgent({
        leftBundle: headBundle,
        rightBundle: sourceBundle,
      })
    : {
        totalAgentsCompared: 0,
        diffCount: 0,
        diffs: [],
      };
  const adjacentLibrechat = {
    livePath: liveLibrechatPath,
    liveExists: liveLibrechatExists,
    sourcePath: sourceLibrechatPath,
    sourceExists: sourceLibrechatExists,
    liveVsSource:
      liveLibrechat && sourceLibrechat
        ? compareNamedFields({
            leftValue: liveLibrechat,
            rightValue: sourceLibrechat,
            fields: LIBRECHAT_REVIEW_FIELDS,
          })
        : {
            totalFieldsCompared: LIBRECHAT_REVIEW_FIELDS.length,
            diffCount: 0,
            diffs: [],
          },
    workingTreeVsHead:
      headLibrechat && sourceLibrechat
        ? compareNamedFields({
            leftValue: headLibrechat,
            rightValue: sourceLibrechat,
            fields: LIBRECHAT_REVIEW_FIELDS,
          })
        : {
            totalFieldsCompared: LIBRECHAT_REVIEW_FIELDS.length,
            diffCount: 0,
            diffs: [],
          },
  };

  return {
    action: 'compare',
    env: sanitizeSlug(env),
    livePath: resolvedLivePath,
    livePull,
    sourcePath: resolvedSourcePath,
    sourceExists,
    liveVsSource,
    workingTreeVsHead,
    adjacentLibrechat,
    recommendations: buildCompareRecommendations({
      liveVsSource,
      workingTreeVsHead,
      sourceExists,
      adjacentLibrechat,
    }),
  };
}

function buildPushGuardError({ compareResult, dryRun, compareReviewed }) {
  if (dryRun || compareReviewed) {
    return null;
  }

  const blockingReasons = [];
  if ((compareResult?.liveVsSource?.diffCount || 0) > 0) {
    blockingReasons.push(
      `${compareResult.liveVsSource.diffCount} live agent diff(s) on reviewed user-managed fields`,
    );
  }
  if ((compareResult?.adjacentLibrechat?.liveVsSource?.diffCount || 0) > 0) {
    blockingReasons.push(
      `${compareResult.adjacentLibrechat.liveVsSource.diffCount} adjacent librechat config diff(s)`,
    );
  }

  if (!blockingReasons.length) {
    return null;
  }

  return (
    `Push blocked until drift is reviewed: ${blockingReasons.join('; ')}. ` +
    `Run 'node scripts/viventium-sync-agents.js compare --env=${compareResult?.env || DEFAULT_ENV_SLUG}' ` +
    `and re-run push with --compare-reviewed only after presenting A/B/C drift to the user.`
  );
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/viventium-sync-agents.js pull [<output-file>]');
  console.log('  node scripts/viventium-sync-agents.js push [<input-file>]');
  console.log('  node scripts/viventium-sync-agents.js compare');
  console.log('');
  console.log('Options:');
  console.log(
    '  --email=...       User email (optional; otherwise resolve from runtime env or existing main agent)',
  );
  console.log('  --agent-id=...    Main agent id (default: env VIVENTIUM_MAIN_AGENT_ID or agent_viventium_main_95aeb3)');
  console.log('  --env=...         Environment slug for git-tracked source-of-truth files (default: env VIVENTIUM_ENV or "local")');
  console.log(
    '  --out=...         Output path for pull (default: .viventium/artifacts/agents-sync/runs/<timestamp>/viventium-agents.yaml)',
  );
  console.log(
    '  --in=...          Input path for push (default: viventium/source_of_truth/<env>.viventium-agents.yaml if present, else latest agents-sync run, fallback: tmp/viventium-agents.yaml)',
  );
  console.log(
    '  --source=...      Source-of-truth bundle for compare (default: viventium/source_of_truth/<env>.viventium-agents.yaml)',
  );
  console.log(
    '  --live=...        Existing pulled live bundle for compare (default: pull fresh live state to a new agents-sync artifact)',
  );
  console.log('  --file=...        Shortcut to set both --out and --in');
  console.log('  --json            Force JSON format (default is YAML)');
  console.log('  --yaml            Force YAML format');
  console.log('  --mongo-uri=...   Override MONGO_URI for this run');
  console.log('  env: VIVENTIUM_ARTIFACTS_DIR overrides artifacts root (default: <core>/.viventium/artifacts)');
  console.log('  --no-sot          Skip writing git-tracked source-of-truth copies (viventium/source_of_truth/*.yaml)');
  console.log('  --dry-run         Show push results without updating');
  console.log('  --compare-reviewed  Confirm you already reviewed compare output and accept live-vs-source drift');
  console.log(
    '  --prompts-only    Safe merge mode: update prompts/instructions plus any explicitly reviewed activation reliability fields present in the safe allowlist (for example fallbacks); this still changes live failover behavior, so review compare output first',
  );
  console.log('  --activation-config-only  Safe mode: only update background cortex activation config');
  console.log('  --model-config-only  Safe mode: only update agent model/provider fields');
  console.log('  --runtime-aware   Rewrite built-in model/provider fields from canonical runtime env before push');
  console.log('  --raw-source-of-truth  Push raw bundle values without runtime rewrite (disables local default)');
  console.log('  --agent-ids=...   Optional comma-separated background agent ids to update surgically');
  console.log(
    '  --activation-fields=...   Comma-separated activation fields for safe modes (enabled,prompt,confidence_threshold,fallbacks,model,provider,cooldown_ms,max_history,intent_scope)',
  );
  console.log('  --schedules       Also pull/push Scheduling Cortex tasks for this user (via viv-schedule-sync.js)');
  console.log('');
  console.log('Schedules options (with --schedules):');
  console.log('  --schedules-db=...               Path to schedules.db for pull (default: ~/.viventium/scheduling/schedules.db)');
  console.log('  --schedules-out=...              Output file for schedules on pull (default: scheduled_tasks.yaml next to bundle)');
  console.log('  --schedules-in=...               Input file for schedules on push (default: scheduled_tasks.yaml next to bundle)');
  console.log('  --schedules-user-id=...          Override the schedules user_id filter (advanced; default uses Mongo user id)');
  console.log('  --schedules-resolve-users        Add user_email by resolving ids via Mongo (requires MONGO_URI)');
  console.log('  --schedules-mcp-url=...          Scheduling MCP URL for push (streamable-http)');
  console.log('  --schedules-librechat-yaml=...   Deployed librechat.yaml path (to discover scheduling MCP URL)');
  console.log('  --schedules-prune                Delete server tasks not present in input (user-scoped)');
  console.log('  --schedules-create-missing       Recreate missing tasks (new ids) instead of failing');
  console.log('');
  console.log('Safe Push Example:');
  console.log('  node scripts/viventium-sync-agents.js compare --env=local           # Pull live state and review A/B/C drift');
  console.log('  node scripts/viventium-sync-agents.js push --prompts-only --dry-run  # Preview changes');
  console.log('  node scripts/viventium-sync-agents.js push --prompts-only            # Apply prompt changes only');
  console.log(
    '  node scripts/viventium-sync-agents.js push --activation-config-only --activation-fields=prompt,model,provider,intent_scope --dry-run',
  );
  console.log(
    '  node scripts/viventium-sync-agents.js push --model-config-only --dry-run  # Preview provider/model changes only',
  );
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.action) {
    printUsage();
    process.exit(1);
  }

  configureMongoUri(args.mongoUri);

  if (args.action === 'pull') {
    const outPath = args.outPath || resolveDefaultPullOutPath(args.env);
    const result = await pullBundle({
      email: args.email,
      agentId: args.agentId,
      outPath,
      format: args.format,
    });
    markLatestRunFromFile(outPath);

    if (!args.noSourceOfTruth) {
      const bundle = loadBundle(outPath, args.format);
      result.sourceOfTruth = writeSourceOfTruthFiles({ envSlug: args.env, bundle });
    }

    let schedules = null;
    if (args.schedules) {
      const schedulesOut = resolveSchedulesPath({
        baseFilePath: outPath,
        explicitPath: args.schedulesOutPath,
        defaultBasename: 'scheduled_tasks.yaml',
      });
      const schedArgs = [
        'pull',
        `--db=${args.schedulesDbPath}`,
        `--out=${schedulesOut}`,
        `--user-id=${args.schedulesUserId || result.userId}`,
      ];
      if (args.schedulesResolveUsers) {
        schedArgs.push('--resolve-users');
      }
      schedules = runVivScheduleSync(schedArgs);
    }

    console.log(JSON.stringify({ action: 'pull', ...result, schedules }, null, 2));
    return;
  }

  if (args.action === 'compare') {
    const result = await compareBundles({
      email: args.email,
      agentId: args.agentId,
      env: args.env,
      livePath: args.livePath,
      sourcePath: args.sourcePath,
      format: args.format,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.action === 'push') {
    const inPath = args.inPath || resolveDefaultPushInPath(args.env);
    const result = await pushBundle({
      email: args.email,
      inPath,
      dryRun: args.dryRun,
      format: args.format,
      promptsOnly: args.promptsOnly,
      activationConfigOnly: args.activationConfigOnly,
      modelConfigOnly: args.modelConfigOnly,
      runtimeAware: shouldApplyRuntimeOverrides(args),
      activationFields: args.activationFields,
      selectedAgentIds: args.selectedAgentIds,
      env: args.env,
      compareReviewed: args.compareReviewed,
    });

    let schedules = null;
    if (args.schedules) {
      const schedulesIn = resolveSchedulesPath({
        baseFilePath: inPath,
        explicitPath: args.schedulesInPath,
        defaultBasename: 'scheduled_tasks.yaml',
      });

      const schedArgs = [
        'push',
        `--in=${schedulesIn}`,
        `--user-id=${args.schedulesUserId || result.userId}`,
      ];
      if (args.dryRun) {
        schedArgs.push('--dry-run');
      }
      if (args.schedulesPrune) {
        schedArgs.push('--prune');
      }
      if (args.schedulesCreateMissing) {
        schedArgs.push('--create-missing');
      }
      if (args.schedulesMcpUrl) {
        schedArgs.push(`--mcp-url=${args.schedulesMcpUrl}`);
      } else if (args.schedulesLibrechatYamlPath) {
        schedArgs.push(`--librechat-yaml=${args.schedulesLibrechatYamlPath}`);
      } else {
        throw new Error('Using --schedules with push requires --schedules-mcp-url or --schedules-librechat-yaml');
      }
      schedules = runVivScheduleSync(schedArgs);
    }

    console.log(JSON.stringify({ action: 'push', ...result, schedules }, null, 2));
    return;
  }

  printUsage();
  process.exit(1);
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
  buildPushGuardError,
  compareBundles,
  compareBundlesByAgent,
  compareNamedFields,
  isPlaceholderOwnerEmail,
  LIBRECHAT_REVIEW_FIELDS,
  normalizeBundleForSourceOfTruth,
  parseArgs,
  pickAgentFields,
  resolveFormat,
  buildUpdateData,
  mergeBackgroundCorticesActivationFields,
  resolveSafeActivationFields,
  shouldApplyRuntimeOverrides,
  shouldRepairRuntimeFieldsForPushMode,
  shouldPushStandaloneBackgroundAgent,
};
