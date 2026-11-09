import { createHash } from 'node:crypto';
import {
  createNativeCoordinatorContextAdapter,
  createNativeCoordinatorResultPresenter,
  readNativeCoordinatorGoalSnapshot,
} from './nativeCoordinatorContext';
import type {
  NativeCoordinatorContextDependencies,
  NativeCoordinatorPreparedContext,
} from './nativeCoordinatorContext';
import type { NativeCoordinatorBinding, NativeCoordinatorSource } from './nativeCoordinator';
jest.mock('../prompts/runtime', () => ({
  getRequiredPromptText: jest.fn(() => 'Existing compiled native capability inventory.'),
}));
type ResultPresenterDependencies = Parameters<typeof createNativeCoordinatorResultPresenter>[0];
const snapshot = (goal: Record<string, unknown> = {}) => ({
  conversation_id: 'native-chat',
  goals: [
    { goal_id: 'other', run_id: 'unrelated' },
    {
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      work_ref: 'work',
      source_turn_id: 'turn',
      ...goal,
    },
  ],
});

const route = {
  id: 'primary',
  profile: 'codex-cli',
  model: 'codex-cli:model-a',
  effort: 'high',
  execution_mode: 'host' as const,
  resource_class: 'standard' as const,
};
const binding: NativeCoordinatorBinding = {
  _id: 'binding',
  kind: 'native_coordinator_binding',
  ownerId: 'owner',
  tenantId: 'local',
  conversationId: 'core-chat',
  agentId: 'main',
  nativeConversationId: 'native-chat',
  active: true,
  configuration: { model: route.model, effort: route.effort, routes: [route] },
};
const source: NativeCoordinatorSource = {
  _id: 'binding:turn',
  kind: 'native_coordinator_source',
  bindingRef: 'binding',
  turnId: 'turn',
  requestBody: {
    conversationId: 'core-chat',
    agent_id: 'main',
    messageId: 'original-answer',
    parentMessageId: 'original-user',
    viventiumSurface: 'telegram',
  },
};
const prepared: NativeCoordinatorPreparedContext = {
  instructions: 'Current personality.',
  memoryContext: 'Current authorized memory.',
  messages: [{ role: 'user', content: 'Original request, exactly.' }],
  inheritedConversation: { version: 1, conversation_id: 'core-chat', sources: [] },
  bundle: { native_capability: true },
  user: { id: 'owner' },
  requestBody: source.requestBody,
  workerContext: { glasshive_worker_feelings: 'Current state.' },
  presentationContext: {},
};
function dependencies() {
  return {
    readBinding: jest.fn(async () => binding),
    readSource: jest.fn(async () => source),
    prepareContext: jest.fn(async () => prepared),
    signBundle: jest.fn(() => ({
      'X-GlassHive-Bootstrap-Bundle-B64': 'signed-body',
      'X-GlassHive-Bootstrap-Signature': 'signature',
      'X-GlassHive-Bootstrap-Timestamp': '1',
    })),
    prepareActionBundle: jest.fn(async (context: NativeCoordinatorPreparedContext) => ({
      ...context.bundle,
      inherited_conversation: context.inheritedConversation,
      fresh_authority: true,
    })),
    prepareActionSourceContext: jest.fn(async () => ({
      originRef: 'real-core-origin',
      outputContract: { mode: 'inherit' },
    })),
    injectDelegation: jest.fn(async ({ toolArguments }: { toolArguments: object }) => ({
      ...toolArguments,
      bootstrap_bundle_json: {
        application_context_format: 'opaque_v1',
        callbacks: { origin_ref: 'opaque-origin' },
        viventium_delegation_identity: { idempotency_key: 'opaque-core-id' },
      },
    })),
    reconcile: jest.fn(async () => ({ workRef: 'work' })),
    invalidate: jest.fn(),
    request: jest.fn<Promise<Record<string, unknown>>, [string, string]>(async (_owner, path) => {
      if (path !== '/v1/coordinator/conversations/native-chat?include_history=false')
        throw new Error('unsupported_native_transport_route');
      return snapshot();
    }),
    presentResult: jest.fn(async () => undefined),
  } satisfies NativeCoordinatorContextDependencies;
}
const dispatch = {
  conversation_id: 'native-chat',
  request_ref: 'binding',
  goal_id: 'goal',
  source_turn_id: 'turn',
  goal: 'Original request, exactly.',
  instruction: 'Original request, exactly.',
  dispatch_digest: 'digest',
  route,
};

