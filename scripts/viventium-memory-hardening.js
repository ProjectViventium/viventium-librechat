#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: Scheduled saved-memory hardening
 *
 * Purpose:
 * - Run semantic memory consolidation as a local operator job, not a user-visible
 *   Scheduling Cortex task.
 * - Let a CLI model propose changes, but keep all database writes inside the
 *   existing LibreChat memory methods and shared Viventium memory policy.
 * - Keep raw proposals and rollback snapshots in local App Support state only.
 *
 * Added: 2026-04-25
 * === VIVENTIUM END === */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const yaml = require('js-yaml');
const mongoose = require('mongoose');
const { createMethods, createModels } = require('@librechat/data-schemas');
const {
  DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
  evaluateMemoryWrite,
  prepareMemoryValueForWrite,
  runMemoryMaintenance,
} = require('@librechat/api');

const VALID_ACTIONS = new Set(['set', 'delete', 'noop']);
const DEFAULT_VALID_KEYS = [
  'core',
  'preferences',
  'world',
  'context',
  'moments',
  'me',
  'working',
  'signals',
  'drafts',
];
const DEFAULT_TOKEN_LIMIT = 8000;
const DEFAULT_MAX_INPUT_CHARS = 500000;

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'dry-run',
    lookbackDays: Number(process.env.VIVENTIUM_MEMORY_HARDENING_LOOKBACK_DAYS || 7),
    minUserIdleMinutes: Number(process.env.VIVENTIUM_MEMORY_HARDENING_MIN_USER_IDLE_MINUTES || 60),
    maxChangesPerUser: Number(process.env.VIVENTIUM_MEMORY_HARDENING_MAX_CHANGES_PER_USER || 3),
    maxInputChars: Number(
      process.env.VIVENTIUM_MEMORY_HARDENING_MAX_INPUT_CHARS || DEFAULT_MAX_INPUT_CHARS,
    ),
    requireFullLookback: parseBool(
      process.env.VIVENTIUM_MEMORY_HARDENING_REQUIRE_FULL_LOOKBACK,
      true,
    ),
    allowDelete: false,
    ignoreIdleGate: false,
    skipModelProbe: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--mode') options.mode = next();
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
    else if (arg === '--mongo-uri') options.mongoUri = next();
    else if (arg.startsWith('--mongo-uri=')) options.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg === '--config-path') options.configPath = next();
    else if (arg.startsWith('--config-path='))
      options.configPath = arg.slice('--config-path='.length);
    else if (arg === '--app-support-dir') options.appSupportDir = next();
    else if (arg.startsWith('--app-support-dir=')) {
      options.appSupportDir = arg.slice('--app-support-dir='.length);
    } else if (arg === '--state-dir') options.stateDir = next();
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length);
    else if (arg === '--run-id') options.runId = next();
    else if (arg.startsWith('--run-id=')) options.runId = arg.slice('--run-id='.length);
    else if (arg === '--user-email') options.userEmail = next();
    else if (arg.startsWith('--user-email=')) options.userEmail = arg.slice('--user-email='.length);
    else if (arg === '--user-id') options.userId = next();
    else if (arg.startsWith('--user-id=')) options.userId = arg.slice('--user-id='.length);
    else if (arg === '--lookback-days') options.lookbackDays = Number(next());
    else if (arg.startsWith('--lookback-days=')) {
      options.lookbackDays = Number(arg.slice('--lookback-days='.length));
    } else if (arg === '--min-user-idle-minutes') options.minUserIdleMinutes = Number(next());
    else if (arg.startsWith('--min-user-idle-minutes=')) {
      options.minUserIdleMinutes = Number(arg.slice('--min-user-idle-minutes='.length));
    } else if (arg === '--max-changes-per-user') options.maxChangesPerUser = Number(next());
    else if (arg.startsWith('--max-changes-per-user=')) {
      options.maxChangesPerUser = Number(arg.slice('--max-changes-per-user='.length));
    } else if (arg === '--max-input-chars') options.maxInputChars = Number(next());
    else if (arg.startsWith('--max-input-chars=')) {
      options.maxInputChars = Number(arg.slice('--max-input-chars='.length));
    } else if (arg === '--provider') options.provider = next();
    else if (arg.startsWith('--provider=')) options.provider = arg.slice('--provider='.length);
    else if (arg === '--model') options.model = next();
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else if (arg === '--proposal-file') options.proposalFile = next();
    else if (arg.startsWith('--proposal-file=')) {
      options.proposalFile = arg.slice('--proposal-file='.length);
    } else if (arg === '--allow-delete') options.allowDelete = true;
    else if (arg === '--ignore-idle-gate') options.ignoreIdleGate = true;
    else if (arg === '--skip-model-probe') options.skipModelProbe = true;
    else if (arg === '--allow-partial-lookback') options.requireFullLookback = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown memory hardening option: ${arg}`);
  }

  return options;
}

function usage() {
  return `Usage:
  node scripts/viventium-memory-hardening.js --mode dry-run [options]
  node scripts/viventium-memory-hardening.js --mode apply [--run-id <id>] [options]
  node scripts/viventium-memory-hardening.js --mode rollback --run-id <id> [options]
  node scripts/viventium-memory-hardening.js --mode status [options]

