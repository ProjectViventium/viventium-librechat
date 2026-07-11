#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: Governed scheduled-prompt memory proposal application
 *
 * Purpose:
 * - Apply structured Prompt Workbench scheduled-prompt memory proposals through the same
 *   LibreChat/Viventium memory policy and data methods used by the Memories API.
 * - Keep default mode dry-run, reject duplicate live memory keys before applying, and emit
 *   public-safe summaries/hashes instead of raw memory values.
 *
 * Added: 2026-05-22
 * === VIVENTIUM END === */

const fs = require('fs');
const path = require('path');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const yaml = require('js-yaml');
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const {
  evaluateMemoryWrite,
  prepareMemoryValueForWrite,
  runMemoryMaintenance,
} = require('@librechat/api');

const DEFAULT_LIBRECHAT_YAML = path.resolve(
  __dirname,
  '..',
  'viventium',
  'source_of_truth',
  'local.librechat.yaml',
);

function sha(value) {
  return require('crypto')
    .createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 16);
}

function resolveDefaultMongoUri() {
  if (process.env.MONGO_URI) {
    return process.env.MONGO_URI;
  }
  const port =
    process.env.VIVENTIUM_LOCAL_MONGO_PORT ||
    process.env.VIVENTIUM_MONGO_PORT ||
    process.env.MONGO_PORT ||
    '27117';
  const db =
    process.env.VIVENTIUM_LOCAL_MONGO_DB ||
    process.env.MONGO_DB_NAME ||
    process.env.MONGO_DB ||
    'LibreChatViventium';
  return `mongodb://127.0.0.1:${port}/${db}`;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    mongoUri: resolveDefaultMongoUri(),
    proposal: '',
    userId: '',
    config: DEFAULT_LIBRECHAT_YAML,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--proposal') {
      options.proposal = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--user-id') {
      options.userId = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--mongo-uri') {
      options.mongoUri = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--config') {
      options.config = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/viventium-memory-proposal-apply.js --proposal <file> --user-id <id> [--dry-run|--apply] [--json]',
    '',
    'Proposal schema: {"actions":[{"action":"set","key":"context","value":"..."},{"action":"delete","key":"working"}]}',
  ].join('\n');
}

function loadMemoryPolicy(configPath) {
  let config = {};
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    config = {};
  }
  const memory = config.memory || {};
  return {
    validKeys: Array.isArray(memory.validKeys) ? memory.validKeys : undefined,
    tokenLimit: Number.isFinite(Number(memory.tokenLimit)) ? Number(memory.tokenLimit) : undefined,
    keyLimits:
      memory.keyLimits && typeof memory.keyLimits === 'object' ? memory.keyLimits : undefined,
    maintenanceThresholdPercent: Number.isFinite(Number(memory.maintenanceThresholdPercent))
      ? Number(memory.maintenanceThresholdPercent)
      : undefined,
  };
}