test('reads only the exact goal from the existing compact conversation snapshot route', async () => {
  const deps = dependencies();
  expect(
    await readNativeCoordinatorGoalSnapshot(
      { ownerId: 'owner', conversationId: 'native-chat', goalId: 'goal' },
      deps.request,
    ),
  ).toMatchObject({ goal_id: 'goal', run_id: 'run' });
  expect(deps.request).toHaveBeenCalledWith(
    'owner',
    '/v1/coordinator/conversations/native-chat?include_history=false',
  );
});

test.each([
  { conversation_id: 'other', goals: [{ goal_id: 'goal' }] },
  { conversation_id: 'native-chat', goals: [{ goal_id: 'different' }] },
  { conversation_id: 'native-chat', goals: [{ goal_id: 'goal' }, { goal_id: 'goal' }] },
])('does not guess a goal from an absent, mismatched or ambiguous snapshot', async (value) => {
  const deps = dependencies();
  deps.request.mockResolvedValue(value);
  await expect(
    readNativeCoordinatorGoalSnapshot(
      { ownerId: 'owner', conversationId: 'native-chat', goalId: 'goal' },
      deps.request,
    ),
  ).rejects.toThrow('coordinator_goal_unavailable');
});

test('prepares current context without inference, with native identity and signed body carrier', async () => {
  const deps = dependencies();
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorTurn({
    binding,
    source,
    turn: { conversation_id: 'native-chat', request_ref: 'binding', turn_id: 'turn' },
  });
  expect(deps.prepareContext).toHaveBeenCalledWith({
    binding,
    source,
    eventId: 'turn',
    purpose: 'worker',
  });
  expect(result.body).toMatchObject({
    model: route.model,
    reasoning_effort: 'high',
    metadata: {
      owner_id: 'owner',
      tenant_id: 'local',
      conversation_id: 'native-chat',
      agent_id: 'coordinator',
      message_id: 'turn',
      stream_id: 'turn',
      actor_kind: 'system',
      origin: 'worker',
      bootstrap_bundle_b64: 'signed-body',
    },
  });
  expect(result.headers).not.toHaveProperty('X-GlassHive-Bootstrap-Bundle-B64');
  expect(result.headers).not.toHaveProperty('X-GlassHive-Main-Context-Protocol');
  expect(deps.signBundle).toHaveBeenCalledWith(
    expect.objectContaining({
      application_context_format: 'opaque_v1',
      provider_capabilities: { native_tools: true },
      inherited_conversation: prepared.inheritedConversation,
    }),
  );
});

test('inherits the existing capability unit and carries the exact scoped cognition tail to Native', async () => {
  const deps = dependencies();
  const capsule = '<viventium_feeling_state>Scoped current state.</viventium_feeling_state>';
  const context = {
    ...prepared,
    instructions: `Identity.\n${capsule}\nCurrent source evidence.`,
    developerInstructionTail: capsule,
    bundle: { agents_md: 'Existing broker authority.' },
  };
  deps.prepareContext.mockResolvedValue(context);
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorTurn({
    binding,
    source,
    turn: { conversation_id: 'native-chat', request_ref: 'binding', turn_id: 'turn' },
  });
  expect(result.body.metadata.developer_instruction_tail).toBe(capsule);
  expect(result.body.messages[0]).toEqual({ role: 'system', content: context.instructions });
  expect(deps.signBundle.mock.calls[0][0]).toMatchObject({
    agents_md: 'Existing broker authority.\n\nExisting compiled native capability inventory.',
    provider_capabilities: { native_tools: true },
    inherited_conversation: prepared.inheritedConversation,
  });
  expect(context.bundle).toEqual({ agents_md: 'Existing broker authority.' });
});

test('absent scoped capsule does not declare a Native instruction tail', async () => {
  const deps = dependencies();
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorTurn({
    binding,
    source,
    turn: { conversation_id: 'native-chat', request_ref: 'binding', turn_id: 'turn' },
  });
  expect(result.body.metadata).not.toHaveProperty('developer_instruction_tail');
});

