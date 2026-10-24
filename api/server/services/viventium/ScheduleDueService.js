/* === VIVENTIUM START === Thin native Mongo/socket bindings for typed scheduled Main admission. === */
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  createScheduleDueHost,
  ScheduleDueError,
  GenerationJobManager,
  prepareScheduledTaskSource,
  readScheduledBindingTaskText,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getConvo, getUserById } = require('~/models');
const { Message } = require('~/db/models');
const { resolveTelegramMappingByUserId } = require('../TelegramLinkService');
const { createNativeApiSocketFetch } = require('./nativeApiListen');
const { enqueueGlassHiveCallbackDelivery } = require('./GlassHiveCallbackDeliveryService');
const { requestAccountApi } = require('./GlassHiveAccountService');
const { getActiveCallSessionForConversation } = require('./CallSessionService');

const bindings = () => mongoose.connection.collection('viventium_glasshive_callback_bindings');
const admissions = () => mongoose.connection.collection('viventium_scheduler_dispatch_intents');
const store = {
  readBinding: (ref) => bindings().findOne({ _id: ref, kind: 'schedule_binding' }),
  async saveBinding(binding) {
    await bindings().updateOne({ _id: binding._id }, { $setOnInsert: binding }, { upsert: true });
    return store.readBinding(binding._id);
  },
  readAdmission: (id) => admissions().findOne({ _id: id, kind: 'schedule_due' }),
  async insertAdmission(admission) {
    try {
      await admissions().updateOne(
        { _id: admission._id },
        { $setOnInsert: admission },
        { upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    return store.readAdmission(admission._id);
  },
  claim: () =>
    admissions().findOneAndUpdate(
      {
        kind: 'schedule_due',
        $or: [
          { dueState: { $in: ['admitted', 'dispatching', 'running'] } },
          {
            dueState: 'unknown',
            failureCode: 'schedule_due_stream_unavailable',
            resultMessageId: { $type: 'string', $ne: '' },
          },
        ],
        $and: [
          { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
          { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] },
        ],
      },
      { $set: { leaseUntil: new Date(Date.now() + 60_000), claimToken: crypto.randomUUID() } },
      { returnDocument: 'after', sort: { updatedAt: 1 } },
    ),
  update: (admission, patch) =>
    admissions().updateOne(
      { _id: admission._id, claimToken: admission.claimToken },
      {
        $set: { ...patch, updatedAt: new Date() },
      },
    ),
  release: (admission) =>
    admissions().updateOne(
      { _id: admission._id, claimToken: admission.claimToken },
      {
        $unset: { leaseUntil: '', claimToken: '' },
        $set: { nextAttemptAt: new Date(Date.now() + 2_000), updatedAt: new Date() },
      },
    ),
  wakeStream: (streamId) =>
    admissions().updateOne(
      { kind: 'schedule_due', streamId },
      { $set: { nextAttemptAt: new Date() } },
    ),
};
const service = createScheduleDueHost({
  store,
  environment: process.env,
  ensureDestination: ({ ownerId, ...body }) =>
    requestAccountApi({
      ownerId,
      path: '/v1/webhook-destinations',
      method: 'POST',
      body,
    }),
  readDestination: async ({ ownerId, destinationId }) =>
    (await requestAccountApi({ ownerId, path: '/v1/webhook-destinations' })).items.find(
      (item) => item.destination_id === destinationId,
    ) || null,
  updateDestination: ({ ownerId, destinationId, ...body }) =>
    requestAccountApi({
      ownerId,
      path: `/v1/webhook-destinations/${encodeURIComponent(destinationId)}`,
      method: 'PATCH',
      body,
    }),
  readDestinationSchedules: async ({ ownerId, destinationId }) =>
    (
      await requestAccountApi({
        ownerId,
        path: `/v1/recurring-schedules?include_inactive=true&limit=1&destination_id=${encodeURIComponent(destinationId)}`,
      })
    ).items,
  retargetSchedule: ({ ownerId, definitionId, ...body }) =>
    requestAccountApi({
      ownerId,
      path: `/v1/recurring-schedules/${encodeURIComponent(definitionId)}`,
      method: 'PATCH',
      body,
    }),
  readBindingOwners: () =>
    bindings().distinct('ownerId', {
      kind: 'schedule_binding',
      tenantId: process.env.VIVENTIUM_TENANT_ID || 'local',
    }),
  readOwner: async (ownerId) => Boolean(await getUserById(ownerId)),
  readConversation: (ownerId, conversationId) => getConvo(ownerId, conversationId),
  async prepareTaskSource(input) {
    const ids = [
      ...new Set(
        [
          input.sourceEventId,
          ...(input.sources || []).flatMap((source) => [
            source.source_message_id,
            source.source_event_id,
          ]),
        ].filter(Boolean),
      ),
    ];
    const messages = await Message.find({
      user: input.ownerId,
      conversationId: input.conversationId,
      $or: [
        { messageId: { $in: ids } },
        { 'metadata.viventium.interactionContext.source_event_id': { $in: ids } },
      ],
    })
      .select(
        'messageId parentMessageId user conversationId isCreatedByUser text metadata.viventium.interactionContext.source_event_id',
      )
      .lean();
    const parents = [
      ...new Set(
        messages
          .filter((message) => !message.isCreatedByUser && message.parentMessageId)
          .map((message) => message.parentMessageId),
      ),
    ];
    if (parents.length)
      messages.push(
        ...(await Message.find({
          user: input.ownerId,
          conversationId: input.conversationId,
          messageId: { $in: parents },
          isCreatedByUser: true,
        })
          .select('messageId user conversationId isCreatedByUser text')
          .lean()),
      );
    return prepareScheduledTaskSource(input, messages);
  },
  async readBindingTaskText(binding) {
    const messages = binding.taskSource
      ? await Message.find({
          user: binding.ownerId,
          conversationId: binding.sourceConversationId || binding.conversationId,
          messageId: { $in: binding.taskSource.messageIds },
          isCreatedByUser: true,
        })
          .select('messageId user conversationId isCreatedByUser text')
          .lean()
      : [];
    return readScheduledBindingTaskText(binding, messages);
  },
  readTelegram: (ownerId) => resolveTelegramMappingByUserId({ libreChatUserId: ownerId }),
  readActiveCall: (userId, conversationId) =>
    getActiveCallSessionForConversation({ userId, conversationId }),
  readJob: (streamId) => GenerationJobManager.getJob(streamId),
  readResume: (streamId) => GenerationJobManager.getResumeState(streamId),
  subscribe: (streamId, onDone) =>
    GenerationJobManager.subscribe(streamId, () => undefined, onDone, onDone),
  readMessage: (admission, messageId) =>
    Message.findOne({
      user: admission.userId,
      conversationId: admission.conversationId,
      messageId,
      isCreatedByUser: false,
    }).lean(),
  enqueue: enqueueGlassHiveCallbackDelivery,
  onRecoveryError: (code) => logger.warn('[scheduleDue] Recovery deferred', { code }),
  onTiming: (timing) => logger.info(JSON.stringify({ event: 'schedule_due_stage', ...timing })),
  async dispatch(body) {
    const fetchImpl = process.env.VIVENTIUM_NATIVE_API_SOCKET
      ? createNativeApiSocketFetch(process.env.VIVENTIUM_NATIVE_API_SOCKET)
      : globalThis.fetch;
    const response = await fetchImpl(
      `http://127.0.0.1:${process.env.PORT || '3080'}/api/viventium/scheduler/chat`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          'x-viventium-scheduler-secret': process.env.VIVENTIUM_SCHEDULER_SECRET || '',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new ScheduleDueError('schedule_due_dispatch_unavailable', 503);
    const receipt = await response.json();
    if (receipt.deferred) return receipt;
    if (!receipt.streamId || !receipt.conversationId)
      throw new ScheduleDueError('schedule_due_receipt_invalid', 503);
    return receipt;
  },
});
async function applyConversationScheduleAccess({ bundle, user, requestBody }) {
  try {
    const targets = await service.ensureTargets({ user, requestBody });
    if (targets.length) {
      bundle.schedule_access = {
        destinations: targets.map(({ destination_id, request_data, label }) => ({
          destination_id,
          request_data,
          label,
        })),
        manage_destination_ids: [...new Set(targets.map((target) => target.destination_id))],
        defaults: Object.fromEntries(
          ['once', 'daily', 'interval', 'cron', 'rfc5545'].map((kind) => {
            const configured =
              process.env[
                kind === 'once' ? 'SCHEDULER_CATCH_UP_MAX_LATE_S' : 'SCHEDULER_MISFIRE_GRACE_S'
              ];
            const raw = configured?.trim() ? Number(configured) : NaN;
            const seconds = Number.isInteger(raw) && raw >= 0 ? raw : kind === 'once' ? 43200 : 900;
            return [
              kind,
              {
                misfire_grace_seconds: Math.min(seconds, kind === 'once' ? 86400 : 604800),
                catch_up_policy: kind === 'once' ? 'coalesce' : 'skip',
              },
            ];
          }),
        ),
      };
    }
  } catch (error) {
    logger.warn('[VIVENTIUM][scheduleDue] Schedule destination unavailable', {
      code: error?.code || 'schedule_binding_unavailable',
    });
  }
}
module.exports = {
  applyConversationScheduleAccess,
  receiveScheduleDue: (req) =>
    service.receive({
      rawBody: req.viventiumScheduleDueRawBody,
      eventId: req.get('webhook-id') || '',
      timestamp: req.get('webhook-timestamp') || '',
      signature: req.get('webhook-signature') || '',
    }),
  ensureConversationScheduleTarget: service.ensureTarget,
  ensureConversationScheduleTargets: service.ensureTargets,
  reconcileScheduleDueAdmissions: service.reconcile,
};
/* === VIVENTIUM END === */