function normalizeProposal(raw) {
  const payload = JSON.parse(fs.readFileSync(raw, 'utf8'));
  const sourceActions = Array.isArray(payload) ? payload : payload.actions;
  if (!Array.isArray(sourceActions)) {
    throw new Error('Proposal must include an actions array.');
  }
  return sourceActions.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Proposal action ${index + 1} must be an object.`);
    }
    const action = String(item.action || item.type || '').trim();
    const key = String(item.key || '').trim();
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!['set', 'delete'].includes(action)) {
      throw new Error(`Proposal action ${index + 1} has unsupported action "${action}".`);
    }
    if (!key) {
      throw new Error(`Proposal action ${index + 1} is missing a key.`);
    }
    if (action === 'set' && !value) {
      throw new Error(`Proposal action ${index + 1} must include a non-empty value.`);
    }
    return { action, key, value, reason: String(item.reason || '').trim() };
  });
}

function duplicateKeys(memories) {
  const seen = new Set();
  const duplicates = new Set();
  for (const memory of memories) {
    const key = typeof memory.key === 'string' ? memory.key.trim() : '';
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return Array.from(duplicates).sort();
}

function duplicateKeyGroups(memories) {
  const byKey = new Map();
  for (const memory of memories) {
    const key = typeof memory.key === 'string' ? memory.key.trim() : '';
    if (!key) continue;
    const rows = byKey.get(key) || [];
    rows.push(memory);
    byKey.set(key, rows);
  }
  return Array.from(byKey.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, rows }));
}

function memoryDateValue(memory) {
  const raw = memory?.updated_at || memory?.updatedAt || 0;
  const value = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(value) ? value : 0;
}

function mergedMemoryValue(rows) {
  const ordered = [...rows].sort((a, b) => memoryDateValue(a) - memoryDateValue(b));
  const seen = new Set();
  const values = [];
  for (const row of ordered) {
    const value = typeof row.value === 'string' ? row.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values.join('\n\n').trim();
}

function duplicateMergePlans(memories, policy = {}) {
  return duplicateKeyGroups(memories).map(({ key, rows }) => {
    const mergedValue = mergedMemoryValue(rows);
    const duplicateTokenTotal = rows.reduce((sum, row) => sum + (Number(row.tokenCount) || 0), 0);
    const prepared = prepareMemoryValueForWrite({
      key,
      value: mergedValue,
      keyLimits: policy.keyLimits,
    });
    const evaluation = evaluateMemoryWrite({
      key,
      value: prepared.value,
      tokenCount: prepared.tokenCount,
      validKeys: policy.validKeys,
      tokenLimit: policy.tokenLimit,
      keyLimits: policy.keyLimits,
      baselineTotalTokens: totalTokens(memories) - duplicateTokenTotal,
      previousTokenCount: 0,
    });
    return {
      key,
      originalCount: rows.length,
      mergedValue: prepared.value,
      mergedTokenCount: prepared.tokenCount,
      mergedValueHash: sha(prepared.value),
      ok: evaluation.ok,
      reason: evaluation.ok ? 'ok' : evaluation.message,
    };
  });
}

function totalTokens(memories) {
  return memories.reduce((sum, memory) => sum + (Number(memory.tokenCount) || 0), 0);
}

async function applyDuplicateMergePlan(plan, methods, userId) {
  let deleted = 0;
  const maxDeletes = plan.originalCount + 5;
  for (let index = 0; index < maxDeletes; index += 1) {
    const current = await methods.getAllUserMemories(userId);
    if (!current.some((memory) => memory.key === plan.key)) break;
    const result = await methods.deleteMemory({ userId, key: plan.key });
    if (!result?.ok) break;
    deleted += 1;
  }
  await methods.setMemory({
    userId,
    key: plan.key,
    value: plan.mergedValue,
    tokenCount: plan.mergedTokenCount,
  });
  return deleted;
}

async function applyProposal(options) {
  if (!options.proposal) {
    throw new Error('Missing --proposal.');
  }
  if (!options.userId) {
    throw new Error('Missing --user-id.');
  }
  if (!options.mongoUri) {
    throw new Error('Missing Mongo URI.');
  }

  await mongoose.connect(options.mongoUri);
  createModels(mongoose);
  const memoryMethods = require('../api/models');
  const policy = loadMemoryPolicy(options.config);
  return applyProposalWithMethods(options, memoryMethods, policy);
}

async function applyProposalWithMethods(
  options,
  memoryMethods,
  policy = loadMemoryPolicy(options.config),
) {
  const actions = normalizeProposal(options.proposal);
  let before = await memoryMethods.getAllUserMemories(options.userId);
  const proposalKeys = new Set(actions.map((action) => action.key));
  const duplicatePlans = duplicateMergePlans(before, policy).filter((plan) =>
    proposalKeys.has(plan.key),
  );
  const rejectedDuplicatePlan = duplicatePlans.find((plan) => !plan.ok);
  if (rejectedDuplicatePlan) {
    return {
      ok: false,
      mode: options.apply ? 'apply' : 'dry-run',
      reason: 'duplicate_memory_merge_rejected',
      duplicateKeys: duplicatePlans.map((plan) => plan.key),
      actionCount: actions.length,
      appliedCount: 0,
      dedupeCount: duplicatePlans.length,
      dedupe: duplicatePlans.map((plan) => ({
        key: plan.key,
        originalCount: plan.originalCount,
        mergedValueHash: plan.mergedValueHash,
        status: plan.ok ? 'would_merge_duplicate_key' : 'rejected_policy',
        reason: plan.reason,
      })),
      actions: actions.map((action) => ({
        action: action.action,
        key: action.key,
        valueHash: action.action === 'set' ? sha(action.value) : null,
        status: 'blocked_duplicate_key_merge',
      })),
    };
  }

  const dedupeResults = [];
  for (const plan of duplicatePlans) {
    let deletedCount = 0;
    if (options.apply) {
      deletedCount = await applyDuplicateMergePlan(plan, memoryMethods, options.userId);
    }
    dedupeResults.push({
      key: plan.key,
      originalCount: plan.originalCount,
      mergedValueHash: plan.mergedValueHash,
      tokenCount: plan.mergedTokenCount,
      deletedCount: options.apply ? deletedCount : 0,
      status: options.apply ? 'merged_duplicate_key' : 'would_merge_duplicate_key',
    });
  }
  if (duplicatePlans.length > 0) {
    before = await memoryMethods.getAllUserMemories(options.userId);
  }

  const results = [];
  for (const action of actions) {
    const memories = await memoryMethods.getAllUserMemories(options.userId);
    const existing = memories.find((memory) => memory.key === action.key);
    if (action.action === 'delete') {
      let deleteResult = null;
      if (options.apply && existing) {
        deleteResult = await memoryMethods.deleteMemory({
          userId: options.userId,
          key: action.key,
          expectedRevision: Number(existing.__v ?? 0),
        });
      }
      results.push({
        action: 'delete',
        key: action.key,
        status: deleteResult?.conflict
          ? 'rejected_revision_conflict'
          : existing
            ? options.apply
              ? 'deleted'
              : 'would_delete'
            : 'already_absent',
      });
      continue;
    }

    const prepared = prepareMemoryValueForWrite({
      key: action.key,
      value: action.value,
      keyLimits: policy.keyLimits,
    });
    const evaluation = evaluateMemoryWrite({
      key: action.key,
      value: prepared.value,
      tokenCount: prepared.tokenCount,
      validKeys: policy.validKeys,
      tokenLimit: policy.tokenLimit,
      keyLimits: policy.keyLimits,
      baselineTotalTokens: totalTokens(memories),
      previousTokenCount: existing?.tokenCount || 0,
    });
    if (!evaluation.ok) {
      results.push({
        action: 'set',
        key: action.key,
        valueHash: sha(prepared.value),
        status: 'rejected_policy',
        reason: evaluation.message,
      });
      continue;
    }
    if (options.apply) {
      const writeResult = await memoryMethods.setMemory({
        userId: options.userId,
        key: action.key,
        value: prepared.value,
        tokenCount: prepared.tokenCount,
        expectedRevision: existing ? Number(existing.__v ?? 0) : null,
      });
      if (writeResult?.conflict) {
        results.push({
          action: 'set',
          key: action.key,
          valueHash: sha(prepared.value),
          status: 'rejected_revision_conflict',
        });
        continue;
      }
    }
    results.push({
      action: 'set',
      key: action.key,
      valueHash: sha(prepared.value),
      tokenCount: prepared.tokenCount,
      status: options.apply
        ? existing
          ? 'updated'
          : 'created'
        : existing
          ? 'would_update'
          : 'would_create',
    });
  }

  const rejected = results.filter((result) => String(result.status || '').startsWith('rejected'));
  if (options.apply && rejected.length === 0) {
    const governedKeys = new Set([...proposalKeys, ...duplicatePlans.map((plan) => plan.key)]);
    await runMemoryMaintenance({
      userId: options.userId,
      getAllUserMemories: async (userId) => memoryMethods.getAllUserMemories(userId),
      setMemory: async ({ userId, key, value, tokenCount, expectedRevision }) => {
        if (!governedKeys.has(key)) {
          return { ok: true, skipped: true, reason: 'outside_proposal_scope' };
        }
        return memoryMethods.setMemory({ userId, key, value, tokenCount, expectedRevision });
      },
      policy,
    });
  }

  return {
    ok: rejected.length === 0,
    mode: options.apply ? 'apply' : 'dry-run',
    reason: rejected.length === 0 ? 'ok' : 'policy_rejected',
    actionCount: actions.length,
    appliedCount: options.apply
      ? results.filter((result) => ['created', 'updated', 'deleted'].includes(result.status)).length
      : 0,
    dedupeCount: duplicatePlans.length,
    dedupe: dedupeResults,
    actions: results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await applyProposal(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `ok=${result.ok} mode=${result.mode} reason=${result.reason} actions=${result.actionCount} applied=${result.appliedCount}`,
      );
    }
    if (!result.ok && options.apply) {
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.message || error).replace(
      /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
      '<mongo-uri>',
    );
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  applyProposal,
  applyProposalWithMethods,
  duplicateKeyGroups,
  duplicateKeys,
  duplicateMergePlans,
  mergedMemoryValue,
  normalizeProposal,
  parseArgs,
};
