/* === VIVENTIUM START === Thin adapter for the typed GlassHive work-action service. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  createGlassHiveWorkActionService,
  resolveSelectedHistoryAttachments,
  trustedUploadedFilesFromRequestBody,
} = require('@librechat/api');
const { getMessages, getFiles } = require('~/models');
const {Message} = require('~/db/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { projectTrustedClientPresentation } = require('./interactionContext');
const {
  buildTrustedActionIdempotencyKey,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
} = require('./GlassHiveAccountService');
const {
  dismissCoreOnlyPreDispatchAttention,
  getCoreWorkDelivery,
  getCoreWorkOriginRef,
} = require('./GlassHiveActiveWorkProjectionService');

module.exports = createGlassHiveWorkActionService({
  GenerationJobManager,
  getSourceAuthorJob: (streamId) => GenerationJobManager.getJobStore().getJob(streamId),
  getOriginalInputReceipt: async ({userId,conversationId,sourceMessageId}) => {
    const message = await Message.findOne({user:userId,conversationId,messageId:sourceMessageId,isCreatedByUser:true})
      .select('metadata.viventium.originalInputReceipt').lean();
    return message?.metadata?.viventium?.originalInputReceipt;
  },
  assertVoiceWorkAuthority: (...args) =>
    require('./VoiceWorkAuthorityService').assertVoiceWorkAuthority(...args),
  logger,
  buildTrustedActionIdempotencyKey,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
  getActionFileSources: async ({ ownerId, fileIds, requestBody, serverReq }) => {
    const req = serverReq;
    if (!req || String(req.user?.id || req.user?._id || '') !== String(ownerId))
      throw new Error('active_work_file_owner_unconfirmed');
    const body = projectTrustedClientPresentation(requestBody, req);
    const current = trustedUploadedFilesFromRequestBody(body);
    const history = await resolveSelectedHistoryAttachments(
      {
        userId: String(ownerId),
        conversationId: body.conversationId,
        parentMessageId: body.parentMessageId,
      },
      { getMessages, getFiles },
    );
    const allowed = new Map([...history, ...current].map((file) => [file.file_id, file]));
    return Promise.all(
      fileIds.map(async (id) => {
        const selected = allowed.get(id);
        if (!selected) throw new Error('active_work_file_selection_unauthorized');
        const [file] = await getFiles(
          { user: ownerId, file_id: id },
          null,
          'file_id user filename source text bytes filepath',
        );
        if (!file || String(file.user) !== String(ownerId))
          throw new Error('active_work_file_selection_unauthorized');
        const extracted = file.source === 'text';
        if (extracted && typeof file.text !== 'string')
          throw new Error('active_work_file_text_unavailable');
        const getDownloadStream = !extracted && getStrategyFunctions(file.source).getDownloadStream;
        if (!extracted && (!getDownloadStream || !file.filepath))
          throw new Error('active_work_file_original_unavailable');
        return {
          fileId: id,
          filename: file.filename,
          sizeBytes: extracted ? Buffer.byteLength(file.text, 'utf8') : file.bytes,
          inputKind: extracted ? 'extracted_text' : 'original',
          mediaGroupIndex: Number.isInteger(selected.media_group_index)
            ? selected.media_group_index
            : undefined,
          openStream: async () =>
            extracted
              ? (async function* () {
                  yield Buffer.from(file.text, 'utf8');
                })()
              : getDownloadStream(req, file.filepath),
        };
      }),
    );
  },
  reauthorizeCapabilityAuthorization: (...args) =>
    require('./GlassHiveCapabilityAuthorizationService').reauthorizeCapabilityAuthorization(
      ...args,
    ),
  readCapabilityReauthorizationReceiptCandidate: (...args) =>
    require('./GlassHiveCapabilityAuthorizationService').readCapabilityReauthorizationReceiptCandidate(...args),
  dismissCoreOnlyPreDispatchAttention,
  getCoreWorkDelivery,
  getCoreWorkOriginRef,
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    require('./VoiceOrchestrationTraceService').recordVoiceOrchestrationTraceBestEffort(...args),
});