Options:
  --mongo-uri <uri>                 Active LibreChat Mongo URI
  --config-path <path>              Generated librechat.yaml path
  --app-support-dir <path>          Viventium App Support root
  --user-email <email>              Limit run to one user
  --lookback-days <n>               Default: 7
  --min-user-idle-minutes <n>       Default: 60
  --max-changes-per-user <n>        Default: 3
  --max-input-chars <n>             Default: 500000
  --allow-partial-lookback          Allow oldest messages to be omitted when input cap is hit
  --ignore-idle-gate               Manual QA override only
`;
}

function safeJsonWrite(filePath, payload, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode });
  fs.chmodSync(filePath, mode);
}

function safeJsonlWrite(filePath, events, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    mode,
  });
  fs.chmodSync(filePath, mode);
}

function safeJsonlAppend(filePath, events, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    mode,
  });
  fs.chmodSync(filePath, mode);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function userHash(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

function contentHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

function makeRunId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function resolveStatePaths(options) {
  const appSupportDir =
    options.appSupportDir ||
    process.env.VIVENTIUM_APP_SUPPORT_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Viventium');
  const stateDir =
    options.stateDir ||
    process.env.VIVENTIUM_MEMORY_HARDENING_STATE_DIR ||
    path.join(appSupportDir, 'state', 'memory-hardening');
  return {
    appSupportDir,
    stateDir,
    runsDir: path.join(stateDir, 'runs'),
    lockDir: path.join(stateDir, 'lock'),
  };
}

function acquireLock(lockDir) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    const pidPath = path.join(lockDir, 'pid');
    const existingPid = fs.existsSync(pidPath)
      ? fs.readFileSync(pidPath, 'utf8').trim()
      : 'unknown';
    throw new Error(`Memory hardening lock is already held by pid ${existingPid}`);
  }
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), { mode: 0o600 });
  fs.writeFileSync(path.join(lockDir, 'started_at'), new Date().toISOString(), { mode: 0o600 });
  return () => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  };
}

function loadRuntimeMemoryConfig(configPath) {
  const resolvedPath =
    configPath || process.env.CONFIG_PATH || process.env.VIVENTIUM_GENERATED_LIBRECHAT_YAML;
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return {
      validKeys: DEFAULT_VALID_KEYS,
      keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
      tokenLimit: DEFAULT_TOKEN_LIMIT,
      instructions: '',
      sourcePath: resolvedPath || null,
    };
  }
  const payload = yaml.load(fs.readFileSync(resolvedPath, 'utf8')) || {};
  const memory = payload.memory || {};
  const agent = memory.agent || {};
  return {
    validKeys: Array.isArray(memory.validKeys) ? memory.validKeys : DEFAULT_VALID_KEYS,
    keyLimits: memory.keyLimits || DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
    tokenLimit: memory.tokenLimit || DEFAULT_TOKEN_LIMIT,
    instructions: typeof agent.instructions === 'string' ? agent.instructions : '',
    sourcePath: resolvedPath,
  };
}

function buildHardenerPrompt({
  user,
  memoryConfig,
  memories,
  messages,
  now,
  lookbackDays,
  maxChanges,
}) {
  const memoryByKey = Object.fromEntries(
    memories.map((entry) => [
      entry.key,
      {
        value: entry.value || '',
        tokenCount: entry.tokenCount || 0,
        updated_at: entry.updated_at || entry.updatedAt || null,
      },
    ]),
  );
  const conversationEvidence = messages.map((message) => ({
    messageId: message.messageId,
    conversationId: message.conversationId,
    createdAt: message.createdAt,
    role: message.isCreatedByUser ? 'user' : 'assistant',
    sender: message.sender,
    text: message.text || '',
  }));

  const workpack = {
    now: now.toISOString(),
    userIdHash: userHash(user._id),
    lookbackDays,
    validKeys: memoryConfig.validKeys,
    keyLimits: memoryConfig.keyLimits,
    tokenLimit: memoryConfig.tokenLimit,
    currentMemory: memoryByKey,
    recentConversationMessages: conversationEvidence,
  };

  return `You are Viventium's Memory Hardener, a batch consolidation reviewer for saved memory.

