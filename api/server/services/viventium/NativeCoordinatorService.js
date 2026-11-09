/* === VIVENTIUM START === Current application context over Native's existing coordinator. === */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  createNativeCoordinatorHost,
  mergeHostedAndNativeRoster,
  nativeCoordinatorConfiguration,
} = require('@librechat/api');
const { requestAccountApi } = require('./GlassHiveAccountService');
const {
  attachConversationProviderBootstrapBundle,
} = require('./GlassHiveConversationProviderService');

const bindings = () => mongoose.connection.collection('viventium_glasshive_callback_bindings');
const tenantId = () => process.env.VIVENTIUM_TENANT_ID || 'local';

function signBundle(bundle) {
  const targetAgent = { model_parameters: {} };
  if (!attachConversationProviderBootstrapBundle({ targetAgent, bundle }))
    throw new Error('coordinator_bootstrap_unavailable');
  return targetAgent.model_parameters.configuration.defaultHeaders;
}

const host = createNativeCoordinatorHost({
  tenantId,
  secrets: () => {
    const values = [process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET];
    const until = Date.parse(process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_PREVIOUS_UNTIL || '');
    if (until > Date.now())
      values.push(process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_PREVIOUS_SECRET);
    return values.filter(Boolean);
  },
  readBinding: (ref) => bindings().findOne({ _id: ref, kind: 'native_coordinator_binding' }),
  async saveBinding(binding) {
    await bindings().updateOne({ _id: binding._id }, { $setOnInsert: binding }, { upsert: true });
    return bindings().findOne({ _id: binding._id, kind: binding.kind });
  },
  async bindConversation(ref, nativeId) {
    await bindings().updateOne(
      {
        _id: ref,
        kind: 'native_coordinator_binding',
        $or: [{ nativeConversationId: { $exists: false } }, { nativeConversationId: nativeId }],
      },
      { $set: { nativeConversationId: nativeId } },
    );
    const binding = await bindings().findOne({ _id: ref, kind: 'native_coordinator_binding' });
    if (binding?.nativeConversationId !== nativeId) throw new Error('coordinator_binding_changed');
    return binding;
  },
  saveSource: async (source) => {
    await bindings().updateOne({ _id: source._id }, { $setOnInsert: source }, { upsert: true });
  },
  readSource: (bindingRef, turnId) =>
    bindings().findOne({
      _id: `${bindingRef}:${turnId}`,
      kind: 'native_coordinator_source',
      bindingRef,
      turnId,
    }),
  readBindings: (ownerId) =>
    bindings()
      .find({
        kind: 'native_coordinator_binding',
        tenantId: tenantId(),
        ownerId,
        active: true,
      })
      .toArray(),
  ensureDestination: async (ownerId) => {
    const destination =
      await require('./ScheduleDueService').ensureApplicationWakeDestination(ownerId);
    if (!destination) throw new Error('coordinator_destination_unavailable');
    return destination;
  },
  request: ({ headers, ...input }) =>
    requestAccountApi({
      ...input,
      maxResponseBytes: null,
      fetchImpl: (url, init) =>
        globalThis.fetch(url, {
          ...init,
          headers: { ...init.headers, ...headers },
        }),
    }),
  signBundle,
  prepareTurn: (input) =>
    require('./NativeCoordinatorContextService').prepareNativeCoordinatorTurn(input),
  prepareDispatch: (input) =>
    require('./NativeCoordinatorContextService').prepareNativeCoordinatorDispatch(input),
  prepareAction: (input) =>
    require('./NativeCoordinatorContextService').prepareNativeCoordinatorAction(input),
  recordAction: (input) =>
    require('./NativeCoordinatorContextService').recordNativeCoordinatorAction(input),
  recordDispatch: (input) =>
    require('./NativeCoordinatorContextService').recordNativeCoordinatorDispatch(input),
  publishResult: (input) =>
    require('./NativeCoordinatorContextService').publishNativeCoordinatorResult(input),
});

async function accept({ ownerId, resources, requestBody, instruction, invocationId }) {
  const executionMode =
    process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE === 'host' ? 'host' : 'docker';
  const receipt = await host.accept({
    ownerId,
    conversationId: requestBody.conversationId,
    agentId: requestBody.agent_id,
    occurrenceId: invocationId,
    original: instruction,
    requestBody,
    configuration: nativeCoordinatorConfiguration(resources, executionMode),
  });
  if (receipt.accepted === true) {
    const known = await require('~/models').markUserParallelWorkKnown(ownerId);
    require('./GlassHiveAccountService').invalidateActiveWorkSnapshot({ ownerId });
    if (!known) throw new Error('coordinator_work_visibility_unconfirmed');
  }
  return receipt;
}

async function receive(req, res) {
  try {
    const result = await host.receive({
      rawBody: req.viventiumScheduleDueRawBody,
      eventId: req.get('webhook-id') || '',
      timestamp: req.get('webhook-timestamp') || '',
      signature: req.get('webhook-signature') || '',
    });
    return res.status(202).json(result);
  } catch (error) {
    const status = Number(error?.status);
    const responseStatus =
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 503;
    logger.warn('[native-coordinator] Application continuation unavailable', {
      code: error?.code || error?.name || 'coordinator_continuation_unavailable',
      status: responseStatus,
    });
    return res.status(responseStatus).json({ error: 'coordinator_continuation_unavailable' });
  }
}

async function enrich(ownerId, snapshot, scope = 'active', includeNativeOnly = true) {
  const snapshots = await host.snapshots(ownerId);
  if (!snapshots.length) return snapshot;
  const roster = mergeHostedAndNativeRoster({
    ownerId,
    tenantId: tenantId(),
    hosted: snapshot,
    native: { snapshot: 'fresh', snapshots },
    scope,
    includeNativeOnly,
  });
  return require('./NativeCoordinatorResultDeliveryService')({
    ownerId,
    tenantId: tenantId(),
    snapshots,
    roster,
  });
}

module.exports = { accept, receive, enrich, control: host.control, snapshots: host.snapshots };
/* === VIVENTIUM END === */