test('never prepares a missing or cross-owner source', async () => {
  const deps = dependencies();
  deps.readSource.mockResolvedValueOnce({
    ...source,
    requestBody: { ...source.requestBody, conversationId: 'other' },
  });
  await expect(
    createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
      binding,
      dispatch,
    }),
  ).rejects.toThrow('coordinator_source_unavailable');
  expect(deps.prepareContext).not.toHaveBeenCalled();
});

test('projects only an explicitly saved Worker access mode into the existing native schema', async () => {
  const deps = dependencies();
  deps.prepareContext.mockResolvedValueOnce({ ...prepared, accessMode: 'full' });
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorTurn({
    binding,
    source,
    turn: { conversation_id: 'native-chat', request_ref: 'binding', turn_id: 'turn' },
  });
  expect(result.body.metadata.glasshive_options).toEqual({ access: 'full' });
});

test('hydrates a Native results wake from its original source while keeping actual native turn identity', async () => {
  const deps = dependencies();
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorTurn({
    binding,
    source,
    turn: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      turn_id: 'results-wake',
      source_turn_id: 'turn',
    },
  });
  expect(deps.readSource).toHaveBeenCalledWith('binding', 'turn');
  expect(result.body.metadata).toMatchObject({
    message_id: 'results-wake',
    stream_id: 'results-wake',
    conversation_id: 'native-chat',
    agent_id: 'coordinator',
  });
  expect(deps.prepareContext).toHaveBeenCalledWith(
    expect.objectContaining({ source, eventId: 'results-wake' }),
  );
});

test('passes original dispatch and inherited context through existing signed courier', async () => {
  const deps = dependencies();
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch(
    { binding, dispatch },
  );
  expect(deps.injectDelegation).toHaveBeenCalledWith(
    expect.objectContaining({
      toolArguments: expect.objectContaining({
        goal: dispatch.goal,
        instruction: dispatch.instruction,
        profile: route.profile,
        effort: 'high',
        bootstrap_bundle_json: { application_context_format: 'opaque_v1' },
      }),
      workerContext: expect.objectContaining({
        glasshive_inherited_conversation: prepared.inheritedConversation,
      }),
    }),
  );
  expect(result.delegation).toMatchObject({
    goal: dispatch.goal,
    instruction: dispatch.instruction,
    origin_ref: 'opaque-origin',
    origin_surface: 'telegram',
  });
  expect(result.headers).toEqual({ 'Idempotency-Key': 'opaque-core-id' });
});

test('carries only Native explicit generation and signed notification deadline to the existing launch owner', async () => {
  const deps = dependencies();
  await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
    binding,
    dispatch: {
      ...dispatch,
      redispatch_generation: 2,
      notification_ref: 'current-native-notification',
    },
    notificationExpiresAt: '2026-08-22T13:00:00.000Z',
  });
  expect(deps.injectDelegation).toHaveBeenCalledWith(
    expect.objectContaining({
      preparationAuthority: {
        kind: 'native_coordinator_dispatch',
        generation: 2,
        notificationRef: 'current-native-notification',
        expiresAt: '2026-08-22T13:00:00.000Z',
      },
    }),
  );
});

test('keeps selected extracted attachment text in the ordinary Native dispatch bundle', async () => {
  const deps = dependencies();
  const attachment = {
    file_id: 'synthetic-retained-file',
    filename: 'retained-table.csv',
    type: 'text/csv',
    source: 'text',
    context: 'message_attachment',
    text: 'item: sample\nquantity: 2\nunit_price: 4',
    media_group_index: 0,
  };
  const inject = deps.injectDelegation.getMockImplementation()!;
  deps.injectDelegation.mockImplementationOnce(async (input) => ({
    ...(await inject(input)),
    uploaded_files: [attachment],
  }));
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch(
    { binding, dispatch },
  );
  expect(result.delegation.bootstrap_bundle).toMatchObject({
    glasshive_upload_context: { tool_uploaded_files: [attachment] },
  });
  expect(result.delegation.file_upload_ids).toEqual([]);
});

