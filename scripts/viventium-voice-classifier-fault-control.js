#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: MPV-061 strict Voice classifier fallback control.
 * Purpose: Give the installed QA parent a bounded private-FD arm/query/approve/clear/cleanup path.
 * Safety: No HTTP/browser surface, argument secret, personal owner, provider remap, or fault flag.
 * === VIVENTIUM END === */

'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const COMMANDS = new Set(['arm', 'query', 'watch', 'receipt', 'approve', 'clear', 'cleanup']);
const MAX_INPUT_BYTES = 16 * 1024;
const READ_CHUNK_BYTES = 4 * 1024;
const SYNTHETIC_EMAIL = /^viventium-voice-qa-mpv-061-[a-z0-9-]{1,80}@example\.com$/;

function cliError(code) {
  return Object.assign(new Error(code), { code });
}

function parseArgs(argv) {
  const command = String(argv[0] || '').trim();
  if (!COMMANDS.has(command)) throw cliError('voice_classifier_fault_command_invalid');
  const options = { command, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--scope-fd' || argument.startsWith('--scope-fd=')) {
      if (Object.hasOwn(options, 'scopeFd')) {
        throw cliError('voice_classifier_fault_arguments_invalid');
      }
      const raw = argument === '--scope-fd' ? argv[++index] : argument.slice('--scope-fd='.length);
      const scopeFd = Number(raw);
      if (!Number.isSafeInteger(scopeFd) || scopeFd < 3 || scopeFd > 1024) {
        throw cliError('voice_classifier_fault_scope_fd_invalid');
      }
      options.scopeFd = scopeFd;
    } else if (argument === '--json') {
      if (options.json) throw cliError('voice_classifier_fault_arguments_invalid');
      options.json = true;
    } else {
      throw cliError('voice_classifier_fault_arguments_invalid');
    }
  }
  if (options.scopeFd === undefined) {
    throw cliError('voice_classifier_fault_private_scope_required');
  }
  return options;
}

function parseStrictJson(text) {
  let index = 0;
  const invalid = () => {
    throw cliError('voice_classifier_fault_scope_invalid');
  };
  const whitespace = () => {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
  };
  const stringToken = () => {
    if (text[index] !== '"') invalid();
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          invalid();
        }
      }
      if (character === '\\') {
        if (index >= text.length) invalid();
        const escape = text[index++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) invalid();
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) invalid();
      } else if (character.charCodeAt(0) < 0x20) invalid();
    }
    invalid();
  };
  const value = () => {
    whitespace();
    if (text[index] === '{') return object();
    if (text[index] === '[') return array();
    if (text[index] === '"') return stringToken();
    const token = text
      .slice(index)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!token) invalid();
    index += token[0].length;
  };
  const object = () => {
    index += 1;
    const keys = new Set();
    whitespace();
    if (text[index] === '}') return void (index += 1);
    while (index < text.length) {
      whitespace();
      const key = stringToken();
      if (keys.has(key)) invalid();
      keys.add(key);
      whitespace();
      if (text[index++] !== ':') invalid();
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === '}') return;
      if (delimiter !== ',') invalid();
    }
    invalid();
  };
  const array = () => {
    index += 1;
    whitespace();
    if (text[index] === ']') return void (index += 1);
    while (index < text.length) {
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === ']') return;
      if (delimiter !== ',') invalid();
    }
    invalid();
  };
  value();
  whitespace();
  if (index !== text.length) invalid();
  try {
    return JSON.parse(text);
  } catch {
    invalid();
  }
}

function exactObject(value, keys) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.size &&
    Object.keys(value).every((key) => keys.has(key)),
  );
}

function assertPrivateDescriptor(stat) {
  if (
    !stat?.isFile() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 1 ||
    stat.size > MAX_INPUT_BYTES
  ) {
    throw cliError('voice_classifier_fault_scope_not_private');
  }
}

function readDocument(descriptor) {
  let before;
  try {
    before = fs.fstatSync(descriptor);
    assertPrivateDescriptor(before);
    const chunks = [];
    let total = 0;
    while (total <= MAX_INPUT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_INPUT_BYTES + 1 - total));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_INPUT_BYTES) throw cliError('voice_classifier_fault_scope_invalid');
      chunks.push(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      total !== after.size
    ) {
      throw cliError('voice_classifier_fault_scope_changed');
    }
    return parseStrictJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)),
    );
  } catch (error) {
    if (String(error?.code || '').startsWith('voice_classifier_fault_')) throw error;
    throw cliError('voice_classifier_fault_scope_invalid');
  }
}

function parseInput(command, document) {
  const rootKeys = {
    arm: new Set(['schemaVersion', 'binding']),
    query: new Set(['schemaVersion', 'controlId']),
    watch: new Set(['schemaVersion', 'controlId']),
    receipt: new Set(['schemaVersion', 'controlId']),
    approve: new Set(['schemaVersion', 'controlId', 'challengeId', 'binding', 'approvalProof']),
    clear: new Set(['schemaVersion', 'binding']),
    cleanup: new Set(['schemaVersion', 'controlId', 'receiptDigest']),
  };
  if (!exactObject(document, rootKeys[command]) || document.schemaVersion !== 1) {
    throw cliError('voice_classifier_fault_scope_invalid');
  }
  return document;
}

