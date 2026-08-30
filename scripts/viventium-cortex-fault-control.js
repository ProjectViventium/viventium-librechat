#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 deterministic local-QA fault controls.
 * Purpose: Provide a bounded arm/query/clear interface for a future parent CLI hookup.
 * Safety: Authority stays in environment-only mode/token values; output contains only hashed scope.
 * === VIVENTIUM END === */

'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const COMMANDS = new Set(['arm', 'query', 'clear']);
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_SCOPE_PART_LENGTH = 256;
const READ_CHUNK_BYTES = 4 * 1024;
const ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;

function cliError(code) {
  return Object.assign(new Error(code), { code });
}

function parseArgs(argv) {
  const command = String(argv[0] || '').trim();
  if (!COMMANDS.has(command)) throw cliError('fault_control_command_invalid');
  const options = { command, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--scope-fd' || argument.startsWith('--scope-fd=')) {
      if (Object.hasOwn(options, 'scopeFd')) {
        throw cliError('fault_control_arguments_invalid');
      }
      const rawDescriptor =
        argument === '--scope-fd' ? argv[++index] : argument.slice('--scope-fd='.length);
      const descriptor = Number(rawDescriptor);
      if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1024) {
        throw cliError('fault_control_scope_fd_invalid');
      }
      options.scopeFd = descriptor;
    } else if (argument === '--scope-file') {
      if (Object.hasOwn(options, 'scopeFile')) {
        throw cliError('fault_control_arguments_invalid');
      }
      const scopeFile = String(argv[++index] || '').trim();
      if (!scopeFile) throw cliError('fault_control_scope_file_invalid');
      options.scopeFile = scopeFile;
    } else if (argument === '--json') {
      if (options.json) throw cliError('fault_control_arguments_invalid');
      options.json = true;
    } else {
      throw cliError('fault_control_arguments_invalid');
    }
  }
  if (options.scopeFd !== undefined && options.scopeFile) {
    throw cliError('fault_control_scope_channel_conflict');
  }
  if (options.scopeFd === undefined && !options.scopeFile) {
    throw cliError('fault_control_scope_channel_required');
  }
  return options;
}

function exactKeys(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseStrictJson(text) {
  let index = 0;
  const invalid = () => {
    throw cliError('fault_control_scope_document_invalid');
  };
  const whitespace = () => {
    while (index < text.length && [0x09, 0x0a, 0x0d, 0x20].includes(text.charCodeAt(index))) {
      index += 1;
    }
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
          const digits = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) invalid();
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          invalid();
        }
      } else if (character.charCodeAt(0) < 0x20) {
        invalid();
      }
    }
    invalid();
  };
  const value = () => {
    whitespace();
    if (text[index] === '{') return object();
    if (text[index] === '[') return array();
    if (text[index] === '"') {
      stringToken();
      return;
    }
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
    if (text[index] === '}') {
      index += 1;
      return;
    }
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
    if (text[index] === ']') {
      index += 1;
      return;
    }
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

function parseStructuredInput(command, document) {
  const rootKeys = new Set(['schemaVersion', 'scope', 'boundary', 'ttlSeconds']);
  if (!exactKeys(document, rootKeys)) {
    throw cliError('structured input contains unsupported fields');
  }
  const scopeKeys = new Set(['ownerId', 'conversationId', 'parentMessageId']);
  if (document.schemaVersion !== 1 || !exactKeys(document.scope, scopeKeys)) {
    throw cliError('fault_control_scope_document_invalid');
  }
  const normalizePart = (value) =>
    String(value || '')
      .normalize('NFKC')
      .trim();
  const ownerId = normalizePart(document.scope.ownerId);
  const conversationId = normalizePart(document.scope.conversationId);
  const parentMessageId = normalizePart(document.scope.parentMessageId);
  if (
    !ownerId ||
    !conversationId ||
    !parentMessageId ||
    [ownerId, conversationId, parentMessageId].some((value) => value.length > MAX_SCOPE_PART_LENGTH)
  ) {
    throw cliError('fault_control_scope_document_invalid');
  }
  const boundary = normalizePart(document.boundary);
  const input = {
    ownerId,
    conversationId,
    parentMessageId,
    ...(boundary ? { boundary } : {}),
  };
  if (command === 'arm') {
    if (!boundary) throw cliError('fault_control_boundary_required');
    if (document.ttlSeconds !== undefined) {
      const seconds = Number(document.ttlSeconds);
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
        throw cliError('fault_control_ttl_invalid');
      }
      input.expiresInMs = seconds * 1_000;
    }
  } else if (document.ttlSeconds !== undefined) {
    throw cliError('fault_control_ttl_not_allowed');
  }
  return input;
}