test('cannot reprepare explicit retries without their signed notification deadline', async () => {
  const deps = dependencies();
  await expect(
    createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
      binding,
      dispatch: {
        ...dispatch,
        redispatch_generation: 2,
        notification_ref: 'current-native-notification',
      },
    }),
  ).rejects.toMatchObject({ code: 'coordinator_dispatch_retry_authority_missing' });
  expect(deps.injectDelegation).not.toHaveBeenCalled();
});

test('does not relabel an already-composed legacy Worker bundle as opaque', async () => {
  const deps = dependencies();
  const inject = deps.injectDelegation.getMockImplementation()!;
  deps.injectDelegation.mockImplementationOnce(async (input) => {
    const result = await inject(input);
    delete (result.bootstrap_bundle_json as Record<string, unknown>).application_context_format;
    return result;
  });
  await expect(
    createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
      binding,
      dispatch,
    }),
  ).rejects.toThrow('coordinator_context_format_unavailable');
});

test('rejects changed model or effort, including a valid route id', async () => {
  const deps = dependencies();
  await expect(
    createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
      binding,
      dispatch: { ...dispatch, route: { ...route, effort: 'low' } },
    }),
  ).rejects.toThrow('coordinator_route_changed');
  expect(deps.injectDelegation).not.toHaveBeenCalled();
});

test.each([undefined, null])(
  'accepts an absent optional Native guidance value (%s) without inventing a source',
  async (guidance) => {
    const deps = dependencies();
    await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
      binding,
      dispatch: { ...dispatch, guidance },
    });
    expect(deps.injectDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolArguments: expect.objectContaining({ instruction: dispatch.instruction }),
        workerContext: expect.objectContaining({
          glasshive_inherited_conversation: prepared.inheritedConversation,
        }),
      }),
    );
  },
);

test('keeps manager guidance separate from the exact original task before signing', async () => {
  const deps = dependencies();
  await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorDispatch({
    binding,
    dispatch: { ...dispatch, guidance: 'Evidence from another accepted goal.' },
  });
  expect(deps.injectDelegation).toHaveBeenCalledWith(
    expect.objectContaining({
      toolArguments: expect.objectContaining({ instruction: dispatch.instruction }),
      workerContext: expect.objectContaining({
        glasshive_inherited_conversation: {
          ...prepared.inheritedConversation,
          sources: [
            {
              id: 'coordinator-guidance:native-chat:goal',
              role: 'context',
              kind: 'coordinator_guidance',
              text: 'Evidence from another accepted goal.',
            },
          ],
        },
      }),
    }),
  );
});

test('reconciles native accepted work through the existing callback owner', async () => {
  const deps = dependencies();
  await createNativeCoordinatorContextAdapter(deps).recordNativeCoordinatorDispatch({
    binding,
    context: { original: true },
    work: { work_ref: 'work' },
  });
  expect(deps.reconcile).toHaveBeenCalledWith({
    toolArguments: { original: true },
    result: { work_ref: 'work' },
  });
  expect(deps.invalidate).toHaveBeenCalledWith('owner');
});

test('autonomous action preserves accepted intent and carries fresh context outside ordinary digest', async () => {
  const deps = dependencies();
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorAction({
    binding,
    action: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      source_turn_id: 'turn',
      run_id: 'run',
      action_key: 'operation',
      action_digest: 'digest',
      state: 'unprepared',
      control: {
        action: 'message',
        message: 'Keep the selected original constraint.',
        run_id: 'run',
        idempotency_key: 'operation',
      },
    },
  });
  expect(result.body).toEqual({
    action: 'message',
    instruction: 'Keep the selected original constraint.',
    idempotencyKey: 'operation',
    sourceContext: { originRef: 'real-core-origin', outputContract: { mode: 'inherit' } },
    application_bootstrap_bundle_b64: 'signed-body',
  });
  expect(result.headers).not.toHaveProperty('X-GlassHive-Bootstrap-Bundle-B64');
  expect(deps.prepareActionBundle).toHaveBeenCalledWith(prepared);
  expect(deps.prepareContext).toHaveBeenCalledWith(
    expect.objectContaining({ workerWorkRef: 'work' }),
  );
});