function resolveMongoUri(env) {
  const direct = String(env.MONGO_URI || '').trim();
  const fallbackPort = String(env.VIVENTIUM_LOCAL_MONGO_PORT || '').trim();
  const fallbackDatabase = String(env.VIVENTIUM_LOCAL_MONGO_DB || '').trim();
  const selected = direct || `mongodb://127.0.0.1:${fallbackPort}/${fallbackDatabase}`;
  let parsed;
  try {
    parsed = new URL(selected);
  } catch {
    throw cliError('voice_classifier_fault_mongo_invalid');
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (
    parsed.protocol !== 'mongodb:' ||
    !new Set(['127.0.0.1', 'localhost', '::1']).has(host) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.slice(1)
  ) {
    throw cliError('voice_classifier_fault_mongo_invalid');
  }
  return selected;
}

function redactedRow(row, approvalPayload) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    controlId: row.controlId,
    caseId: row.caseId,
    state: row.state,
    sessionRefHash: row.sessionRefHash,
    sessionCandidateDigest: row.sessionCandidateDigest,
    candidateDigest: row.candidateDigest,
    componentArtifactDigest: row.componentArtifactDigest,
    installedArtifactDigest: row.installedArtifactDigest,
    runtimeOwnerBindingHash: row.runtimeOwnerBindingHash,
    ownerScopeHash: row.ownerScopeHash,
    callScopeHash: row.callScopeHash,
    utteranceHash: row.utteranceHash,
    primaryProvider: row.primaryProvider,
    primaryModel: row.primaryModel,
    fallbackProvider: row.fallbackProvider,
    fallbackModel: row.fallbackModel,
    armBindingHash: row.armBindingHash,
    armedAt: row.armedAt,
    expiresAt: row.expiresAt,
    purgeAt: row.purgeAt,
    ...(row.challengeId
      ? {
          challengeId: row.challengeId,
          challengeIssuedAt: row.challengeIssuedAt,
          challengeExpiresAt: row.challengeExpiresAt,
          replayExpiresAt: row.replayExpiresAt,
          turnId: row.turnId,
          segments: row.segments,
          turnScopeHash: row.turnScopeHash,
          segmentSetHash: row.segmentSetHash,
          turnBindingHash: row.turnBindingHash,
          coreProof: row.coreProof,
          approvalPayload,
        }
      : {}),
    ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
    ...(row.consumedAt
      ? {
          consumedAt: row.consumedAt,
          receiptExpiresAt: row.receiptExpiresAt,
          receiptDigest: row.receiptDigest,
        }
      : {}),
    ...(row.clearedAt ? { clearedAt: row.clearedAt } : {}),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const input = parseInput(options.command, readDocument(options.scopeFd));
  const mongoose = require('mongoose');
  const { createModels } = require('@librechat/data-schemas');
  const {
    createMongooseVoiceClassifierFaultControlStore,
    createVoiceClassifierFaultControlManager,
    voiceClassifierFaultApprovalPayload,
  } = require('@librechat/api');
  const createCallSessionModel = require('../api/db/viventiumCallSession');
  await mongoose.connect(resolveMongoUri(env));
  try {
    const models = createModels(mongoose);
    const CallSession = createCallSessionModel(mongoose);
    const store = createMongooseVoiceClassifierFaultControlStore(
      models.LocalQaVoiceClassifierFaultControl,
    );
    const control = createVoiceClassifierFaultControlManager({
      store,
      env,
      verifySyntheticOwner: async ({ ownerId, callSessionId }) => {
        if (!mongoose.isValidObjectId(ownerId)) return false;
        const [owner, call] = await Promise.all([
          models.User.findOne({ _id: ownerId }).select('email name provider createdAt').lean(),
          CallSession.findOne({ callSessionId, userId: ownerId })
            .select('callSessionId userId browserCapabilityScope expiresAt')
            .lean(),
        ]);
        return Boolean(
          owner &&
          call &&
          SYNTHETIC_EMAIL.test(String(owner.email || '')) &&
          owner.name === 'Viventium Voice QA' &&
          owner.provider === 'local' &&
          call.browserCapabilityScope === 'call_browser_v1' &&
          new Date(call.expiresAt).getTime() > Date.now(),
        );
      },
    });
    let result;
    if (options.command === 'arm') result = await control.arm(input.binding);
    else if (options.command === 'approve') result = await control.approve(input);
    else if (options.command === 'clear') result = await control.clear(input.binding);
    else if (options.command === 'cleanup') result = await control.cleanup(input);
    else {
      if (options.command === 'watch' || options.command === 'receipt') {
        const deadline = Date.now() + (options.command === 'watch' ? 62_000 : 15_000);
        const targetStates =
          options.command === 'watch'
            ? new Set(['challenged', 'approved', 'consumed', 'cleared', 'expired'])
            : new Set(['consumed', 'cleared', 'expired']);
        let observed;
        do {
          observed = await store.findByControlId(String(input.controlId || ''));
          if (!observed || targetStates.has(observed.state)) break;
          await new Promise((resolve) => setTimeout(resolve, 15));
        } while (Date.now() < deadline);
        if (!observed || !targetStates.has(observed.state)) {
          throw cliError(`voice_classifier_fault_${options.command}_unavailable`);
        }
        result = redactedRow(
          observed,
          observed.challengeId ? voiceClassifierFaultApprovalPayload(observed) : undefined,
        );
        process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
        return 0;
      }
      const row = await store.findByControlId(String(input.controlId || ''));
      result = redactedRow(
        row,
        row?.challengeId ? voiceClassifierFaultApprovalPayload(row) : undefined,
      );
    }
    process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = /^voice_classifier_[a-z0-9_]{3,100}$/.test(String(error?.code || ''))
      ? String(error.code)
      : 'voice_classifier_fault_failed';
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  parseInput,
  readDocument,
  redactedRow,
  resolveMongoUri,
};
