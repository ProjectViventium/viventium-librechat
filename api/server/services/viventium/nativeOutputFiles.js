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
  nativeFollowUpOutputFilesForMessage,
  nativeOutputFileDescriptorKey,
  mergeVerifiedNativeOutputFileImports,
  retainedNativeOutputFilesForMessage,
  collectGlassHiveNativeMediaReferences,
  selectGlassHiveNativeMediaFiles,
  nativeMediaOutputFilesForMessage,
  resolveGlassHiveNativeMediaMessageSelection,
  bindGlassHiveNativeMediaAttachmentReferences,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
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
    let fetchFile = options.fetchFile;
    if (!fetchFile && (options.route || identity.providerId)) {
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
async function prepareMissionOutputFiles({
  req,
  rows,
  message,
  nativeOutputFiles,
  sourceMessageId,
  selectedNativeMedia = [],
  initialImports = [],
}) {
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
  let route;
  const attachments = [];
  const importedProofs = [];
  const seen = new Set();
  let remainingFiles = limits.maxFiles;
  let remainingBytes = limits.maxTotalBytes;
  const appendImported = (envelope, identity, imported) => {
    const merged = mergeVerifiedNativeOutputFileImports(envelope, identity, imported, seen);
    attachments.push(...merged.attachments);
    importedProofs.push({ envelope, identity, attachments: merged.attachments });
    remainingFiles -= merged.count;
    remainingBytes -= merged.bytes;
  };
  for (const imported of initialImports) {
    appendImported(imported.envelope, imported.identity, imported.attachments);
  }
  if (nativeOutputFiles) {
    try {
      const selected = nativeFollowUpOutputFilesForMessage(nativeOutputFiles, {
        userId: ownerId,
        conversationId: message.conversationId,
        sourceMessageId,
        responseMessageId: message.messageId,
        agentId: message.agent_id,
      });
      const nativeRoute = await require('./nativeResponseService').resolveNativeResponseRoute({
        userId: ownerId,
        agentId: message.agent_id,
        providerId: nativeOutputFiles.publisher.providerId,
      });
      const imported = await prepareNativeOutputFiles(
        fileRequest,
        selected.envelope,
        selected.identity,
        {
          route: nativeRoute,
          limits: { ...limits, maxFiles: remainingFiles, maxTotalBytes: remainingBytes },
        },
      );
      appendImported(selected.envelope, selected.identity, imported);
    } catch {
      attachments.push({
        filename: 'File',
        messageId: message.messageId,
        nativeOutputFile: {
          version: 1,
          status: 'unavailable',
          code: 'native_output_file_unavailable',
        },
      });
    }
  }
  const retained = await prepareRetainedNativeOutputFiles(
    fileRequest,
    {
      userId: ownerId,
      conversationId: message.conversationId,
      responseMessageId: message.messageId,
      agentId: message.agent_id,
    },
    typeof message.text === 'string' ? message.text : '',
    importedProofs,
  );
  for (const imported of retained.imports)
    appendImported(imported.envelope, imported.identity, imported.attachments);
  const mediaFiles = selectGlassHiveNativeMediaFiles(selectedNativeMedia, rows, ownerId);
  for (const row of rows) {
    const selectedFiles = mediaFiles.get(row.terminalCallbackId) || [];
    if (!row.outputFiles && !selectedFiles.length) continue;
    const source =
      row.outputFiles &&
      normalizeNativeCallbackOutputFiles(row.outputFiles, {
        ownerId,
        originRef: row.originRef,
        workRef: row.workRef,
        runId: row.runId,
        attemptId: row.attemptId,
        callbackId: row.terminalCallbackId,
        resultRevision: row.terminalCallbackResultRevision,
        resultDigest: row.terminalCallbackResultDigest,
      });
    const canonicalFiles = source?.files || [];
    // A media link label is an alias of this callback's exact published file, not a second filename.
    const mediaOnlyFiles = selectedFiles.filter(
      (file) =>
        !canonicalFiles.some(
          (canonical) =>
            canonical.download_url === file.download_url &&
            canonical.sha256 === file.sha256 &&
            canonical.bytes === file.bytes &&
            canonical.mime_type === file.mime_type,
        ),
    );
    const files = [...canonicalFiles, ...mediaOnlyFiles].filter(
      (file) => !seen.has(nativeOutputFileDescriptorKey(file)),
    );
    const identity = {
      userId: ownerId,
      conversationId: message.conversationId,
      responseMessageId: message.messageId,
      streamId: message.streamId || message.messageId,
      agentId: message.agent_id,
      logicalTurnId: '',
      revision: 1,
      requestId: source?.callback_id || row.terminalCallbackId,
      runId: source?.run_id || row.runId,
      attemptId: source?.attempt_id || row.attemptId || '',
    };
    const envelope = source
      ? nativeCallbackOutputFilesForMessage({ ...source, files }, identity)
      : nativeMediaOutputFilesForMessage(row, files, identity);
    route ||= createAccountApiRoute({ ownerId });
    const imported = await prepareNativeOutputFiles(fileRequest, envelope, identity, {
      route,
      limits: { ...limits, maxFiles: remainingFiles, maxTotalBytes: remainingBytes },
    });
    appendImported(envelope, identity, imported);
  }
  return retained.authorizePublication
    ? { attachments, authorizePublication: retained.authorizePublication }
    : attachments;
}
async function retainedCallbackOutputSource(row, references, destination, session) {
  if (row.nativeResponse) return undefined;
  const mongoose = require('mongoose');
  const ResultModel = require('~/db/models').GlassHiveTerminalCallbackResult;
  const sources = await mongoose.connection
    .collection('viventium_glasshive_mission_evidence')
    .find(
      {
        ownerId: destination.userId,
        conversationId: destination.conversationId,
        followUpMessageId: row.messageId,
        'outputFiles.files.download_url': { $in: references },
      },
      {
        ...(session ? { session } : {}),
        projection: {
          ownerId: 1,
          conversationId: 1,
          followUpMessageId: 1,
          mainAgentId: 1,
          originRef: 1,
          workRef: 1,
          runId: 1,
          attemptId: 1,
          attemptNumber: 1,
          outputFiles: 1,
          terminalCallbackResultKey: 1,
          terminalCallbackAcceptedOperationId: 1,
          terminalCallbackId: 1,
          terminalCallbackResultRevision: 1,
          terminalCallbackResultDigest: 1,
          terminalCallbackEffectGeneration: 1,
        },
      },
    )
    .toArray();
  for (const source of sources) {
    if (
      source.ownerId !== destination.userId ||
      source.conversationId !== row.conversationId ||
      source.followUpMessageId !== row.messageId ||
      !source.mainAgentId ||
      (row.agent_id && source.mainAgentId !== row.agent_id)
    )
      continue;
    try {
      const files = normalizeNativeCallbackOutputFiles(source.outputFiles, {
        ownerId: source.ownerId,
        originRef: source.originRef,
        workRef: source.workRef,
        runId: source.runId,
        attemptId: source.attemptId,
        callbackId: source.terminalCallbackId,
        resultRevision: source.terminalCallbackResultRevision,
        resultDigest: source.terminalCallbackResultDigest,
      });
      if (!files) continue;
      const identity = {
        userId: destination.userId,
        conversationId: row.conversationId,
        responseMessageId: row.messageId,
        streamId: row.streamId || row.messageId,
        agentId: source.mainAgentId,
        logicalTurnId: '',
        revision: 1,
        requestId: source.terminalCallbackId,
        runId: source.runId,
        attemptId: source.attemptId,
      };
      // The existing callback projection validates the same accepted-operation proof used by media.
      const envelope = nativeMediaOutputFilesForMessage(source, files.files, identity);
      const selector = {
        _id: source.terminalCallbackResultKey,
        ownerId: destination.userId,
        originRef: source.originRef,
        workRef: source.workRef,
        runId: source.runId,
        attemptNumber: source.attemptNumber,
        callbackId: source.terminalCallbackId,
        resultRevision: source.terminalCallbackResultRevision,
        resultDigest: source.terminalCallbackResultDigest,
        acceptedOperationId: source.terminalCallbackAcceptedOperationId,
        acceptedOperationGeneration: source.terminalCallbackEffectGeneration,
      };
      let accepted = ResultModel.findOne(selector);
      if (session) accepted = accepted.session(session);
      if (!(await accepted.lean())) continue;
      return {
        envelope,
        identity,
        sourceDigest: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
        reference: {
          resultKey: source.terminalCallbackResultKey,
          callbackId: source.terminalCallbackId,
          acceptedOperationId: source.terminalCallbackAcceptedOperationId,
          generation: source.terminalCallbackEffectGeneration,
          resultRevision: source.terminalCallbackResultRevision,
          resultDigest: source.terminalCallbackResultDigest,
        },
      };
    } catch {
      continue;
    }
  }
  return undefined;
}
async function prepareRetainedNativeOutputFiles(req, identity, text, initialImports = []) {
  const references = collectGlassHiveNativeMediaReferences(text);
  if (!references.length) return { imports: [] };
  const Message = require('~/db/models').Message;
  const destination = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    responseMessageId: identity.responseMessageId,
    agentId: identity.agentId,
  };
  const selector = {
    user: identity.userId,
    conversationId: identity.conversationId,
    isCreatedByUser: false,
    deletedAt: null,
    'attachments.nativeOutputFile.downloadUrl': { $in: references },
  };
  const rows = await Message.find(selector)
    .select(
      'user conversationId messageId streamId agent_id isCreatedByUser unfinished error deletedAt expiredAt attachments +nativeResponse',
    )
    .lean();
  const limits = nativeOutputFileLimits(req);
  const seen = new Set();
  let count = 0,
    bytes = 0;
  for (const imported of initialImports) {
    const merged = mergeVerifiedNativeOutputFileImports(
      imported.envelope,
      imported.identity,
      imported.attachments,
      seen,
    );
    count += merged.count;
    bytes += merged.bytes;
  }
  const imports = [],
    proofs = [];
  for (const row of rows) {
    const stored = await Promise.all(
      (row.attachments || [])
        .filter((item) => item.file_id)
        .map((item) => findFileById(item.file_id)),
    );
    let selected;
    let callback;
    try {
      callback = await retainedCallbackOutputSource(row, references, destination);
      selected = retainedNativeOutputFilesForMessage(
        row,
        stored.filter(Boolean),
        references,
        destination,
        callback,
      );
    } catch {
      continue;
    }
    if (!selected) continue;
    const byUrl = new Map(
      selected.envelope.files.map((file, index) => [
        file.download_url,
        selected.sourceFiles[index],
      ]),
    );
    const importEnvelope = {
      ...selected.envelope,
      files: selected.envelope.files.filter(
        (file) => !seen.has(nativeOutputFileDescriptorKey(file)),
      ),
    };
    if (!importEnvelope.files.length) continue;
    const fetchFile = async (url) => {
      const source = byUrl.get(url);
      if (!source?.filepath) throw new Error('native_output_files_retained_source_invalid');
      const { getDownloadStream } = getStrategyFunctions(source.source);
      if (!getDownloadStream) throw new Error('native_output_file_storage_unavailable');
      const stream = await getDownloadStream(req, source.filepath);
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': source.type, 'content-length': String(source.bytes) },
      });
    };
    const attachments = await prepareNativeOutputFiles(req, importEnvelope, selected.identity, {
      fetchFile,
      limits: {
        ...limits,
        maxFiles: limits.maxFiles - count,
        maxTotalBytes: limits.maxTotalBytes - bytes,
      },
    });
    const merged = mergeVerifiedNativeOutputFileImports(
      importEnvelope,
      selected.identity,
      attachments,
      seen,
    );
    count += merged.count;
    bytes += merged.bytes;
    imports.push({
      envelope: importEnvelope,
      identity: selected.identity,
      attachments: merged.attachments,
    });
    proofs.push({
      sourceMessageId: selected.sourceMessageId,
      candidateSha256: selected.candidateSha256,
      ...(callback ? { callbackReference: callback.reference } : {}),
      fileIds: selected.sourceFiles.map((file) => file.file_id),
      envelope: selected.envelope,
      fileSources: selected.sourceFiles.map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath,
        source: file.source,
      })),
    });
  }
  return {
    imports,
    ...(proofs.length
      ? {
          authorizePublication: async (session) => {
            for (const proof of proofs) {
              const row = await Message.findOne({
                user: identity.userId,
                conversationId: identity.conversationId,
                messageId: proof.sourceMessageId,
                deletedAt: null,
              })
                .select(
                  'user conversationId messageId streamId agent_id isCreatedByUser unfinished error deletedAt expiredAt attachments +nativeResponse',
                )
                .session(session)
                .lean();
              if (
                !row ||
                (!proof.callbackReference &&
                  row.nativeResponse?.candidateSha256 !== proof.candidateSha256)
              )
                throw new Error('native_output_files_retained_source_invalid');
              const callback = proof.callbackReference
                ? await retainedCallbackOutputSource(row, references, destination, session)
                : undefined;
              if (
                proof.callbackReference &&
                (!callback ||
                  callback.sourceDigest !== proof.candidateSha256 ||
                  JSON.stringify(callback.reference) !== JSON.stringify(proof.callbackReference) ||
                  !(await fenceGlassHiveTerminalCallbackAcceptedOperation({
                    ResultModel: require('~/db/models').GlassHiveTerminalCallbackResult,
                    reference: callback.reference,
                    session,
                  })))
              )
                throw new Error('native_output_files_retained_source_invalid');
              const stored = await Promise.all(
                proof.fileIds.map((fileId) =>
                  require('~/db/models')
                    .File.findOne({
                      file_id: fileId,
                      user: identity.userId,
                      conversationId: identity.conversationId,
                      messageId: proof.sourceMessageId,
                    })
                    .session(session)
                    .lean(),
                ),
              );
              const rechecked = retainedNativeOutputFilesForMessage(
                row,
                stored.filter(Boolean),
                references,
                destination,
                callback,
              );
              if (
                !rechecked ||
                JSON.stringify(rechecked.envelope) !== JSON.stringify(proof.envelope) ||
                JSON.stringify(
                  rechecked.sourceFiles.map((file) => ({
                    file_id: file.file_id,
                    filepath: file.filepath,
                    source: file.source,
                  })),
                ) !== JSON.stringify(proof.fileSources)
              )
                throw new Error('native_output_files_retained_source_invalid');
            }
          },
        }
      : {}),
  };
}
async function prepareNativeResponseOutputFiles(req, response, identity, text) {
  const mongoose = require('mongoose');
  const ResultModel = require('~/db/models').GlassHiveTerminalCallbackResult;
  const selected = await resolveGlassHiveNativeMediaMessageSelection(
    {
      text,
      ownerId: identity.userId,
      conversationId: identity.conversationId,
    },
    {
      readEvidence: (selector) =>
        mongoose.connection
          .collection('viventium_glasshive_mission_evidence')
          .find(selector, {
            projection: {
              ownerId: 1,
              conversationId: 1,
              originRef: 1,
              workRef: 1,
              runId: 1,
              attemptId: 1,
              attemptNumber: 1,
              nativeMedia: 1,
              terminalCallbackResultKey: 1,
              terminalCallbackAcceptedOperationId: 1,
              terminalCallbackId: 1,
              terminalCallbackResultRevision: 1,
              terminalCallbackResultDigest: 1,
              terminalCallbackEffectGeneration: 1,
            },
          })
          .toArray(),
      isAccepted: async (selector) => Boolean(await ResultModel.findOne(selector).lean()),
      fenceAccepted: (reference, session) =>
        fenceGlassHiveTerminalCallbackAcceptedOperation({
          ResultModel,
          reference,
          session,
        }),
    },
  );
  const envelope = response.glasshive?.output_files;
  const imported = await prepareNativeOutputFiles(req, envelope, identity);
  const initialImports = envelope ? [{ envelope, identity, attachments: imported }] : [];
  const preparation = await prepareMissionOutputFiles({
    req,
    rows: selected?.rows || [],
    message: {
      messageId: identity.responseMessageId,
      conversationId: identity.conversationId,
      streamId: identity.streamId,
      agent_id: identity.agentId,
      text,
    },
    selectedNativeMedia: selected?.selectedNativeMedia || [],
    initialImports,
  });
  const attachments = Array.isArray(preparation) ? preparation : preparation.attachments;
  const retainedGuard = Array.isArray(preparation) ? undefined : preparation.authorizePublication;
  if (!selected && !retainedGuard) return attachments;
  return {
    attachments: bindGlassHiveNativeMediaAttachmentReferences(
      text,
      selected?.rows || [],
      attachments,
      identity.userId,
      identity.responseMessageId,
    ),
    authorizePublication: async (session) => {
      if (selected?.authorizePublication) await selected.authorizePublication(session);
      if (retainedGuard) await retainedGuard(session);
    },
  };
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
  prepareNativeResponseOutputFiles,
  prepareRetainedNativeOutputFiles,
  prepareCurrentNativeOutputFiles,
  prepareMissionOutputFiles,
};
/* === VIVENTIUM END === */
