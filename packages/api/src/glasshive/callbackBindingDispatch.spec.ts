import type { GlassHiveCallbackBindingDependencies } from './callbackBinding';

import { createGlassHiveCallbackBindingService } from './callbackBinding';
import { normalizeInteractionSourceSegments } from './interactionSourceSegments';

/* === VIVENTIUM START === A closed launch cannot regain provider dispatch authority. === */
function fixture(bindingState = 'prepared', externalState = 'prepared') {
  const rows = new Map([
    [
      'viventium_glasshive_callback_bindings',
      { ownerId: 'owner', workRef: '', launchState: bindingState },
    ],
    ['viventium_external_work', { ownerId: 'owner', workRef: '', launchState: externalState }],
  ]);
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    toArray: async () => [],
  };
  const positiveFence = jest.fn(async () => true);
  const dependencies: GlassHiveCallbackBindingDependencies = {
    mongoose: {
      connection: {
        collection: (name) => ({
          find: () => cursor,
          findOne: async () => rows.get(name) || null,
          findOneAndUpdate: async () => null,
          updateOne: async (filter, update) => {
            const row = rows.get(name);
            const matchesState =
              typeof filter.launchState === 'string'
                ? row?.launchState === filter.launchState
                : filter.launchState?.$in?.includes(row?.launchState);
            if (!row || !matchesState || (filter.ownerId && row.ownerId !== filter.ownerId)) {
              return { acknowledged: true, matchedCount: 0 };
            }
            Object.assign(row, update.$set);
            return { acknowledged: true, matchedCount: 1 };
          },
        }),
      },
    },
    logger: { info: jest.fn(), warn: jest.fn() },
    canonicalizeGlassHiveCallbackRef: (value) => value,
    resolveTelegramMappingByUserId: async () => null,
    getMessages: async () => [],
    markUserParallelWorkKnown: positiveFence,
    buildTrustedDelegationIdentity: () => ({ idempotencyKey: 'key', goalDigest: 'digest' }),
    requestAccountApi: async () => ({}),
    signTrustedDelegationIdentity: () => 'signature',
    normalizeInteractionSourceSegments,
    promptLayerIntegritySnapshot: () => ({}),
    recordOrchestrationTraceAcceptedLaunch: async () => null,
    recordOrchestrationTraceCallback: async () => null,
    recordOrchestrationTraceFailedLaunch: async () => null,
    recordOrchestrationTraceLaunch: async () => null,
    recordGlassHiveWorkDetailTrace: async () => null,
    deferGlassHiveWorkStateReconciliation: async () => null,
    reconcileAuthoritativeGlassHiveWorkState: async () => null,
  };
  const service = createGlassHiveCallbackBindingService(dependencies);
  const launch = {
    bindingId: 'origin',
    originRef: 'origin',
    ownerId: 'owner',
    sourceEventId: 'source',
    objectiveOrdinal: 0,
    objectiveDigest: 'digest',
    callIdentityDigest: 'call',
    delegationIdentity: {},
    delegationContext: {},
    delegationPacket: {},
    schedulerDispatchDocumentId: '',
    scheduleOccurrenceKey: '',
    required: false,
  };
  return { service, launch, rows, positiveFence, dependencies };
}