test('guarded Core rich action fields remain unchanged while authority refreshes', async () => {
  const deps = dependencies();
  deps.request.mockResolvedValue(snapshot());
  const body = {
    action: 'queue',
    instruction: 'Exact accepted user steering.',
    idempotencyKey: 'opaque-id',
    inheritedConversation: {
      version: 1,
      conversation_id: 'current-chat',
      sources: [{ text: 'New original input.' }],
    },
    runtimeBundle: { schedule_access: { destinations: [] } },
    fileInputs: [{ uploadId: 'file', sha256: 'digest' }],
    sourceContext: { origin_ref: 'original' },
    nativeInput: { requestId: 'native-question' },
    capabilityReauthorization: { grant: 'current' },
  };
  const result = await createNativeCoordinatorContextAdapter(
    deps,
  ).prepareNativeCoordinatorWorkAction({
    ownerId: 'owner',
    nativeConversationId: 'native-chat',
    goalId: 'goal',
    body,
  });
  expect(result.body).toEqual({ ...body, application_bootstrap_bundle_b64: 'signed-body' });
  expect(result.body.inheritedConversation).toBe(body.inheritedConversation);
  expect(result.body.fileInputs).toBe(body.fileInputs);
  expect(deps.request).toHaveBeenCalledWith(
    'owner',
    '/v1/coordinator/conversations/native-chat?include_history=false',
  );
  expect(body).not.toHaveProperty('application_bootstrap_bundle_b64');
  expect(deps.prepareContext).toHaveBeenCalledWith(
    expect.objectContaining({ workerWorkRef: 'work' }),
  );
  expect(deps.prepareActionBundle).toHaveBeenCalledWith(
    expect.objectContaining({
      inheritedConversation: body.inheritedConversation,
    }),
  );
});

test('restart rehydrates the same saved ordinary action request without rebuilding its body', async () => {
  const deps = dependencies();
  const saved = {
    action: 'queue',
    instruction: 'Exact prior steering.',
    idempotencyKey: 'operation',
    fileInputs: [{ uploadId: 'selected', revision: 'revision' }],
    sourceContext: { origin_ref: 'retained' },
  };
  const result = await createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorAction({
    binding,
    action: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      source_turn_id: 'turn',
      run_id: 'run',
      action_key: 'operation',
      action_digest: 'digest',
      state: 'unprepared',
      action_request: saved,
      control: {
        action: 'queue',
        message: 'Exact prior steering.',
        run_id: 'run',
        idempotency_key: 'operation',
      },
    },
  });
  expect(result.body).toEqual({ ...saved, application_bootstrap_bundle_b64: 'signed-body' });
  expect(result.body.fileInputs).toBe(saved.fileInputs);
  expect(result.body.sourceContext).toBe(saved.sourceContext);
});

test('autonomous stale source-run intent cannot mint a continuation grant', async () => {
  const deps = dependencies();
  await expect(
    createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorAction({
      binding,
      action: {
        conversation_id: 'native-chat',
        request_ref: 'binding',
        goal_id: 'goal',
        source_turn_id: 'turn',
        run_id: 'run',
        action_key: 'operation',
        action_digest: 'digest',
        state: 'unprepared',
        control: { action: 'retry', message: '', run_id: 'other', idempotency_key: 'operation' },
      },
    }),
  ).rejects.toThrow('coordinator_action_changed');
  expect(deps.prepareContext).not.toHaveBeenCalled();
});

test('drains every result page and waits for durable Main presentation before acknowledging', async () => {
  const deps = dependencies();
  const text = 'One. Two.';
  const sha256 = createHash('sha256').update(text).digest('hex');
  deps.request
    .mockResolvedValueOnce(snapshot({ result_revision: 2 }))
    .mockResolvedValueOnce({
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 2,
      offset: 0,
      output_text: 'One. ',
      next_offset: 5,
      sha256,
    })
    .mockResolvedValueOnce({
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 2,
      offset: 5,
      output_text: 'Two.',
      next_offset: null,
      sha256,
    });
  const data = {
    conversation_id: 'native-chat',
    request_ref: 'binding',
    goal_id: 'goal',
    run_id: 'run',
    result_revision: 2,
    result_digest: `sha256:${sha256}`,
  };
  await createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
    binding,
    data,
  });
  expect(deps.request).toHaveBeenLastCalledWith('owner', expect.stringContaining('offset=5'));
  expect(deps.request.mock.calls[0]).toEqual([
    'owner',
    '/v1/coordinator/conversations/native-chat?include_history=false',
  ]);
  expect(deps.presentResult).toHaveBeenCalledWith(
    expect.objectContaining({
      text,
      source,
      data,
      eventId: 'native-result:native-chat:goal:run:2',
    }),
  );
});

