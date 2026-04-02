#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Seed Viventium agents into Mongo for new deployments.
 * Usage:
 *   node scripts/viventium-seed-agents.js --bundle tmp/viventium-agents.yaml [--email=...] [--dry-run]
 * === VIVENTIUM END === */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadLocalRuntimeEnv } = require('./viventium-runtime-env');
const {
  normalizeBundleForRuntime,
  buildCanonicalPersistedAgentFields,
  hasCanonicalPersistedAgentFieldDrift,
} = require('./viventium-agent-runtime-models');

// App Support runtime env is the canonical local runtime source. Component-local env files are
// fallback-only and must not override the active generated runtime profile.
loadLocalRuntimeEnv(ROOT_DIR);
require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });

const yaml = require('js-yaml');
const { connectDb } = require('../api/db/connect');
const { seedDatabase } = require('../api/models');
const { Agent, User } = require('../api/db/models');
const { createAgent, updateAgent } = require('../api/models/Agent');
const { grantPermission } = require('../api/server/services/PermissionService');
const {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
} = require('librechat-data-provider');

const DEFAULT_BUNDLE_PATH = path.join(ROOT_DIR, 'tmp', 'viventium-agents.yaml');
const DEFAULT_AGENT_SEED_OWNER_EMAIL = 'viventium-system@example.com';
const DEFAULT_PUBLIC_ACCESS_ROLE = 'viewer';

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
  'agent_ids',
  'edges',
  'conversation_starters',
  'category',
];
const PRESERVE_EXISTING_EDITABLE_FIELDS = [
  'background_cortices',
];

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
  const normalized = normalizeBundleForRuntime(bundle, { env });
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

function preserveExistingEditableFields(existing, agentData) {
  if (!existing || !agentData) {
    return agentData;
  }

  const merged = deepClone(agentData);
  for (const field of PRESERVE_EXISTING_EDITABLE_FIELDS) {
    if (existing[field] !== undefined) {
      merged[field] = deepClone(existing[field]);
    }
  }
  return merged;
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

async function upsertAgent({ agentData, userId, dryRun }) {
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

  const updateData = buildUpdateData(preserveExistingEditableFields(existing, agentData));
  if (!dryRun && Object.keys(updateData).length > 0) {
    await updateAgent({ id: agentData.id }, updateData, { updatingUserId: userId });
  }
  const runtimeRepair = await repairPersistedAgentRuntimeFields({ agentData, dryRun });
  return {
    id: agentData.id,
    status: dryRun ? 'dry-run' : 'updated',
    resourceId: existing._id,
    runtimeRepair,
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
  const email = args.email || (meta.user && meta.user.email) || '';
  if (!email) {
    throw new Error('Owner email is required (use --email= or bundle.meta.user.email).');
  }

  const mainAgentId = (meta.mainAgentId || bundle.mainAgent.id || '').toString();
  if (!mainAgentId) {
    throw new Error('Bundle missing main agent id.');
  }

  await connectDb();
  await seedDatabase();
  const owner = await ensureUser(email);
  const { normalizedRole: publicAccessRole } = resolvePublicAccessRoleIds(
    process.env.VIVENTIUM_BUILTIN_AGENT_PUBLIC_ROLE,
  );

  const results = [];
  const mainResult = await upsertAgent({
    agentData: bundle.mainAgent,
    userId: owner._id,
    dryRun: args.dryRun,
  });
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
      const result = await upsertAgent({ agentData, userId: owner._id, dryRun: args.dryRun });
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

  const summary = {
    action: 'seed',
    bundle: args.bundlePath,
    owner_email: email,
    main_agent_id: mainAgentId,
    public: args.public,
    public_access_role: args.public ? publicAccessRole : null,
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
  resolvePublicAccessRoleIds,
  preserveExistingEditableFields,
  repairPersistedAgentRuntimeFields,
};