test.each(['current', 'historical', 'foreign', 'replay', 'no-write', 'wrapped-no-write', 'fenced'])(
  'invalidates cached roster only after a current owned state transition (%s)',
  async (scenario) => {
    const { dependencies } = fixture();
    const invalidate = jest.fn();
    dependencies.invalidateActiveWorkSnapshot = invalidate;
    const row = {
      _id: 'origin',
      ownerId: 'owner',
      workRef: 'work',
      runId: 'run',
      externalState: scenario === 'replay' ? 'completed' : 'running',
    };
    const update = jest.fn().mockResolvedValue({ ...row, externalState: 'completed' });
    if (scenario === 'no-write' || scenario === 'fenced') update.mockResolvedValue(null);
    if (scenario === 'wrapped-no-write') update.mockResolvedValue({ value: null });
    dependencies.mongoose.connection.collection = () => ({
      find: jest.fn(),
      findOne: async (filter) => (filter.ownerId === row.ownerId ? row : null),
      findOneAndUpdate: update,
      updateOne: async () => ({ matchedCount: 1 }),
    });
    const service = createGlassHiveCallbackBindingService(dependencies);
    const body = {
      work_ref: 'work',
      worker_id: 'worker',
      run_id: scenario === 'historical' ? 'old-run' : 'run',
      event: 'run.completed',
      work_state: 'completed',
      work_terminal: true,
      ...(scenario === 'fenced'
        ? {
            callback_id: 'cb_terminal_' + 'a'.repeat(64),
            result_revision: 1,
            result_ended_at: '2026-08-27T12:00:00Z',
            result_digest: 'sha256:' + 'b'.repeat(64),
          }
        : {}),
    };
    const effectFence =
      scenario === 'fenced'
        ? {
            resultKey: 'ghtr_' + 'e'.repeat(64),
            callbackId: body.callback_id,
            resultRevision: 1,
            resultDigest: body.result_digest,
            acceptedOperationId: 'c'.repeat(32),
            generation: 1,
            leaseId: 'd'.repeat(32),
            acceptedOperationGeneration: 1,
          }
        : undefined;
    const operation = service.recordGlassHiveCallbackExternalState({
      binding: {
        bindingId: 'origin',
        conversationId: 'conversation',
        anchorMessageId: 'anchor',
        requestedParentMessageId: 'parent',
        schedulerDispatchDocumentId: '',
        scheduleOccurrenceKey: '',
        scheduleId: '',
        mainAgentId: 'main',
        destinations: [],
        ownerId: scenario === 'foreign' ? 'other-owner' : 'owner',
        originRef: 'origin',
        workRef: 'work',
        currentRunId: 'run',
        currentRunState: 'completed',
      },
      body,
      effectFence,
    });
    if (scenario === 'fenced')
      await expect(operation).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });
    else await operation;
    if (scenario === 'current') {
      expect(invalidate).toHaveBeenCalledWith({
        ownerId: 'owner',
        fetchImpl: expect.any(Function),
      });
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        invalidate.mock.invocationCallOrder[0],
      );
    } else expect(invalidate).not.toHaveBeenCalled();
  },
);

test('scheduled callback retains its topic and resolves only its stored owner mapping', async () => {
  const { dependencies } = fixture();
  let binding:
    | {
        originRef?: string;
        configuredDestinations?: Array<{ surface: string; telegramMessageThreadId?: string }>;
      }
    | undefined;
  dependencies.mongoose.connection.collection = (name) => ({
    updateOne: async (_filter, update) => {
      if (name === 'viventium_glasshive_callback_bindings' && update.$setOnInsert)
        binding = update.$setOnInsert;
      return { acknowledged: true, matchedCount: 1 };
    },
    findOne: async () => binding,
  });
  const mapping = jest.fn(async () => ({
    telegramChatId: 'owner-chat',
    telegramUserId: 'owner-user',
  }));
  dependencies.resolveTelegramMappingByUserId = mapping;
  dependencies.requestAccountApi = async () => ({
    valid: true,
    originRef: binding?.originRef,
    workRef: 'work',
  });
  const service = createGlassHiveCallbackBindingService(dependencies);
  const launch = await service.registerGlassHiveLaunchContext({
    user: { id: 'stored-owner' },
    requestBody: {
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'input',
      viventiumSourceEventId: 'due-event',
      viventiumSchedulerDeliveryChannels: ['telegram', 'librechat'],
      viventiumTelegramMessageThreadId: '42',
      viventiumSchedulerOccurrenceKey: 'due-occurrence',
    },
    toolName: 'workspace_launch',
    toolArguments: { goal: 'Synthetic future task' },
    toolCall: { id: 'native-call' },
  });
  expect(binding?.configuredDestinations).toEqual([
    { surface: 'telegram', telegramMessageThreadId: '42' },
    { surface: 'librechat' },
  ]);
  const context = await service.resolveGlassHiveCallbackContext(
    {
      origin_ref: launch?.originRef,
      work_ref: 'work',
      worker_id: 'worker',
      run_id: 'run',
      user_id: 'forged-owner',
      telegram_chat_id: 'forged-chat',
      telegramMessageThreadId: 'forged-topic',
    },
    { deferConfirmation: true },
  );
  expect(context?.destinations).toEqual([
    {
      surface: 'telegram',
      telegramChatId: 'owner-chat',
      telegramUserId: 'owner-user',
      telegramMessageThreadId: '42',
    },
    { surface: 'librechat' },
  ]);
  expect(mapping).toHaveBeenCalledWith({ libreChatUserId: 'stored-owner' });
});

