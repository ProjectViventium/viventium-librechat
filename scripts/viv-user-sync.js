#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Viventium per-user pull/push sync script.
 * Usage:
 *   node scripts/viv-user-sync.js pull --user-email=... --memories --conversations --settings --agents --prompts
 *   node scripts/viv-user-sync.js push --user-email=... --memories --conversations --settings --agents --prompts
 * === VIVENTIUM END === */
'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const ROOT_DIR = path.resolve(__dirname, '..');
const CORE_DIR = path.resolve(ROOT_DIR, '..', '..');
require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });
require('dotenv').config({ path: path.join(ROOT_DIR, '.env.local'), override: true });
require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });
const {
  buildRunDir,
  getLatestRun,
  resolveArtifactsRoot,
  setLatestRun,
} = require('./viv-artifact-paths');

const { AccessRoleIds, PrincipalType, ResourceType } = require('librechat-data-provider');
const { Tokenizer } = require('@librechat/api');
const {
  User,
  Conversation,
  Message,
  Agent,
  Prompt,
  PromptGroup,
  MemoryEntry,
  ConversationTag,
  ToolCall,
} = require('../api/db/models');
const { grantPermission } = require('../api/server/services/PermissionService');

const ARTIFACT_CATEGORY = 'user-sync';
const LEGACY_DEFAULT_BASE_DIR = path.join(ROOT_DIR, 'tmp', 'viv-user-sync');
const DEFAULT_BASE_DIR = LEGACY_DEFAULT_BASE_DIR;
const SECTION_FILES = {
  memories: 'memories.json',
  conversations: 'conversations.json',
  settings: 'settings.json',
  agents: 'agents.json',
  prompts: 'prompts.json',
};

const USER_SETTINGS_FIELDS = [
  'name',
  'username',
  'avatar',
  'personalization',
  'favorites',
  'plugins',
  'termsAccepted',
  'role',
  'provider',
  'emailVerified',
  'idOnTheSource',
];

function loadConnectDb() {
  return require('../api/db/connect').connectDb;
}