function assertPrivateDescriptor(stat) {
  if (!stat?.isFile()) {
    throw cliError('fault_control_scope_channel_invalid');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw cliError('fault_control_scope_channel_not_private');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw cliError('fault_control_scope_channel_not_private');
  }
}

function assertPrivateScopeFile(stat) {
  if (!stat?.isFile() || stat.nlink !== 1) {
    throw cliError('fault_control_scope_channel_invalid');
  }
  assertPrivateDescriptor(stat);
  if ((stat.mode & 0o777) !== 0o600) {
    throw cliError('fault_control_scope_channel_not_private');
  }
}

function sameFileState(left, right) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs,
  );
}

function captureRealPath(pathname) {
  if (!path.isAbsolute(pathname) || path.normalize(pathname) !== pathname) {
    throw cliError('fault_control_scope_channel_invalid');
  }
  const parsed = path.parse(pathname);
  const relative = path.relative(parsed.root, pathname);
  const components = relative.split(path.sep).filter(Boolean);
  if (
    !components.length ||
    components.some((component) => component === '.' || component === '..')
  ) {
    throw cliError('fault_control_scope_channel_invalid');
  }
  const snapshots = [];
  let current = parsed.root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) {
      throw cliError('fault_control_scope_channel_invalid');
    }
    snapshots.push({ pathname: current, stat });
  }
  return snapshots;
}

function assertPathUnchanged(snapshots) {
  for (const snapshot of snapshots) {
    const current = fs.lstatSync(snapshot.pathname);
    if (current.isSymbolicLink() || !sameFileState(snapshot.stat, current)) {
      throw cliError('fault_control_scope_channel_invalid');
    }
  }
}

function readBoundedDescriptor(descriptor, before) {
  if (before.isFile() && (before.size < 1 || before.size > MAX_INPUT_BYTES)) {
    throw cliError('fault_control_scope_document_invalid');
  }
  const chunks = [];
  let total = 0;
  while (total <= MAX_INPUT_BYTES) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_INPUT_BYTES + 1 - total));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) {
      throw cliError('fault_control_scope_document_invalid');
    }
    chunks.push(buffer.subarray(0, count));
  }
  if (total < 1) throw cliError('fault_control_scope_document_invalid');
  const after = fs.fstatSync(descriptor);
  if (!sameFileState(before, after) || (before.isFile() && total !== after.size)) {
    throw cliError('fault_control_scope_channel_invalid');
  }
  return Buffer.concat(chunks, total);
}

function decodeStructuredInput(raw) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return parseStrictJson(content);
  } catch (error) {
    if (error?.code?.startsWith('fault_control_')) throw error;
    throw cliError('fault_control_scope_document_invalid');
  }
}

function readStructuredInput(options) {
  let raw;
  if (options.scopeFile) {
    let descriptor;
    try {
      const snapshots = captureRealPath(options.scopeFile);
      descriptor = fs.openSync(
        options.scopeFile,
        fs.constants.O_RDONLY |
          (fs.constants.O_CLOEXEC || 0) |
          (fs.constants.O_NOFOLLOW || 0) |
          (fs.constants.O_NONBLOCK || 0),
      );
      const before = fs.fstatSync(descriptor);
      assertPrivateScopeFile(before);
      if (!sameFileState(snapshots[snapshots.length - 1].stat, before)) {
        throw cliError('fault_control_scope_channel_invalid');
      }
      raw = readBoundedDescriptor(descriptor, before);
      assertPathUnchanged(snapshots);
    } catch (error) {
      if (error?.code?.startsWith('fault_control_')) throw error;
      throw cliError('fault_control_scope_channel_invalid');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  } else if (options.scopeFd !== undefined) {
    try {
      const before = fs.fstatSync(options.scopeFd);
      assertPrivateDescriptor(before);
      raw = readBoundedDescriptor(options.scopeFd, before);
    } catch (error) {
      if (error?.code?.startsWith('fault_control_')) throw error;
      throw cliError('fault_control_scope_channel_invalid');
    }
  } else {
    throw cliError('fault_control_scope_channel_required');
  }
  return parseStructuredInput(options.command, decodeStructuredInput(raw));
}

async function executeCommand(service, options, input) {
  if (options.command === 'arm') {
    return service.arm(input);
  }
  if (options.command === 'query') return service.query(input);
  return service.clear(input);
}

function serializeRedactedResult(result, input, pretty) {
  assertCanonicalResultTimestamps(result);
  const serialized = JSON.stringify(result, null, pretty ? 2 : 0);
  if (
    [input.ownerId, input.conversationId, input.parentMessageId].some(
      (privateValue) => privateValue && serialized.includes(privateValue),
    )
  ) {
    throw cliError('fault_control_output_not_redacted');
  }
  return serialized;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !ISO_MILLIS_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().replace(/Z$/, '+00:00') === value
  );
}

