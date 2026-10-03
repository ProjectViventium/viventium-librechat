/* === VIVENTIUM START === Thin adapter: native published files use the existing File store. === */
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  importNativeOutputFiles,
  createNativeOutputFileFetch,
  nativeResponseOrigin,
  nativeOutputFilePublisherForCarrier,
  createAccountApiRoute,
  normalizeNativeCallbackOutputFiles,
  nativeCallbackOutputFilesForMessage,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { FileContext, mergeFileConfig, getEndpointFileConfig } = require('librechat-data-provider');
const { findFileById, createFile } = require('~/models/File');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');

// The current Telegram document consumer has this existing per-document download bound.
const TELEGRAM_ATTACHMENT_MAX_BYTES = 10_485_760;
function nativeOutputFileLimits(req) {
  const fileConfig = mergeFileConfig(req.config?.fileConfig);
  const endpoint = getEndpointFileConfig({
    fileConfig,
    endpoint: req.body?.endpoint || 'agents',
    endpointType: req.body?.endpointType || 'agents',
  });
  const limits = [fileConfig.serverFileSizeLimit, endpoint.fileSizeLimit];
  if (req._viventiumTelegram === true && req.body?.viventiumSurface === 'telegram')
    limits.push(TELEGRAM_ATTACHMENT_MAX_BYTES);
  if (limits.some((limit) => !Number.isSafeInteger(limit) || limit < 0))
    throw new Error('native_output_file_limit_unavailable');
  if (
    [endpoint.fileLimit, endpoint.totalSizeLimit].some(
      (limit) => !Number.isSafeInteger(limit) || limit < 0,
    )
  )
    throw new Error('native_output_file_limit_unavailable');
  return {
    maxBytes: Math.min(...limits),
    maxFiles: endpoint.fileLimit,
    maxTotalBytes: endpoint.totalSizeLimit,
  };
}
function nativeOutputFileLimit(req) {
  return nativeOutputFileLimits(req).maxBytes;
}
async function prepareNativeOutputFiles(req, envelope, identity, options = {}) {
  if (envelope == null) return [];
  try {
    const artifactBaseURL = process.env.GLASSHIVE_ARTIFACT_BASE_URL || '';
    let fetchFile;
    if (options.route || identity.providerId) {
      const route =
        options.route ||
        (await require('./nativeResponseService').resolveNativeResponseRoute(identity));
      if (identity.originSha256 && nativeResponseOrigin(route.baseURL) !== identity.originSha256)
        throw new Error('native_response_route_changed');
      const requestHash = createHash('sha256')
        .update(identity.requestId || '')
        .digest('hex');
      fetchFile = createNativeOutputFileFetch(route, artifactBaseURL, (observation) => {
        logger.debug('[NativeOutputFileTransport]', { requestHash, ...observation });
      });
    }
    const source = getFileStrategy(req.config || {}, { context: FileContext.message_attachment });
    const { saveBuffer } = getStrategyFunctions(source);
    return await importNativeOutputFiles(envelope, identity, {
      artifactBaseURL,
      ...(fetchFile ? { fetchFile } : {}),
      ...nativeOutputFileLimits(req),
      ...(options.limits || {}),
      recoverUnavailable: true,
      store: {
        find: (fileId) => findFileById(fileId),
        save: async (file, bytes, owner, keys) => {
          if (typeof saveBuffer !== 'function')
            throw Object.assign(new Error('native_output_file_storage_unavailable'), {
              code: 'native_output_file_storage_unavailable',
            });
          const filepath = await saveBuffer({
            userId: owner.userId,
            buffer: bytes,
            fileName: keys.fileId + path.extname(file.filename),
            basePath: 'uploads',
          });
          return createFile(
            {
              _id: keys.objectId,
              user: owner.userId,
              conversationId: owner.conversationId,
              messageId: owner.responseMessageId,
              file_id: keys.fileId,
              filepath,
              bytes: file.bytes,
              filename: file.filename,
              type: file.mime_type,
              source,
              context: FileContext.message_attachment,
              metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
            },
            true,
          );
        },
      },
    });
  } catch {
    return [
      {
        filename: 'File',
        messageId: identity.responseMessageId,
        nativeOutputFile: {
          version: 1,
          status: 'unavailable',
          code: 'native_output_file_unavailable',
        },
      },
    ];
  }
}
async function prepareMissionOutputFiles({ req, rows, message }) {
  const ownerId = String(req.user?.id || '');
  const telegram = rows.some((row) =>
    row.destinations?.some((destination) => destination.surface === 'telegram'),
  );
  const fileRequest = telegram
    ? {
        ...req,
        _viventiumTelegram: true,
        body: { ...req.body, viventiumSurface: 'telegram' },
      }
    : req;
  const limits = nativeOutputFileLimits(fileRequest);
  const route = createAccountApiRoute({ ownerId });
  const attachments = [];
  const seen = new Set();
  let remainingFiles = limits.maxFiles;
  let remainingBytes = limits.maxTotalBytes;
  for (const row of rows) {
    if (!row.outputFiles) continue;
    const source = normalizeNativeCallbackOutputFiles(row.outputFiles, {
      ownerId,
      originRef: row.originRef,
      workRef: row.workRef,
      runId: row.runId,
      attemptId: row.attemptId,
      callbackId: row.terminalCallbackId,
      resultRevision: row.terminalCallbackResultRevision,
      resultDigest: row.terminalCallbackResultDigest,
    });
    const files = source.files.filter((file) => {
      const key = JSON.stringify([file.filename, file.mime_type, file.bytes, file.sha256]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const identity = {
      userId: ownerId,
      conversationId: message.conversationId,
      responseMessageId: message.messageId,
      streamId: message.streamId || message.messageId,
      agentId: message.agent_id,
      logicalTurnId: '',
      revision: 1,
      requestId: source.callback_id,
      runId: source.run_id,
      attemptId: source.attempt_id,
    };
    const envelope = nativeCallbackOutputFilesForMessage({ ...source, files }, identity);
    attachments.push(
      ...(await prepareNativeOutputFiles(fileRequest, envelope, identity, {
        route,
        limits: { ...limits, maxFiles: remainingFiles, maxTotalBytes: remainingBytes },
      })),
    );
    for (const file of files) {
      if (file.bytes > limits.maxBytes || remainingFiles < 1 || file.bytes > remainingBytes)
        continue;
      remainingFiles -= 1;
      remainingBytes -= file.bytes;
    }
  }
  return attachments;
}
async function prepareCurrentNativeOutputFiles(req, carrier, agentId, streamId) {
  const { GenerationJobManager } = require('@librechat/api');
  const context = require('./interactionContext').getTrustedInteractionContext(req);
  const store = GenerationJobManager.getJobStore();
  const job = await store.getJob(streamId);
  if (
    !job ||
    job.userId !== req.user?.id ||
    job.status !== 'running' ||
    !(await store.isCurrentLogicalTurn(streamId))
  )
    return [];
  const conversationId = req._viventiumNativeResponseSource?.conversationId || job.conversationId;
  const responseMessageId =
    req._viventiumNativeResponseSource?.responseMessageId || job.responseMessageId;
  if (
    (context?.conversation_id && context.conversation_id !== conversationId) ||
    (job.interactionContext &&
      (job.interactionContext.logical_turn_id !== context?.logical_turn_id ||
        job.interactionContext.revision !== context?.revision)) ||
    job.responseMessageId !== responseMessageId
  )
    return [];
  const publisher = nativeOutputFilePublisherForCarrier(
    carrier,
    job.nativeResponse || req._viventiumNativeResponseIdentity,
    agentId,
  );
  const identity = {
    userId: req.user.id,
    conversationId,
    responseMessageId,
    streamId,
    agentId,
    logicalTurnId: context?.logical_turn_id || '',
    revision: context?.revision || 1,
    requestId: carrier.requestId,
    ...publisher,
    // First-class initial calls have an immutable host invocation; graph continuations are
    // deliberately unbound after the existing unsupported handoff, and carry an empty id.
    ...(carrier.envelope?.invocation_id && req._viventiumNativeResponseIdentity
      ? { invocationId: req._viventiumNativeResponseIdentity.invocationId }
      : {}),
  };
  if (carrier.error || !publisher)
    return [
      {
        filename: 'File',
        messageId: responseMessageId,
        nativeOutputFile: {
          version: 1,
          status: 'unavailable',
          code: carrier.error ? 'native_output_files_invalid' : 'native_output_file_unavailable',
        },
      },
    ];
  return prepareNativeOutputFiles(req, carrier.envelope, identity);
}
module.exports = {
  nativeOutputFileLimit,
  nativeOutputFileLimits,
  prepareNativeOutputFiles,
  prepareCurrentNativeOutputFiles,
  prepareMissionOutputFiles,
};
/* === VIVENTIUM END === */