test('rejects a result that changed during pagination', async () => {
  const deps = dependencies();
  deps.request.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({
    goal_id: 'goal',
    run_id: 'different',
    offset: 0,
    output_text: 'Wrong.',
    next_offset: null,
    sha256: '0'.repeat(64),
  });
  await expect(
    createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
      binding,
      data: {
        conversation_id: 'native-chat',
        request_ref: 'binding',
        goal_id: 'goal',
        run_id: 'run',
        result_revision: 1,
        result_digest: `sha256:${'0'.repeat(64)}`,
      },
    }),
  ).rejects.toThrow('coordinator_result_changed');
  expect(deps.presentResult).not.toHaveBeenCalled();
});

test.each([
  ['current goal', 1, 2],
  ['retained result page', 2, 1],
])('rejects a stale result notice against the %s revision', async (_name, goalRevision, pageRevision) => {
  const deps = dependencies();
  const text = 'Exact retained result.';
  const sha256 = createHash('sha256').update(text).digest('hex');
  deps.request.mockResolvedValueOnce(snapshot({ result_revision: goalRevision })).mockResolvedValue({
    goal_id: 'goal', run_id: 'run', result_revision: pageRevision,
    offset: 0, output_text: text, next_offset: null, sha256,
  });
  await expect(createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
    binding,
    data: {
      conversation_id: 'native-chat', request_ref: 'binding', goal_id: 'goal', run_id: 'run',
      result_revision: 2, result_digest: `sha256:${sha256}`,
    },
  })).rejects.toThrow('coordinator_result_changed');
  expect(deps.presentResult).not.toHaveBeenCalled();
});

test.each([
  ['failed', 'provider_unavailable'],
  ['completed', ''],
])('retains %s state beside exact nonempty result text and digest', async (state, failureClass) => {
  const text = '  Exact retained output.\n  ';
  const resultDigest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const deps = {
    readPresentation: jest.fn<Promise<Record<string, unknown> | null>, []>()
      .mockResolvedValueOnce(null).mockResolvedValue({ messageId: 'main-result' }),
    createFollowUp: jest.fn<ReturnType<ResultPresenterDependencies['createFollowUp']>,
      Parameters<ResultPresenterDependencies['createFollowUp']>>(async () => null),
    enqueue: jest.fn(async () => ({ configured: 0, linkedWebCommitted: true })),
  };
  await createNativeCoordinatorResultPresenter(deps)({
    binding, source, text, state, failureClass, eventId: 'native-result', context: prepared,
    data: { conversation_id: 'native-chat', request_ref: 'binding', goal_id: 'goal', run_id: 'run',
      result_revision: 1, result_digest: resultDigest },
  });
  expect(deps.createFollowUp.mock.calls[0][0].insights[0]).toMatchObject({
    insight: text,
    authority: { state, failureClass, resultDigest },
  });
});

test('result retries reuse the existing Main message and delivery ledger', async () => {
  const message = { messageId: 'main-result', text: 'User-facing result.' };
  const deps = {
    readPresentation: jest.fn(async () => message),
    createFollowUp: jest.fn(async () => null),
    enqueue: jest.fn(async () => ({ configured: 1, enqueued: 1, unresolved: 0 })),
  };
  const present = createNativeCoordinatorResultPresenter(deps);
  const input = {
    binding,
    source,
    text: 'Result.',
    eventId: 'native-result:native-chat:goal:run:1',
    data: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${'0'.repeat(64)}`,
    },
    context: prepared,
  };
  await present(input);
  await present(input);
  expect(deps.createFollowUp).not.toHaveBeenCalled();
  expect(deps.enqueue).toHaveBeenCalledTimes(2);
  expect(deps.enqueue).toHaveBeenLastCalledWith(
    expect.objectContaining({ message, eventId: input.eventId }),
  );
});

test('does not ACK missing persisted presentation or unresolved delivery', async () => {
  const input = {
    binding,
    source,
    text: 'Result.',
    eventId: 'native-result',
    data: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${'0'.repeat(64)}`,
    },
    context: prepared,
  };
  const deps = {
    readPresentation: jest.fn<Promise<Record<string, unknown> | null>, []>(async () => null),
    createFollowUp: jest.fn(async () => null),
    enqueue: jest.fn(async () => ({ configured: 1, enqueued: 0, unresolved: 1 })),
  };
  await expect(createNativeCoordinatorResultPresenter(deps)(input)).rejects.toThrow(
    'coordinator_presentation_unconfirmed',
  );
  deps.readPresentation.mockResolvedValue({ messageId: 'persisted' });
  await expect(createNativeCoordinatorResultPresenter(deps)(input)).rejects.toThrow(
    'coordinator_delivery_unconfirmed',
  );
});