function assertCanonicalResultTimestamps(value, key = '') {
  if (value === null || value === undefined) return;
  if (['armedAt', 'expiresAt', 'purgeAt', 'consumedAt', 'clearedAt', 'at'].includes(key)) {
    if (!canonicalTimestamp(value)) throw cliError('fault_control_timestamp_invalid');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalResultTimestamps(item);
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertCanonicalResultTimestamps(childValue, childKey);
    }
  }
}

function assertScopeAbsentFromArgv(argv, input) {
  const argumentsText = (Array.isArray(argv) ? argv : []).map((value) => String(value));
  if (
    [input.ownerId, input.conversationId, input.parentMessageId].some(
      (privateValue) =>
        privateValue && argumentsText.some((argument) => argument.includes(privateValue)),
    )
  ) {
    throw cliError('fault_control_scope_present_in_argv');
  }
}

function resolveMongoUri(env) {
  const direct = String(env.MONGO_URI || '').trim();
  if (direct) return direct;
  const port = String(env.VIVENTIUM_LOCAL_MONGO_PORT || '').trim();
  const database = String(env.VIVENTIUM_LOCAL_MONGO_DB || '').trim();
  return port && database ? `mongodb://127.0.0.1:${port}/${database}` : '';
}

function usage() {
  return [
    'Usage: node scripts/viventium-cortex-fault-control.js <arm|query|clear> <--scope-fd <private-fd> | --scope-file <0600-file>> [--json]',
    'Exactly one explicit private scope channel is required; redirected stdin is rejected.',
    'Arm input requires scope, boundary, and optional ttlSeconds (1..3600). Query/clear allow optional boundary.',
    'Set VIVENTIUM_LOCAL_QA_MODE=emo_uc_048 and VIVENTIUM_LOCAL_QA_CASE_TOKEN in the environment.',
    'Set MONGO_URI or VIVENTIUM_LOCAL_MONGO_PORT plus VIVENTIUM_LOCAL_MONGO_DB.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const options = parseArgs(argv);
  const input = readStructuredInput(options);
  assertScopeAbsentFromArgv(argv, input);
  const mongoUri = resolveMongoUri(env);
  if (!mongoUri) throw new Error('Mongo connection is not configured');
  const mongoose = require('mongoose');
  const { createModels } = require('@librechat/data-schemas');
  const {
    createLocalQaCortexFaultService,
  } = require('../api/server/services/viventium/LocalQaCortexFaultService');
  try {
    await mongoose.connect(mongoUri);
    const models = createModels(mongoose);
    const service = createLocalQaCortexFaultService({
      ControlModel: models.LocalQaCortexFaultControl,
      UserModel: models.User,
      ConversationModel: models.Conversation,
      MessageModel: models.Message,
      env,
    });
    const result = await executeCommand(service, options, input);
    process.stdout.write(`${serializeRedactedResult(result, input, options.json)}\n`);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = /^([a-z][a-z0-9_]{2,100})$/.test(String(error?.code || ''))
      ? String(error.code)
      : 'fault_control_failed';
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  executeCommand,
  assertCanonicalResultTimestamps,
  assertScopeAbsentFromArgv,
  main,
  parseArgs,
  parseStructuredInput,
  readStructuredInput,
  resolveMongoUri,
  serializeRedactedResult,
  usage,
};