test('admits provider dispatch only after both exact prepared rows transition', async () => {
  const { service, launch, rows, positiveFence } = fixture();
  await expect(service.markGlassHiveLaunchDispatchReady(launch)).resolves.toEqual({
    originRef: 'origin',
    launchState: 'dispatch_ready',
  });
  expect([...rows.values()].map((row) => row.launchState)).toEqual([
    'dispatch_ready',
    'dispatch_ready',
  ]);
  expect(positiveFence).toHaveBeenCalledTimes(1);
});

test.each(['not_dispatched', 'accepted', 'dispatch_unknown', 'callback_confirmed'])(
  'does not reopen a %s reservation',
  async (state) => {
    const { service, launch, rows, positiveFence } = fixture(state, state);
    await expect(service.markGlassHiveLaunchDispatchReady(launch)).rejects.toMatchObject({
      code: 'glasshive_launch_dispatch_fenced',
    });
    expect([...rows.values()].map((row) => row.launchState)).toEqual([state, state]);
    expect(positiveFence).not.toHaveBeenCalled();
  },
);

test('does not authorize dispatch if the external projection closed during preparation', async () => {
  const { service, launch, positiveFence } = fixture('prepared', 'not_dispatched');
  await expect(service.markGlassHiveLaunchDispatchReady(launch)).rejects.toMatchObject({
    code: 'glasshive_launch_dispatch_fenced',
  });
  expect(positiveFence).not.toHaveBeenCalled();
});

test('does not authorize another owner through a matching origin reference', async () => {
  const { service, launch, positiveFence } = fixture();
  await expect(
    service.markGlassHiveLaunchDispatchReady({ ...launch, ownerId: 'other' }),
  ).rejects.toMatchObject({
    code: 'glasshive_launch_dispatch_fenced',
  });
  expect(positiveFence).not.toHaveBeenCalled();
});

function attachSelectedFiles(uploadedFiles: object[]) {
  const { service, launch } = fixture();
  return service.attachGlassHiveTrustedLaunchMetadata(
    { uploaded_files: uploadedFiles },
    {
      ...launch,
      delegationPacket: undefined,
      delegationIdentity: {
        version: 1,
        idempotency_key: 'a'.repeat(64),
        goal_digest: 'b'.repeat(64),
        call_identity_digest: 'c'.repeat(64),
        source_event_id: 'source',
        objective_ordinal: 0,
      },
      delegationContext: {
        version: 1,
        source_event_id: 'source',
        triggering_source_segments: [],
      },
    },
  );
}

test('keeps distinct owned upload refs when filenames collide', () => {
  const uploadedFiles = [
    { file_id: 'owned-file-a', filename: 'brief.txt', text: 'First selected source.' },
    { file_id: 'owned-file-b', filename: 'brief.txt', text: 'Second selected source.' },
  ];
  expect(attachSelectedFiles(uploadedFiles)).toEqual(
    expect.objectContaining({
      uploaded_files: uploadedFiles,
      bootstrap_bundle_json: expect.objectContaining({
        viventium_delegation_packet: expect.objectContaining({
          selected_files: [
            { ordinal: 0, ref: 'owned-file-a' },
            { ordinal: 1, ref: 'owned-file-b' },
          ],
        }),
      }),
    }),
  );
});