You are NOT in a live conversation. You are reviewing recent conversation history and current saved
memory for one local user. Propose surgical saved-memory edits only when recent evidence shows a
durable gap, contradiction, stale item, or overlong key.

Hard constraints:
- Output JSON only, matching the schema implied by: { "operations": [{ "key", "action", "value", "rationale", "evidence" }] }.
- Valid actions are set, delete, noop.
- Never edit the "working" key in this batch job.
- Do not delete non-empty keys unless the operator explicitly enabled deletion. Prefer set with a compact corrected value.
- Preserve unrelated memory. Do not rewrite a whole key just to change style.
- Keep values token efficient and within the provided per-key budgets.
- Evidence must cite message ids and timestamps, not raw quotes.
- Exclude scheduler/tool operational residue, temporary tool failures, and internal agent chatter.
- Do not invent facts. If evidence is weak, return noop.
- At most ${maxChanges} set/delete operations for this user in this run.

The live Memory Archivist instructions below are imported as the source of key semantics and budget
discipline. Where they mention "THIS conversation" or "current conversation", adapt that to durable
multi-conversation consolidation. The batch hardener rules above override the live instructions.

--- LIVE MEMORY INSTRUCTIONS BEGIN ---
${memoryConfig.instructions || '(no runtime memory instructions found)'}
--- LIVE MEMORY INSTRUCTIONS END ---