function configureMongoUri(mongoUri) {
  if (!mongoUri) {
    return;
  }
  process.env.MONGO_URI = mongoUri;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function sanitizeEmailForPath(email) {
  return normalizeEmail(email).replace(/[^a-z0-9._-]+/g, '_');
}

function resolveBaseDir(dir) {
  if (!dir) {
    return LEGACY_DEFAULT_BASE_DIR;
  }
  return path.isAbsolute(dir) ? dir : path.resolve(ROOT_DIR, dir);
}

function resolveDefaultPullBaseDir() {
  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  return buildRunDir({ artifactsRoot, category: ARTIFACT_CATEGORY });
}

function resolveDefaultPushBaseDir() {
  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  const latest = getLatestRun({ artifactsRoot, category: ARTIFACT_CATEGORY });
  return latest || LEGACY_DEFAULT_BASE_DIR;
}

function markLatestRun(baseDir) {
  const artifactsRoot = resolveArtifactsRoot({ coreDir: CORE_DIR });
  setLatestRun({
    artifactsRoot,
    category: ARTIFACT_CATEGORY,
    runDir: resolveBaseDir(baseDir),
  });
}

function getUserDir(baseDir, email) {
  return path.join(resolveBaseDir(baseDir), sanitizeEmailForPath(email));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pickUserSettings(user) {
  const settings = {};
  for (const field of USER_SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(user, field)) {
      settings[field] = user[field];
    }
  }
  return settings;
}

function resolveSelections(args) {
  const selections = {
    memories: !!args.memories,
    conversations: !!args.conversations,
    settings: !!args.settings,
    agents: !!args.agents,
    prompts: !!args.prompts,
  };
  if (args.all) {
    for (const key of Object.keys(selections)) {
      selections[key] = true;
    }
  }
  const hasSelection = Object.values(selections).some(Boolean);
  return { selections, hasSelection };
}

function parseArgs(argv) {
  const args = {
    action: null,
    userEmail: '',
    baseDir: null,
    inDir: null,
    outDir: null,
    mongoUri: null,
    dryRun: false,
    createUser: false,
    all: false,
    memories: false,
    conversations: false,
    settings: false,
    agents: false,
    prompts: false,
  };

  const readValue = (arg, prefix) => arg.slice(prefix.length);

  for (const arg of argv) {
    if (arg === 'pull' || arg === '--pull') {
      args.action = 'pull';
      continue;
    }
    if (arg === 'push' || arg === '--push') {
      args.action = 'push';
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--create-user') {
      args.createUser = true;
      continue;
    }
    if (arg === '--all') {
      args.all = true;
      continue;
    }
    if (arg === '--memories') {
      args.memories = true;
      continue;
    }
    if (arg === '--conversations') {
      args.conversations = true;
      continue;
    }
    if (arg === '--settings') {
      args.settings = true;
      continue;
    }
    if (arg === '--agents') {
      args.agents = true;
      continue;
    }
    if (arg === '--prompts') {
      args.prompts = true;
      continue;
    }
    if (arg.startsWith('--user-email=')) {
      args.userEmail = readValue(arg, '--user-email=');
      continue;
    }
    if (arg.startsWith('--email=')) {
      args.userEmail = readValue(arg, '--email=');
      continue;
    }
    if (arg.startsWith('--mongo-uri=')) {
      args.mongoUri = readValue(arg, '--mongo-uri=');
      continue;
    }
    if (arg.startsWith('--dir=')) {
      args.baseDir = readValue(arg, '--dir=');
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      args.outDir = readValue(arg, '--out-dir=');
      continue;
    }
    if (arg.startsWith('--in-dir=')) {
      args.inDir = readValue(arg, '--in-dir=');
      continue;
    }
  }

  return args;
}

function toObjectId(value) {
  if (!value) {
    return value;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  if (typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return value;
}

function normalizeObjectIdArray(values) {
  if (!Array.isArray(values)) {
    return values;
  }
  return values.map((value) => toObjectId(value));
}

function stripInternalFields(doc) {
  if (!doc || typeof doc !== 'object') {
    return doc;
  }
  const { _id, __v, ...rest } = doc;
  return rest;
}

function buildOwnerGrantRequests({
  resourceType,
  accessRoleId,
  principalId,
  grantedBy,
  resourceIds = [],
}) {
  const seen = new Set();
  const uniqueIds = [];
  for (const resourceId of resourceIds) {
    if (!resourceId) {
      continue;
    }
    const key = resourceId.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueIds.push(resourceId);
  }
  return uniqueIds.map((resourceId) => ({
    principalType: PrincipalType.USER,
    principalId,
    resourceType,
    resourceId,
    accessRoleId,
    grantedBy,
  }));
}

async function grantOwnerPermissions({
  resourceType,
  accessRoleId,
  principalId,
  grantedBy,
  resourceIds,
  dryRun,
}) {
  const requests = buildOwnerGrantRequests({
    resourceType,
    accessRoleId,
    principalId,
    grantedBy,
    resourceIds,
  });
  if (dryRun || requests.length === 0) {
    return { requested: requests.length, granted: 0 };
  }
  let granted = 0;
  for (const request of requests) {
    await grantPermission(request);
    granted += 1;
  }
  return { requested: requests.length, granted };
}

async function resolveUser({ email, createUser, settings }) {
  const normalizedEmail = normalizeEmail(email);
  let user = await User.findOne({ email: normalizedEmail }).lean();
  if (user) {
    return user;
  }
  if (!createUser) {
    throw new Error(`User not found for email: ${normalizedEmail}`);
  }
  const seed = {
    email: normalizedEmail,
    provider: settings?.provider || 'local',
    emailVerified: settings?.emailVerified ?? true,
  };
  if (settings?.name) {
    seed.name = settings.name;
  }
  if (settings?.username) {
    seed.username = settings.username;
  }
  const created = await User.create(seed);
  return created.toObject ? created.toObject() : created;
}

async function pullUserData({ email, baseDir, selections }) {
  const connectDb = loadConnectDb();
  await connectDb();

  const normalizedEmail = normalizeEmail(email);
  const user = await User.findOne({ email: normalizedEmail }).lean();
  if (!user) {
    throw new Error(`User not found for email: ${normalizedEmail}`);
  }

  const userDir = getUserDir(baseDir, normalizedEmail);
  ensureDir(userDir);

  const meta = {
    version: 1,
    exportedAt: new Date().toISOString(),
    user: {
      email: normalizedEmail,
      id: user._id.toString(),
    },
    sections: Object.keys(selections).filter((key) => selections[key]),
  };
  writeJson(path.join(userDir, 'meta.json'), meta);

  const summary = {
    user: meta.user,
    sections: {},
    outDir: userDir,
  };

  if (selections.settings) {
    const settings = pickUserSettings(user);
    writeJson(path.join(userDir, SECTION_FILES.settings), { settings });
    summary.sections.settings = { count: Object.keys(settings).length };
  }

  if (selections.memories) {
    const memories = await MemoryEntry.find({ userId: user._id }).lean();
    writeJson(path.join(userDir, SECTION_FILES.memories), { memories });
    summary.sections.memories = { count: memories.length };
  }

  if (selections.agents) {
    const agents = await Agent.find({ author: user._id }).lean();
    writeJson(path.join(userDir, SECTION_FILES.agents), { agents });
    summary.sections.agents = { count: agents.length };
  }

  if (selections.prompts) {
    const promptGroups = await PromptGroup.find({ author: user._id }).lean();
    const prompts = await Prompt.find({ author: user._id }).lean();
    writeJson(path.join(userDir, SECTION_FILES.prompts), { promptGroups, prompts });
    summary.sections.prompts = { groupCount: promptGroups.length, promptCount: prompts.length };
  }

  if (selections.conversations) {
    const userId = user._id.toString();
    const conversations = await Conversation.find({ user: userId }).lean();
    const messages = await Message.find({ user: userId }).lean();
    const toolCalls = await ToolCall.find({ user: user._id }).lean();
    const conversationTags = await ConversationTag.find({ user: userId }).lean();
    writeJson(path.join(userDir, SECTION_FILES.conversations), {
      conversations,
      messages,
      toolCalls,
      conversationTags,
    });
    summary.sections.conversations = {
      conversationCount: conversations.length,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      tagCount: conversationTags.length,
    };
  }

  return summary;
}

async function pushUserData({ email, baseDir, selections, dryRun, createUser }) {
  const connectDb = loadConnectDb();
  await connectDb();

  const normalizedEmail = normalizeEmail(email);
  const userDir = getUserDir(baseDir, normalizedEmail);

  const summary = {
    user: {
      email: normalizedEmail,
    },
    sections: {},
    inDir: userDir,
    dryRun: !!dryRun,
  };

  let settingsData = null;
  if (selections.settings) {
    const payload = readJson(path.join(userDir, SECTION_FILES.settings));
    settingsData = payload.settings || {};
  }

  const user = await resolveUser({ email: normalizedEmail, createUser, settings: settingsData });
  const userId = user._id.toString();
  const userObjectId = toObjectId(user._id);
  summary.user.id = userId;

  if (selections.settings) {
    const update = pickUserSettings(settingsData || {});
    if (!dryRun && Object.keys(update).length > 0) {
      await User.updateOne({ _id: userObjectId }, { $set: update });
    }
    summary.sections.settings = { count: Object.keys(update).length };
  }

  if (selections.memories) {
    const payload = readJson(path.join(userDir, SECTION_FILES.memories));
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    const ops = memories
      .filter((entry) => entry && entry.key)
      .map((entry) => {
        // Compute tokenCount from value when missing/zero so Recall UI and budget enforcement work
        const tokenCount =
          typeof entry.tokenCount === 'number' && entry.tokenCount > 0
            ? entry.tokenCount
            : Tokenizer.getTokenCount(entry.value || '', 'o200k_base');
        return {
          updateOne: {
            filter: { userId: userObjectId, key: entry.key },
            update: {
              $set: {
                userId: userObjectId,
                key: entry.key,
                value: entry.value,
                tokenCount,
                updated_at: entry.updated_at ?? new Date().toISOString(),
              },
            },
            upsert: true,
            timestamps: false,
          },
        };
      });
    if (!dryRun && ops.length > 0) {
      await MemoryEntry.bulkWrite(ops);
    }
    summary.sections.memories = { count: memories.length };
  }

  if (selections.agents) {
    const payload = readJson(path.join(userDir, SECTION_FILES.agents));
    const agents = Array.isArray(payload.agents) ? payload.agents : [];
    const ops = agents
      .filter((agent) => agent && agent.id)
      .map((agent) => {
        const sanitized = stripInternalFields(agent);
        sanitized.author = userObjectId;
        sanitized.projectIds = normalizeObjectIdArray(sanitized.projectIds);
        return {
          updateOne: {
            filter: { id: sanitized.id },
            update: { $set: sanitized },
            upsert: true,
            timestamps: false,
          },
        };
      });
    if (!dryRun && ops.length > 0) {
      await Agent.bulkWrite(ops);
    }
    let permissionSummary = { requested: 0, granted: 0 };
    if (agents.length > 0) {
      const agentIds = agents.map((agent) => agent.id).filter(Boolean);
      const agentDocs = await Agent.find({ id: { $in: agentIds } })
        .select('_id id')
        .lean();
      permissionSummary = await grantOwnerPermissions({
        resourceType: ResourceType.AGENT,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        principalId: userObjectId,
        grantedBy: userObjectId,
        resourceIds: agentDocs.map((agent) => agent._id),
        dryRun,
      });
    }
    summary.sections.agents = {
      count: agents.length,
      aclGranted: permissionSummary.granted,
    };
  }

  if (selections.prompts) {
    const payload = readJson(path.join(userDir, SECTION_FILES.prompts));
    const promptGroups = Array.isArray(payload.promptGroups) ? payload.promptGroups : [];
    const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];

    const groupOps = promptGroups
      .filter((group) => group && group._id)
      .map((group) => {
        const groupId = toObjectId(group._id);
        const sanitized = stripInternalFields(group);
        sanitized.author = userObjectId;
        sanitized.productionId = toObjectId(sanitized.productionId);
        sanitized.projectIds = normalizeObjectIdArray(sanitized.projectIds);
        return {
          updateOne: {
            filter: { _id: groupId },
            update: { $set: sanitized, $setOnInsert: { _id: groupId } },
            upsert: true,
            timestamps: false,
          },
        };
      });

    const promptOps = prompts
      .filter((prompt) => prompt && prompt._id)
      .map((prompt) => {
        const promptId = toObjectId(prompt._id);
        const sanitized = stripInternalFields(prompt);
        sanitized.author = userObjectId;
        sanitized.groupId = toObjectId(sanitized.groupId);
        return {
          updateOne: {
            filter: { _id: promptId },
            update: { $set: sanitized, $setOnInsert: { _id: promptId } },
            upsert: true,
            timestamps: false,
          },
        };
      });

    if (!dryRun && groupOps.length > 0) {
      await PromptGroup.bulkWrite(groupOps);
    }
    if (!dryRun && promptOps.length > 0) {
      await Prompt.bulkWrite(promptOps);
    }

    let permissionSummary = { requested: 0, granted: 0 };
    if (promptGroups.length > 0) {
      const groupIds = promptGroups
        .map((group) => group._id)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => toObjectId(id));
      permissionSummary = await grantOwnerPermissions({
        resourceType: ResourceType.PROMPTGROUP,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        principalId: userObjectId,
        grantedBy: userObjectId,
        resourceIds: groupIds,
        dryRun,
      });
    }
    summary.sections.prompts = {
      groupCount: promptGroups.length,
      promptCount: prompts.length,
      aclGranted: permissionSummary.granted,
    };
  }

  if (selections.conversations) {
    const payload = readJson(path.join(userDir, SECTION_FILES.conversations));
    const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
    const conversationTags = Array.isArray(payload.conversationTags) ? payload.conversationTags : [];

    const conversationOps = conversations
      .filter((convo) => convo && convo.conversationId)
      .map((convo) => {
        const sanitized = stripInternalFields(convo);
        delete sanitized.messages;
        sanitized.user = userId;
        return {
          updateOne: {
            filter: { conversationId: sanitized.conversationId, user: userId },
            update: { $set: sanitized },
            upsert: true,
            timestamps: false,
          },
        };
      });

    const messageOps = messages
      .filter((message) => message && message.messageId)
      .map((message) => {
        const sanitized = stripInternalFields(message);
        sanitized.user = userId;
        return {
          updateOne: {
            filter: { messageId: sanitized.messageId, user: userId },
            update: { $set: sanitized },
            upsert: true,
            timestamps: false,
          },
        };
      });

    const toolCallOps = toolCalls
      .filter((toolCall) => toolCall && toolCall._id)
      .map((toolCall) => {
        const toolCallId = toObjectId(toolCall._id);
        const sanitized = stripInternalFields(toolCall);
        sanitized.user = userObjectId;
        return {
          updateOne: {
            filter: { _id: toolCallId },
            update: { $set: sanitized, $setOnInsert: { _id: toolCallId } },
            upsert: true,
            timestamps: false,
          },
        };
      });

    const tagOps = conversationTags
      .filter((tag) => tag && tag.tag)
      .map((tag) => {
        const sanitized = stripInternalFields(tag);
        sanitized.user = userId;
        return {
          updateOne: {
            filter: { tag: sanitized.tag, user: userId },
            update: { $set: sanitized },
            upsert: true,
            timestamps: false,
          },
        };
      });

    if (!dryRun && conversationOps.length > 0) {
      await Conversation.bulkWrite(conversationOps);
    }
    if (!dryRun && messageOps.length > 0) {
      await Message.bulkWrite(messageOps);
    }
    if (!dryRun && toolCallOps.length > 0) {
      await ToolCall.bulkWrite(toolCallOps);
    }
    if (!dryRun && tagOps.length > 0) {
      await ConversationTag.bulkWrite(tagOps);
    }

    if (!dryRun && conversations.length > 0) {
      const conversationIds = conversations.map((convo) => convo.conversationId).filter(Boolean);
      const messageDocs = await Message.find({
        conversationId: { $in: conversationIds },
        user: userId,
      })
        .select('conversationId _id')
        .lean();

      const messageMap = new Map();
      for (const message of messageDocs) {
        if (!messageMap.has(message.conversationId)) {
          messageMap.set(message.conversationId, []);
        }
        messageMap.get(message.conversationId).push(message._id);
      }

      const messageLinkOps = Array.from(messageMap.entries()).map(([conversationId, ids]) => ({
        updateOne: {
          filter: { conversationId, user: userId },
          update: { $set: { messages: ids } },
          timestamps: false,
        },
      }));

      if (messageLinkOps.length > 0) {
        await Conversation.bulkWrite(messageLinkOps);
      }
    }

    summary.sections.conversations = {
      conversationCount: conversations.length,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      tagCount: conversationTags.length,
    };
  }

  return summary;
}

function printUsage() {
  console.log('Usage:');
  console.log(
    '  node scripts/viv-user-sync.js pull --user-email=... --memories --conversations --settings --agents --prompts',
  );
  console.log(
    '  node scripts/viv-user-sync.js push --user-email=... --memories --conversations --settings --agents --prompts',
  );
  console.log('');
  console.log('Options:');
  console.log('  --user-email=...  User email to pull/push');
  console.log('  --all             Sync all sections');
  console.log('  --memories        Sync memories');
  console.log('  --conversations   Sync conversations, messages, tool calls, and tags');
  console.log('  --settings        Sync user settings (safe fields only)');
  console.log('  --agents          Sync user agents');
  console.log('  --prompts         Sync prompt groups and prompts');
  console.log(
    '  --dir=...          Base directory for export/import (default pull: .viventium/artifacts/user-sync/runs/<timestamp>, push: latest run)',
  );
  console.log('  env: VIVENTIUM_ARTIFACTS_DIR overrides artifacts root (default: <core>/.viventium/artifacts)');
  console.log('  --out-dir=...      Base directory for pull');
  console.log('  --in-dir=...       Base directory for push');
  console.log('  --mongo-uri=...    Override MONGO_URI for this run');
  console.log('  --create-user      Create user on push if missing');
  console.log('  --dry-run          Show push summary without writing');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) {
    printUsage();
    process.exit(1);
  }
  if (!args.userEmail) {
    throw new Error('Missing required --user-email');
  }

  const { selections, hasSelection } = resolveSelections(args);
  if (!hasSelection) {
    throw new Error('Select at least one section or use --all');
  }

  configureMongoUri(args.mongoUri);

  if (args.action === 'pull') {
    const baseDir = args.outDir || args.baseDir || resolveDefaultPullBaseDir();
    const result = await pullUserData({
      email: args.userEmail,
      baseDir,
      selections,
    });
    markLatestRun(baseDir);
    console.log(JSON.stringify({ action: 'pull', ...result }, null, 2));
    return;
  }

  if (args.action === 'push') {
    const baseDir = args.inDir || args.baseDir || resolveDefaultPushBaseDir();
    const result = await pushUserData({
      email: args.userEmail,
      baseDir,
      selections,
      dryRun: args.dryRun,
      createUser: args.createUser,
    });
    console.log(JSON.stringify({ action: 'push', ...result }, null, 2));
    return;
  }

  printUsage();
  process.exit(1);
}

async function shutdown(code) {
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
  DEFAULT_BASE_DIR,
  USER_SETTINGS_FIELDS,
  parseArgs,
  resolveSelections,
  sanitizeEmailForPath,
  buildOwnerGrantRequests,
};