test.each(['file_id', 'fileId', 'id'])('retains the stable %s ref with display metadata', (key) => {
  const attached = attachSelectedFiles([{ [key]: 'owned-file-a', filename: 'brief.txt' }]);
  expect(attached).toMatchObject({
    bootstrap_bundle_json: {
      viventium_delegation_packet: { selected_files: [{ ordinal: 0, ref: 'owned-file-a' }] },
    },
  });
});

test.each([{ filename: 'brief.txt' }, { file_id: '', filename: 'brief.txt' }])(
  'rejects a selected upload without stable identity before dispatch: %j',
  (file) => {
    expect(() => attachSelectedFiles([file])).toThrow('glasshive_selected_file_ref_unavailable');
  },
);

test.each(['', 'Read the selected source.'])(
  'keeps canonical authored source text through registration and final attachment (%j)',
  async (text) => {
    const { dependencies } = fixture();
    dependencies.buildTrustedDelegationIdentity = () => ({
      idempotencyKey: 'a'.repeat(64),
      goalDigest: 'b'.repeat(64),
    });
    const service = createGlassHiveCallbackBindingService(dependencies);
    const args = {
      instruction: 'Complete the objective supplied in the selected file.',
      uploaded_files: [{ file_id: 'owned-file-a', filename: 'source.bin' }],
    };
    const launch = await service.registerGlassHiveLaunchContext({
      user: { id: 'owner' },
      requestBody: {
        conversationId: 'conversation',
        messageId: 'assistant',
        parentMessageId: 'user',
        viventiumSourceEventId: 'source',
        viventiumTriggeringSourceSegments: [
          {
            source_event_id: 'source',
            source_index: 0,
            text,
            source_files: [{ file_id: 'owned-file-a', filename: 'source.bin' }],
          },
        ],
      },
      toolName: 'worker_delegate_once',
      toolArguments: args,
      toolCall: { id: 'call' },
    });
    expect(launch).not.toBeNull();
    const attached = service.attachGlassHiveTrustedLaunchMetadata(args, launch!);
    expect(attached).toMatchObject({
      uploaded_files: args.uploaded_files,
      bootstrap_bundle_json: {
        viventium_delegation_context: {
          triggering_source_segments: [
            {
              ordinal: 0,
              source_event_id: 'source',
              source_index: 0,
              text,
            },
          ],
        },
        viventium_delegation_packet: {
          task: { instruction: args.instruction, source_segments: [{ ordinal: 0, text }] },
          selected_files: [{ ordinal: 0, ref: 'owned-file-a' }],
        },
      },
    });
  },
);

/* === VIVENTIUM END === */

test('launch signature binds only the trusted inherited conversation with stable exact content', () => {
  const { service, launch } = fixture();
  const context = {
    version: 1,
    conversation_id: 'conversation',
    sources: [{ id: 'source', text: 'Exact é\ncontent.' }],
  };
  const trustedLaunch = {
    ...launch,
    delegationPacket: undefined,
    delegationIdentity: {
      version: 1,
      idempotency_key: 'a'.repeat(64),
      goal_digest: 'b'.repeat(64),
      call_identity_digest: 'c'.repeat(64),
      source_event_id: 'source',
      objective_ordinal: 0,
    },
    delegationContext: { version: 1, source_event_id: 'source', triggering_source_segments: [] },
  };
  const attach = (bundle: object, modelBundle: object = {}) =>
    service.attachGlassHiveTrustedLaunchMetadata(
      { title: 'Task', instruction: 'Use the source.', bootstrap_bundle_json: modelBundle },
      trustedLaunch,
      bundle,
    ) as {
      bootstrap_bundle_json: {
        inherited_conversation?: string;
        viventium_delegation_identity: { launch_payload_digest: string };
      };
    };
  const original = attach({ inherited_conversation: context });
  const changed = attach({
    inherited_conversation: { ...context, sources: [{ id: 'source', text: 'Different content.' }] },
  });
  expect(JSON.parse(original.bootstrap_bundle_json.inherited_conversation!)).toEqual(context);
  expect(
    original.bootstrap_bundle_json.viventium_delegation_identity.launch_payload_digest,
  ).not.toEqual(changed.bootstrap_bundle_json.viventium_delegation_identity.launch_payload_digest);
  expect(attach({}, { inherited_conversation: context })).toEqual(attach({}));
});