--- LOCAL WORKPACK BEGIN ---
${JSON.stringify(workpack)}
--- LOCAL WORKPACK END ---`;
}

function parseCliJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('Model CLI returned empty output');
  const outer = JSON.parse(trimmed);
  if (outer && typeof outer === 'object' && outer.structured_output) return outer.structured_output;
  if (outer && typeof outer === 'object' && typeof outer.result === 'string') {
    const result = outer.result.trim();
    try {
      return JSON.parse(result);
    } catch {
      const start = result.indexOf('{');
      const end = result.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(result.slice(start, end + 1));
      throw new Error('Model CLI result did not contain parseable JSON');
    }
  }
  return outer;
}

function proposalSchema() {
  return {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            action: { type: 'string', enum: ['set', 'delete', 'noop'] },
            value: { type: 'string' },
            rationale: { type: 'string' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  messageId: { type: 'string' },
                  createdAt: { type: 'string' },
                },
                required: ['messageId', 'createdAt'],
                additionalProperties: false,
              },
            },
          },
          required: ['key', 'action', 'rationale', 'evidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  };
}

function normalizeProvider(provider) {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase();
  if (normalized === 'openai' || normalized === 'openai_api' || normalized === 'openai-api') {
    return 'openai';
  }
  if (normalized === 'openai' || normalized === 'openai') return 'openai';
  if (normalized === 'anthropic') return 'anthropic';
  return normalized;
}

function configuredProviders() {
  return [
    process.env.VIVENTIUM_SECONDARY_PROVIDER,
    process.env.VIVENTIUM_PRIMARY_PROVIDER,
    process.env.VIVENTIUM_MEMORY_HARDENING_PROVIDER,
  ]
    .map(normalizeProvider)
    .filter(Boolean);
}

function resolveProvider(options) {
  const explicit = normalizeProvider(
    options.provider || process.env.VIVENTIUM_MEMORY_HARDENING_PROVIDER,
  );
  if (explicit) {
    return {
      provider: explicit,
      model:
        options.model ||
        process.env.VIVENTIUM_MEMORY_HARDENING_MODEL ||
        (explicit === 'anthropic'
          ? process.env.VIVENTIUM_MEMORY_HARDENING_ANTHROPIC_MODEL || 'claude-opus-4-7'
          : process.env.VIVENTIUM_MEMORY_HARDENING_OPENAI_MODEL || 'gpt-5.4'),
    };
  }
  const providers = configuredProviders();
  if (providers.includes('anthropic')) {
    return {
      provider: 'anthropic',
      model: process.env.VIVENTIUM_MEMORY_HARDENING_ANTHROPIC_MODEL || 'claude-opus-4-7',
    };
  }
  if (providers.includes('openai')) {
    return {
      provider: 'openai',
      model: process.env.VIVENTIUM_MEMORY_HARDENING_OPENAI_MODEL || 'gpt-5.4',
    };
  }
  return { provider: '', model: '' };
}

function runCommand(command, args, input, timeoutMs) {
  const result = childProcess.spawnSync(command, args, {
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 32,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || '')
      .split('\n')
      .slice(-8)
      .join('\n');
    throw new Error(`${command} exited ${result.status}: ${stderr}`);
  }
  return result.stdout;
}

function probeModel(provider, model) {
  const prompt = 'Return JSON only: {"ok":true}';
  if (provider === 'anthropic') {
    const output = runCommand(
      'claude',
      [
        '--print',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--model',
        model,
        '--effort',
        'low',
        '--json-schema',
        JSON.stringify({
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        }),
      ],
      prompt,
      120000,
    );
    return parseCliJson(output).ok === true;
  }
  if (provider === 'openai') {
    const output = runCommand(
      'codex',
      ['exec', '--model', model, '--ask-for-approval', 'never', '--sandbox', 'read-only'],
      prompt,
      120000,
    );
    return /"ok"\s*:\s*true|ok.*true/i.test(output);
  }
  return false;
}

function invokeModel({ prompt, provider, model }) {
  if (provider === 'anthropic') {
    const output = runCommand(
      'claude',
      [
        '--print',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--model',
        model,
        '--effort',
        process.env.VIVENTIUM_MEMORY_HARDENING_ANTHROPIC_EFFORT || 'max',
        '--json-schema',
        JSON.stringify(proposalSchema()),
      ],
      prompt,
      Number(process.env.VIVENTIUM_MEMORY_HARDENING_MODEL_TIMEOUT_MS || 900000),
    );
    return parseCliJson(output);
  }
  if (provider === 'openai') {
    const output = runCommand(
      'codex',
      ['exec', '--model', model, '--ask-for-approval', 'never', '--sandbox', 'read-only'],
      `${prompt}\n\nReturn JSON only. No markdown.`,
      Number(process.env.VIVENTIUM_MEMORY_HARDENING_MODEL_TIMEOUT_MS || 900000),
    );
    return parseCliJson(output);
  }
  throw new Error('No supported memory hardening provider is configured');
}

function messageInputCost(message) {
  return String(message.text || '').length + 256;
}

function selectMessagesForPrompt(messages, maxChars) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_INPUT_CHARS;
  let usedChars = 0;
  const selected = [];
  for (const message of messages.slice().reverse()) {
    const cost = messageInputCost(message);
    if (selected.length > 0 && usedChars + cost > cap) break;
    if (selected.length === 0 && cost > cap) {
      selected.push({
        ...message,
        text: String(message.text || '').slice(0, Math.max(cap - 256, 0)),
      });
      usedChars = cap;
      break;
    }
    selected.push(message);
    usedChars += cost;
  }
  return {
    messages: selected.reverse(),
    maxInputChars: cap,
    estimatedInputChars: messages.reduce((total, message) => total + messageInputCost(message), 0),
    selectedInputChars: usedChars,
    omittedMessages: Math.max(messages.length - selected.length, 0),
    complete: selected.length === messages.length,
  };
}

function promptTelemetry({ messages, promptSelection, memories, memoryConfig, prompt }) {
  const conversationIds = new Set(
    messages.map((message) => message.conversationId).filter(Boolean),
  );
  const selectedConversationIds = new Set(
    promptSelection.messages.map((message) => message.conversationId).filter(Boolean),
  );
  const memoryPayload = JSON.stringify(
    memories
      .map((entry) => ({
        key: entry.key,
        value: entry.value || '',
        tokenCount: entry.tokenCount || 0,
      }))
      .sort((left, right) => String(left.key).localeCompare(String(right.key))),
  );
  return {
    memory_instructions_present: Boolean(memoryConfig.instructions),
    memory_instructions_chars: String(memoryConfig.instructions || '').length,
    memory_instructions_hash: contentHash(memoryConfig.instructions || ''),
    valid_key_count: memoryConfig.validKeys.length,
    current_memory_key_count: memories.length,
    current_memory_token_total: memories.reduce(
      (total, entry) => total + Number(entry.tokenCount || 0),
      0,
    ),
    current_memory_hash: contentHash(memoryPayload),
    messages_in_lookback: messages.length,
    messages_fed_to_model: promptSelection.messages.length,
    messages_omitted_for_input_cap: promptSelection.omittedMessages,
    lookback_complete: promptSelection.complete,
    conversation_count_in_lookback: conversationIds.size,
    conversation_count_fed_to_model: selectedConversationIds.size,
    estimated_input_chars: promptSelection.estimatedInputChars,
    selected_input_chars: promptSelection.selectedInputChars,
    max_input_chars: promptSelection.maxInputChars,
    prompt_chars: String(prompt || '').length,
  };
}

function validateProposal({ proposal, memories, memoryConfig, options }) {
  const memoryMap = new Map(memories.map((entry) => [entry.key, entry]));
  const baselineTotalTokens = memories.reduce(
    (total, entry) => total + Number(entry.tokenCount || 0),
    0,
  );
  const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
  const accepted = [];
  const rejected = [];

  for (const [index, operation] of operations.entries()) {
    const op = operation || {};
    const key = String(op.key || '').trim();
    const action = String(op.action || '').trim();
    if (!VALID_ACTIONS.has(action)) {
      rejected.push({ index, key, action, reason: 'invalid_action' });
      continue;
    }
    if (!memoryConfig.validKeys.includes(key)) {
      rejected.push({ index, key, action, reason: 'invalid_key' });
      continue;
    }
    if (key === 'working' && action !== 'noop') {
      rejected.push({ index, key, action, reason: 'working_is_conversation_owned' });
      continue;
    }
    if (action === 'noop') {
      accepted.push({ key, action, rationale: op.rationale || '', evidence: op.evidence || [] });
      continue;
    }
    if (accepted.filter((item) => item.action !== 'noop').length >= options.maxChangesPerUser) {
      rejected.push({ index, key, action, reason: 'max_changes_exceeded' });
      continue;
    }
    if (action === 'delete') {
      if (!options.allowDelete) {
        rejected.push({ index, key, action, reason: 'delete_not_enabled' });
        continue;
      }
      if (!Array.isArray(op.evidence) || op.evidence.length === 0) {
        rejected.push({ index, key, action, reason: 'delete_requires_evidence' });
        continue;
      }
      accepted.push({ key, action, rationale: op.rationale || '', evidence: op.evidence || [] });
      continue;
    }
    const prepared = prepareMemoryValueForWrite({
      key,
      value: String(op.value || ''),
      keyLimits: memoryConfig.keyLimits,
    });
    const previousTokenCount = Number(memoryMap.get(key)?.tokenCount || 0);
    const evaluation = evaluateMemoryWrite({
      key,
      value: prepared.value,
      tokenCount: prepared.tokenCount,
      validKeys: memoryConfig.validKeys,
      tokenLimit: memoryConfig.tokenLimit,
      keyLimits: memoryConfig.keyLimits,
      baselineTotalTokens,
      previousTokenCount,
    });
    if (!prepared.value || !evaluation.ok) {
      rejected.push({
        index,
        key,
        action,
        reason: evaluation.errorType || 'empty_value',
        message: evaluation.message || null,
      });
      continue;
    }
    accepted.push({
      key,
      action,
      value: prepared.value,
      tokenCount: prepared.tokenCount,
      rationale: op.rationale || '',
      evidence: op.evidence || [],
      compacted: prepared.compacted,
    });
  }

  return { accepted, rejected };
}

function redactedUserSummary({
  user,
  status,
  changedKeys = [],
  rejected = [],
  messageCount = 0,
  reason = null,
  telemetry = null,
}) {
  return {
    user_id_hash: userHash(user._id),
    status,
    changed_keys: changedKeys,
    rejected_count: rejected.length,
    message_count: messageCount,
    reason,
    telemetry,
  };
}

async function selectUsers(db, options) {
  const query = {};
  if (options.userEmail) query.email = options.userEmail;
  if (options.userId) query._id = new mongoose.Types.ObjectId(options.userId);
  const users = await db.collection('users').find(query).sort({ createdAt: 1, _id: 1 }).toArray();
  return users.filter((user) => user?.personalization?.memories !== false);
}

async function buildUserProposal({ db, methods, user, options, memoryConfig, now, providerInfo }) {
  const userId = String(user._id);
  const since = new Date(now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000);
  const latestMessage = await db
    .collection('messages')
    .find({ user: userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .next();
  if (
    latestMessage?.createdAt &&
    !options.ignoreIdleGate &&
    now.getTime() - new Date(latestMessage.createdAt).getTime() <
      options.minUserIdleMinutes * 60 * 1000
  ) {
    return {
      status: 'skipped',
      reason: 'recent_activity',
      summary: redactedUserSummary({ user, status: 'skipped', reason: 'recent_activity' }),
      privateProposal: { userIdHash: userHash(user._id), operations: [] },
    };
  }

  const messages = await db
    .collection('messages')
    .find({
      user: userId,
      createdAt: { $gte: since },
      unfinished: { $ne: true },
      error: { $ne: true },
    })
    .project({
      _id: 0,
      messageId: 1,
      conversationId: 1,
      createdAt: 1,
      isCreatedByUser: 1,
      sender: 1,
      text: 1,
    })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  if (messages.length === 0) {
    return {
      status: 'skipped',
      reason: 'no_recent_messages',
      summary: redactedUserSummary({ user, status: 'skipped', reason: 'no_recent_messages' }),
      privateProposal: { userIdHash: userHash(user._id), operations: [] },
    };
  }

  const memories = await methods.getAllUserMemories(user._id);
  const promptSelection = selectMessagesForPrompt(messages, options.maxInputChars);
  if (!promptSelection.complete && options.requireFullLookback) {
    const telemetry = promptTelemetry({
      messages,
      promptSelection,
      memories,
      memoryConfig,
      prompt: '',
    });
    return {
      status: 'skipped',
      reason: 'input_cap_exceeded',
      summary: redactedUserSummary({
        user,
        status: 'skipped',
        reason: 'input_cap_exceeded',
        messageCount: messages.length,
        telemetry,
      }),
      privateProposal: { userIdHash: userHash(user._id), operations: [] },
    };
  }
  let proposal;
  let telemetry;
  if (options.proposalFile) {
    proposal = readJson(options.proposalFile);
    telemetry = promptTelemetry({
      messages,
      promptSelection,
      memories,
      memoryConfig,
      prompt: '',
    });
  } else {
    const prompt = buildHardenerPrompt({
      user,
      memoryConfig,
      memories,
      messages: promptSelection.messages,
      now,
      lookbackDays: options.lookbackDays,
      maxChanges: options.maxChangesPerUser,
    });
    telemetry = promptTelemetry({
      messages,
      promptSelection,
      memories,
      memoryConfig,
      prompt,
    });
    proposal = invokeModel({ prompt, ...providerInfo });
  }
  const validation = validateProposal({ proposal, memories, memoryConfig, options });
  const changedKeys = validation.accepted
    .filter((operation) => operation.action !== 'noop')
    .map((operation) => operation.key);
  return {
    status: 'proposed',
    summary: redactedUserSummary({
      user,
      status: 'proposed',
      changedKeys,
      rejected: validation.rejected,
      messageCount: messages.length,
      telemetry,
    }),
    privateProposal: {
      userIdHash: userHash(user._id),
      userId,
      provider: providerInfo.provider,
      model: providerInfo.model,
      accepted: validation.accepted,
      rejected: validation.rejected,
    },
  };
}

async function applyUserProposal({ methods, userProposal, user, memoryConfig, runDir }) {
  const userId = String(user._id);
  const before = await methods.getAllUserMemories(user._id);
  const rollbackPath = path.join(runDir, `${userProposal.userIdHash}.rollback.private.json`);
  safeJsonWrite(rollbackPath, {
    schemaVersion: 1,
    userIdHash: userProposal.userIdHash,
    createdAt: new Date().toISOString(),
    memories: before.map((entry) => ({
      key: entry.key,
      value: entry.value || '',
      tokenCount: entry.tokenCount || 0,
      updated_at: entry.updated_at || entry.updatedAt || null,
    })),
  });

  const changed = [];
  for (const operation of userProposal.accepted || []) {
    if (operation.action === 'set') {
      await methods.setMemory({
        userId,
        key: operation.key,
        value: operation.value,
        tokenCount: operation.tokenCount,
      });
      changed.push({ key: operation.key, action: 'set', after_tokens: operation.tokenCount });
    } else if (operation.action === 'delete') {
      await methods.deleteMemory({ userId, key: operation.key });
      changed.push({ key: operation.key, action: 'delete' });
    }
  }
  const maintenance = await runMemoryMaintenance({
    userId,
    getAllUserMemories: methods.getAllUserMemories,
    setMemory: methods.setMemory,
    policy: {
      validKeys: memoryConfig.validKeys,
      tokenLimit: memoryConfig.tokenLimit,
      keyLimits: memoryConfig.keyLimits,
    },
  });
  return { changed, maintenanceApplied: maintenance.shouldApply, rollbackPath };
}

async function restoreRollback({ methods, rollback }) {
  const current = await methods.getAllUserMemories(rollback.userId);
  for (const entry of current) {
    await methods.deleteMemory({ userId: rollback.userId, key: entry.key });
  }
  for (const entry of rollback.memories || []) {
    await methods.setMemory({
      userId: rollback.userId,
      key: entry.key,
      value: entry.value || '',
      tokenCount: Number(entry.tokenCount || 0),
    });
  }
}

async function connect(options) {
  const mongoUri = options.mongoUri || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('Missing Mongo URI. Pass --mongo-uri or set MONGO_URI.');
  await mongoose.connect(mongoUri);
  createModels(mongoose);
  return {
    db: mongoose.connection.db,
    methods: createMethods(mongoose),
  };
}

async function runHardening(options) {
  const paths = resolveStatePaths(options);
  const releaseLock = acquireLock(paths.lockDir);
  try {
    const { db, methods } = await connect(options);
    const now = new Date();
    const runId = options.runId || makeRunId(now);
    const runDir = path.join(paths.runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const memoryConfig = loadRuntimeMemoryConfig(options.configPath);
    const providerInfo = resolveProvider(options);
    if (!providerInfo.provider || !providerInfo.model) {
      throw new Error('No launch-ready memory hardening provider is configured');
    }
    if (
      !options.proposalFile &&
      !options.skipModelProbe &&
      !probeModel(providerInfo.provider, providerInfo.model)
    ) {
      throw new Error(`Model probe failed for ${providerInfo.provider}/${providerInfo.model}`);
    }
    const users = await selectUsers(db, options);
    const summaries = [];
    const privateProposals = [];
    for (const user of users) {
      const userProposal = await buildUserProposal({
        db,
        methods,
        user,
        options,
        memoryConfig,
        now,
        providerInfo,
      });
      summaries.push(userProposal.summary);
      privateProposals.push(userProposal.privateProposal);
    }
    safeJsonWrite(path.join(runDir, 'proposal.private.json'), {
      schemaVersion: 1,
      runId,
      createdAt: now.toISOString(),
      provider: providerInfo.provider,
      model: providerInfo.model,
      users: privateProposals,
    });

    const applyResults = [];
    if (options.mode === 'apply') {
      for (const proposal of privateProposals) {
        if (!proposal.userId || !Array.isArray(proposal.accepted)) continue;
        const user = users.find((candidate) => String(candidate._id) === proposal.userId);
        if (!user) continue;
        const result = await applyUserProposal({
          methods,
          userProposal: proposal,
          user,
          memoryConfig,
          runDir,
        });
        applyResults.push({
          user_id_hash: proposal.userIdHash,
          changed: result.changed.map((item) => ({ key: item.key, action: item.action })),
          maintenance_applied: result.maintenanceApplied,
        });
      }
    }

    const summary = {
      schemaVersion: 1,
      run_id: runId,
      mode: options.mode,
      provider: providerInfo.provider,
      model: providerInfo.model,
      started_at: now.toISOString(),
      finished_at: new Date().toISOString(),
      users: summaries,
      apply_results: applyResults,
      private_proposal_file: 'proposal.private.json',
      redacted_log_file: 'run-log.redacted.jsonl',
    };
    safeJsonWrite(path.join(runDir, 'summary.json'), summary, 0o600);
    safeJsonlWrite(path.join(runDir, 'run-log.redacted.jsonl'), [
      {
        event: 'run_started',
        run_id: runId,
        mode: options.mode,
        provider: providerInfo.provider,
        model: providerInfo.model,
        lookback_days: options.lookbackDays,
        require_full_lookback: options.requireFullLookback,
        max_input_chars: options.maxInputChars,
        memory_instructions_present: Boolean(memoryConfig.instructions),
        memory_instructions_chars: String(memoryConfig.instructions || '').length,
        memory_instructions_hash: contentHash(memoryConfig.instructions || ''),
      },
      ...summaries.map((summaryItem) => ({
        event: 'user_processed',
        run_id: runId,
        user_id_hash: summaryItem.user_id_hash,
        status: summaryItem.status,
        reason: summaryItem.reason,
        changed_keys: summaryItem.changed_keys,
        rejected_count: summaryItem.rejected_count,
        telemetry: summaryItem.telemetry,
      })),
      {
        event: 'run_finished',
        run_id: runId,
        mode: options.mode,
        user_count: summaries.length,
        applied_user_count: applyResults.length,
      },
    ]);
    return summary;
  } finally {
    releaseLock();
    await mongoose.disconnect().catch(() => {});
  }
}

async function applyExistingRun(options) {
  const paths = resolveStatePaths(options);
  if (!options.runId) return runHardening({ ...options, mode: 'apply' });
  const releaseLock = acquireLock(paths.lockDir);
  try {
    const { db, methods } = await connect(options);
    const memoryConfig = loadRuntimeMemoryConfig(options.configPath);
    const runDir = path.join(paths.runsDir, options.runId);
    const proposal = readJson(path.join(runDir, 'proposal.private.json'));
    const users = await db.collection('users').find({}).toArray();
    const applyResults = [];
    for (const userProposal of proposal.users || []) {
      const user = users.find((candidate) => userHash(candidate._id) === userProposal.userIdHash);
      if (!user) continue;
      const result = await applyUserProposal({ methods, userProposal, user, memoryConfig, runDir });
      applyResults.push({
        user_id_hash: userProposal.userIdHash,
        changed: result.changed.map((item) => ({ key: item.key, action: item.action })),
        maintenance_applied: result.maintenanceApplied,
      });
    }
    const summaryPath = path.join(runDir, 'summary.json');
    const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : {};
    const nextSummary = {
      ...summary,
      mode: 'apply',
      applied_at: new Date().toISOString(),
      apply_results: applyResults,
      redacted_log_file: 'run-log.redacted.jsonl',
    };
    safeJsonWrite(summaryPath, nextSummary, 0o600);
    safeJsonlAppend(path.join(runDir, 'run-log.redacted.jsonl'), [
      {
        event: 'apply_existing_run',
        run_id: options.runId,
        applied_user_count: applyResults.length,
        apply_results: applyResults,
      },
    ]);
    return nextSummary;
  } finally {
    releaseLock();
    await mongoose.disconnect().catch(() => {});
  }
}

async function rollbackRun(options) {
  if (!options.runId) throw new Error('rollback requires --run-id');
  const paths = resolveStatePaths(options);
  const releaseLock = acquireLock(paths.lockDir);
  try {
    const { db, methods } = await connect(options);
    const runDir = path.join(paths.runsDir, options.runId);
    const rollbackFiles = fs
      .readdirSync(runDir)
      .filter((name) => name.endsWith('.rollback.private.json'))
      .map((name) => path.join(runDir, name));
    const users = await db.collection('users').find({}).toArray();
    const restored = [];
    for (const filePath of rollbackFiles) {
      const rollback = readJson(filePath);
      const user = users.find((candidate) => userHash(candidate._id) === rollback.userIdHash);
      if (!user) continue;
      await restoreRollback({ methods, rollback: { ...rollback, userId: String(user._id) } });
      restored.push(rollback.userIdHash);
    }
    const result = {
      schemaVersion: 1,
      run_id: options.runId,
      restored,
      rolled_back_at: new Date().toISOString(),
    };
    safeJsonWrite(path.join(runDir, 'rollback-summary.json'), result, 0o600);
    return result;
  } finally {
    releaseLock();
    await mongoose.disconnect().catch(() => {});
  }
}

function status(options) {
  const paths = resolveStatePaths(options);
  const runs = fs.existsSync(paths.runsDir)
    ? fs
        .readdirSync(paths.runsDir)
        .filter((name) => fs.existsSync(path.join(paths.runsDir, name, 'summary.json')))
        .sort()
    : [];
  const latest = runs.length
    ? readJson(path.join(paths.runsDir, runs[runs.length - 1], 'summary.json'))
    : null;
  return {
    schemaVersion: 1,
    state_dir: paths.stateDir,
    lock_held: fs.existsSync(paths.lockDir),
    run_count: runs.length,
    latest_run: latest
      ? {
          run_id: latest.run_id,
          mode: latest.mode,
          provider: latest.provider,
          model: latest.model,
          finished_at: latest.finished_at || latest.applied_at || null,
          user_count: Array.isArray(latest.users) ? latest.users.length : 0,
        }
      : null,
  };
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  let result;
  if (options.mode === 'dry-run') result = await runHardening({ ...options, mode: 'dry-run' });
  else if (options.mode === 'apply') result = await applyExistingRun(options);
  else if (options.mode === 'rollback') result = await rollbackRun(options);
  else if (options.mode === 'status') result = status(options);
  else throw new Error(`Unknown memory hardening mode: ${options.mode}`);

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_VALID_KEYS,
  buildHardenerPrompt,
  buildUserProposal,
  parseArgs,
  proposalSchema,
  resolveProvider,
  selectMessagesForPrompt,
  validateProposal,
  userHash,
};