test('empty terminal output reaches current Main as neutral exact Native evidence', async () => {
  const deps = {
    readPresentation: jest
      .fn<Promise<Record<string, unknown> | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ messageId: 'main-result', text: 'Authored result.' }),
    createFollowUp: jest.fn<
      ReturnType<ResultPresenterDependencies['createFollowUp']>,
      Parameters<ResultPresenterDependencies['createFollowUp']>
    >(async () => null),
    enqueue: jest.fn(async () => ({ configured: 0, linkedWebCommitted: true })),
  };
  await createNativeCoordinatorResultPresenter(deps)({
    binding,
    source,
    text: '',
    state: 'failed',
    failureClass: 'provider_unavailable',
    eventId: 'native-result',
    context: prepared,
    data: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${createHash('sha256').update('').digest('hex')}`,
    },
  });
  const insight = deps.createFollowUp.mock.calls[0][0].insights[0];
  expect(JSON.parse(String(insight.insight))).toEqual({
    native_result: {
      state: 'failed',
      failure_class: 'provider_unavailable',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${createHash('sha256').update('').digest('hex')}`,
      output_text: '',
    },
  });
  expect(deps.enqueue).toHaveBeenCalledTimes(1);
});

test('a settled Main silence disposition never repeats synthesis or claims surface delivery', async () => {
  const deps = {
    readPresentation: jest
      .fn<Promise<Record<string, unknown> | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ presentationDisposition: 'dropped', dropReason: 'no_response' }),
    createFollowUp: jest.fn(async () => null),
    enqueue: jest.fn(),
  };
  const present = createNativeCoordinatorResultPresenter(deps);
  const input = {
    binding,
    source,
    text: 'Already represented result.',
    eventId: 'native-result',
    context: prepared,
    data: {
      conversation_id: 'native-chat',
      request_ref: 'binding',
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${'0'.repeat(64)}`,
    },
  };
  await present(input);
  await present(input);
  expect(deps.createFollowUp).toHaveBeenCalledTimes(1);
  expect(deps.enqueue).not.toHaveBeenCalled();
});

test.each([{ work_ref: '' }, { source_turn_id: 'foreign-turn' }, { control_run_id: 'newer-run' }])(
  'autonomous continuation cannot prepare authority for changed actual goal %p',
  async (changed) => {
    const deps = dependencies();
    deps.request.mockResolvedValue(snapshot(changed));
    await expect(
      createNativeCoordinatorContextAdapter(deps).prepareNativeCoordinatorAction({
        binding,
        action: {
          conversation_id: 'native-chat',
          request_ref: 'binding',
          goal_id: 'goal',
          source_turn_id: 'turn',
          run_id: 'run',
          action_key: 'operation',
          action_digest: 'digest',
          state: 'unprepared',
          action_request: {
            action: 'queue',
            instruction: 'Original steering',
            idempotencyKey: 'operation',
          },
          control: {
            action: 'queue',
            message: 'Original steering',
            run_id: 'run',
            idempotency_key: 'operation',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'coordinator_action_work_unavailable' });
    expect(deps.prepareContext).not.toHaveBeenCalled();
    expect(deps.signBundle).not.toHaveBeenCalled();
  },
);

function turnResultFixture() {
  const text = 'Actual canonical turn reply.';
  const sha256 = createHash('sha256').update(text).digest('hex');
  const data = {
    conversation_id: 'native-chat',
    request_ref: 'binding',
    turn_id: 'native-turn',
    request_id: 'request',
    run_id: 'turn-run',
    result_revision: 1,
    result_digest: `sha256:${sha256}`,
  };
  const page = {
    turn_id: data.turn_id,
    source_turn_id: 'turn',
    request_id: data.request_id,
    run_id: data.run_id,
    state: 'completed',
    intent_state: 'accepted',
    restore_hold: false,
    superseded: false,
    presentation_eligible: true,
    result_revision: 1,
    sha256,
    output_text: text,
    total_chars: text.length,
    offset: 0,
    next_offset: null,
    publisher: {
      owner_id: 'owner',
      conversation_id: 'native-chat',
      agent_id: 'coordinator',
      request_id: 'request',
      message_id: 'native-turn',
      stream_id: 'native-turn',
      run_id: 'turn-run',
    },
  };
  return { text, data, page };
}

test('publishes a genuine no-goal Native turn through the existing original-source Main presenter', async () => {
  const f = turnResultFixture(),
    deps = dependencies();
  deps.request.mockResolvedValue(f.page);
  await createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
    binding,
    data: f.data,
  });
  expect(deps.request).toHaveBeenCalledWith(
    'owner',
    '/v1/coordinator/conversations/native-chat/turns/native-turn/result?offset=0&max_chars=64000&run_id=turn-run&request_id=request',
  );
  expect(deps.presentResult).toHaveBeenCalledWith(
    expect.objectContaining({
      source,
      data: f.data,
      text: f.text,
      eventId: 'native-turn-result:native-chat:native-turn:request:turn-run:1',
    }),
  );
  expect(deps.injectDelegation).not.toHaveBeenCalled();
});

test.each([
  'request',
  'run',
  'revision',
  'digest',
  'owner',
  'source',
  'stop',
  'hold',
  'superseded',
  'ineligible',
])('rejects a changed %s Native turn before Main preparation', async (changed) => {
  const f = turnResultFixture(),
    deps = dependencies();
  if (changed === 'request') f.page.request_id = 'foreign';
  if (changed === 'run') f.page.run_id = 'foreign';
  if (changed === 'revision') f.page.result_revision = 2;
  if (changed === 'digest') f.page.sha256 = '0'.repeat(64);
  if (changed === 'owner') f.page.publisher.owner_id = 'foreign';
  if (changed === 'source') f.page.source_turn_id = 'foreign';
  if (changed === 'stop') f.page.intent_state = 'cancelled';
  if (changed === 'hold') f.page.restore_hold = true;
  if (changed === 'superseded') f.page.superseded = true;
  if (changed === 'ineligible') f.page.presentation_eligible = false;
  deps.request.mockResolvedValue(f.page);
  await expect(
    createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
      binding,
      data: f.data,
    }),
  ).rejects.toThrow();
  expect(deps.prepareContext).not.toHaveBeenCalled();
  expect(deps.presentResult).not.toHaveBeenCalled();
});

test('selected Native turn results drain the existing result pager with exact digest and publisher', async () => {
  const f = turnResultFixture(),
    deps = dependencies();
  deps.request
    .mockResolvedValueOnce({ ...f.page, output_text: f.text.slice(0, 7), next_offset: 7 })
    .mockResolvedValueOnce({ ...f.page, output_text: f.text.slice(7), offset: 7 });
  await createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({
    binding,
    data: f.data,
  });
  expect(deps.presentResult).toHaveBeenCalledWith(expect.objectContaining({ text: f.text }));
});

test('Native turn paging follows returned Unicode code-point offsets without a JavaScript length cut', async () => {
  const f = turnResultFixture(), deps = dependencies();
  const text = 'A🐝B', sha256 = createHash('sha256').update(text).digest('hex');
  f.data.result_digest = `sha256:${sha256}`;
  deps.request.mockResolvedValueOnce({ ...f.page, sha256, output_text: 'A🐝', total_chars: 3, next_offset: 2 })
    .mockResolvedValueOnce({ ...f.page, sha256, output_text: 'B', total_chars: 3, offset: 2 });
  await createNativeCoordinatorContextAdapter(deps).publishNativeCoordinatorResult({ binding, data: f.data });
  expect(deps.request).toHaveBeenLastCalledWith('owner', expect.stringContaining('offset=2'));
  expect(deps.presentResult).toHaveBeenCalledWith(expect.objectContaining({ text }));
});