test('trusted history crosses the signed hop as one exact JSON string without routing-key scrubbing', () => {
  const { service, launch } = fixture();
  const context = {
    version: 1,
    conversation_id: 'conversation',
    sources: [
      {
        id: 'prior',
        text: 'Exact original.',
        tool_calls: [
          {
            name: 'original_tool',
            args: {
              small: 0.00005,
              exponent: 1e-7,
              lone: '\ud800',
              telegramUserId: 'historical value',
              callbackUrl: 'historical value',
            },
          },
        ],
      },
    ],
  };
  const attached = service.attachGlassHiveTrustedLaunchMetadata(
    { title: 'Task', instruction: 'Use the source.' },
    {
      ...launch,
      delegationPacket: undefined,
      delegationIdentity: {
        version: 1,
        idempotency_key: 'a'.repeat(64),
        goal_digest: 'b'.repeat(64),
        call_identity_digest: 'c'.repeat(64),
        source_event_id: 'source',
        objective_ordinal: 0,
      },
      delegationContext: { version: 1, source_event_id: 'source', triggering_source_segments: [] },
    },
    { inherited_conversation: context, callbackUrl: 'not trusted routing' },
  ) as { bootstrap_bundle_json: { inherited_conversation: string; callbackUrl?: string } };
  expect(attached.bootstrap_bundle_json.inherited_conversation).toBe(JSON.stringify(context));
  expect(JSON.parse(attached.bootstrap_bundle_json.inherited_conversation)).toEqual(context);
  expect(attached.bootstrap_bundle_json.callbackUrl).toBeUndefined();
});

/* === VIVENTIUM START === Scheduled Main keeps its own clock's result state. === */
test.each(['schedule_due', 'legacy', 'not-found'])(
  'notifies only the owning scheduler for external work (%s)',
  async (kind) => {
    const { dependencies } = fixture();
    const originalCollection = dependencies.mongoose.connection.collection;
    const readIntent = jest.fn(async () =>
      kind === 'not-found' ? null : { kind, userId: 'owner' },
    );
    dependencies.mongoose.connection.collection = (name) =>
      name === 'viventium_scheduler_dispatch_intents'
        ? { ...originalCollection(name), findOne: readIntent }
        : originalCollection(name);
    const send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ accepted: true }) });
    dependencies.fetchImpl = send;
    const priorUrl = process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
    const priorSecret = process.env.VIVENTIUM_SCHEDULER_SECRET;
    process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL =
      'https://scheduler.example.invalid/callback';
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'synthetic-test-signing-key';
    try {
      await createGlassHiveCallbackBindingService(dependencies).notifySchedulerExternalWorkSummary({
        binding: {
          ownerId: 'owner',
          schedulerDispatchDocumentId: 'admission',
          scheduleOccurrenceKey: 'occurrence',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
          items: [],
        },
      });
      expect(readIntent).toHaveBeenCalledWith({ _id: 'admission', userId: 'owner' });
      expect(send).toHaveBeenCalledTimes(kind === 'schedule_due' ? 0 : 1);
    } finally {
      if (priorUrl == null) delete process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
      else process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL = priorUrl;
      if (priorSecret == null) delete process.env.VIVENTIUM_SCHEDULER_SECRET;
      else process.env.VIVENTIUM_SCHEDULER_SECRET = priorSecret;
    }
  },
);
/* === VIVENTIUM END === */
