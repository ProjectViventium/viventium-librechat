import { createScheduleDueHost } from './scheduleDueHost';
import { createHash } from 'crypto';
import type { ScheduledMainRequest } from './scheduleDueHost';
import type { ScheduledTaskSourceInput } from './scheduledTaskSource';
import type { ScheduledConversationBinding, ScheduleDueAdmission } from './scheduleDueReceiver';

jest.mock('../prompts/runtime', () => ({
  getRequiredPromptText: jest.fn((id: string, variables?: { scheduled_run_context?: string }) =>
    id === 'scheduler.run_envelope'
      ? `Existing scheduled self-prompt\n${variables?.scheduled_run_context}`
      : 'Existing context contract',
  ),
}));

function setup(readBindingOwners?: () => Promise<string[]>) {
  const bindings = new Map<string, ScheduledConversationBinding>();
  const admissions = new Map<string, ScheduleDueAdmission>();
  const taskTexts = new Map<string, string>();
  const prepareTaskSource = jest.fn(async (input: ScheduledTaskSourceInput) => {
    const sha256 = createHash('sha256').update(input.taskText).digest('hex');
    taskTexts.set(sha256, input.taskText);
    return { messageIds: [input.sourceEventId], sha256 };
  });
  const readBindingTaskText = jest.fn(async (binding: ScheduledConversationBinding) => {
    if (!binding.taskSource) return binding.taskText || '';
    const text = taskTexts.get(binding.taskSource.sha256);
    if (text == null) throw new Error('Original source unavailable');
    return text;
  });
  let available: ScheduleDueAdmission | null = null;
  let wake: (() => void) | null = null;
  const dispatch = jest.fn(async (body: ScheduledMainRequest) => ({
    streamId: 'stream-1',
    conversationId: body.conversationId,
  }));
  const enqueue = jest.fn(async () => ({ configured: 1, enqueued: 1, unresolved: 0 }));
  const readJob = jest.fn(async () => ({ status: 'complete' }));
  const readTelegram = jest.fn<
    Promise<{ telegramChatId?: string; telegramUserId?: string } | null>,
    [string]
  >(async () => ({
    telegramChatId: 'chat-1',
    telegramUserId: 'telegram-1',
  }));
  const readMessage = jest.fn<
    Promise<{ messageId: string; text: string; attachments?: object[] } | null>,
    []
  >(async () => ({
    messageId: 'response-1',
    text: 'Useful original result',
  }));
  const store = {
    readBinding: async (ref: string) => bindings.get(ref) || null,
    saveBinding: async (binding: ScheduledConversationBinding) => {
      if (!bindings.has(binding._id)) bindings.set(binding._id, binding);
      return bindings.get(binding._id)!;
    },
    readAdmission: async (ref: string) => admissions.get(ref) || null,
    insertAdmission: async (admission: ScheduleDueAdmission) => {
      if (!admissions.has(admission._id)) admissions.set(admission._id, admission);
      return admissions.get(admission._id)!;
    },
    claim: async () => {
      const current = available;
      available = null;
      return current;
    },
    update: async (admission: ScheduleDueAdmission, patch: Partial<ScheduleDueAdmission>) => {
      Object.assign(admission, patch);
    },
    release: async () => undefined,
    wakeStream: async () => undefined,
  };
  const environment: { [key: string]: string | undefined } = {
    VIVENTIUM_TENANT_ID: 'test',
    VIVENTIUM_XPERFECT_SCHEDULED_WAKES_ENABLED: 'true',
    VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID: 'destination-1',
    VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 'k').toString('base64')}`,
  };
  const ensureDestination = jest.fn(
    async (_input: {
      ownerId: string;
      name: string;
      url: string;
      secret: string;
      payload_mode: 'envelope';
      max_body_bytes: number;
      idempotency_key: string;
    }) => ({ destination_id: 'auto-destination' }),
  );
  const readConversation = jest.fn(async (_owner: string, _conversation: string) => ({
    endpoint: 'agents',
  }));
  const readActiveCall = jest.fn<
    Promise<{
      callSessionId?: string;
      userId?: string;
      conversationId?: string;
      mode?: string;
    } | null>,
    [string, string]
  >(async () => null);
  const onTiming = jest.fn();
  const readDestination = jest.fn(async () => ({
    url_sha256: createHash('sha256')
      .update('https://receiver.example.test/api/viventium/scheduler/due')
      .digest('hex'),
  }));
  const updateDestination = jest.fn(async () => ({}));
  const readDestinationSchedules = jest.fn<
    Promise<
      Array<{
        definition_id: string;
        version: number;
        target: { kind: string; destination_id: string; request_data: object };
      }>
    >,
    [{ ownerId: string; destinationId: string }]
  >(async () => []);
  const retargetSchedule = jest.fn(async (_input: object) => ({}));
  const host = createScheduleDueHost({
    store,
    ensureDestination,
    updateDestination,
    readDestination,
    readDestinationSchedules,
    retargetSchedule,
    environment,
    readOwner: async () => true,
    readBindingOwners,
    prepareTaskSource,
    readBindingTaskText,
    readConversation,
    readTelegram,
    readActiveCall,
    dispatch,
    readJob,
    readResume: async () => ({ responseMessageId: 'response-1' }),
    subscribe: async (_streamId, onDone) => {
      wake = onDone;
      return { unsubscribe: () => undefined };
    },
    readMessage,
    enqueue,
    onRecoveryError: jest.fn(),
    onTiming,
  });
  async function admit(surface = 'web') {
    const target = await host.ensureTarget({
      user: { id: 'owner-1' },
      requestBody: {
        conversationId: 'conversation-1',
        messageId: 'source-1',
        text: 'Exact original scheduled task',
        viventiumSurface: surface,
      },
    });
    if (!target) throw new Error('target absent');
    const binding = bindings.get(target.request_data.request_ref)!;
    const admission: ScheduleDueAdmission = {
      _id: 'admission-1',
      kind: 'schedule_due',
      userId: 'owner-1',
      idempotencyKey: 'due-1',
      streamId: 'stream-1',
      conversationId: binding.conversationId,
      status: 'reserved',
      dueState: 'admitted',
      eventId: 'event-1',
      requestDigest: 'digest-1',
      bindingRef: binding._id,
      admittedAt: new Date(),
      updatedAt: new Date(),
      envelope: {
        type: 'schedule.due',
        schedule_id: 'schedule-1',
        schedule_version: 1,
        occurrence_id: 'occurrence-1',
        scheduled_at: '2030-01-01T00:00:00Z',
        expires_at: '2030-01-01T00:15:00Z',
        principal: { tenant_id: 'test', owner_id: 'owner-1' },
        request_data: target.request_data,
      },
    };
    admissions.set(admission._id, admission);
    available = admission;
    return { admission, target, binding };
  }
  return {
    host,
    prepareTaskSource,
    readBindingTaskText,
    onTiming,
    environment,
    ensureDestination,
    updateDestination,
    readDestination,
    readDestinationSchedules,
    retargetSchedule,
    readConversation,
    readActiveCall,
    bindings,
    admissions,
    dispatch,
    enqueue,
    readMessage,
    readJob,
    readTelegram,
    admit,
    claimAgain: (admission: ScheduleDueAdmission) => {
      available = admission;
    },
    complete: () => wake?.(),
  };
}

describe('Viventium application receiver uses existing owners', () => {
  test('configuration off preserves ordinary behavior and creates no references', async () => {
    const data = setup();
    delete data.environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    expect(
      await data.host.ensureTarget({ user: { id: 'owner-1' }, requestBody: { text: 'hi' } }),
    ).toBeNull();
    expect(data.bindings.size).toBe(0);
  });
  test('target preparation reports numeric stages without request text or credentials', async () => {
    const data = setup();
    delete data.environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://app.example/api/viventium/scheduler/due';
    await data.admit();
    expect(data.onTiming.mock.calls.map(([entry]) => entry.stage)).toEqual(
      expect.arrayContaining([
        'scheduled_destination_setup_ms',
        'scheduled_target_authority_ms',
        'scheduled_target_destination_and_channel_ms',
        'scheduled_target_bindings_ms',
        'scheduled_target_preparation_ms',
      ]),
    );
    for (const [entry] of data.onTiming.mock.calls) {
      expect(entry.durationMs).toEqual(expect.any(Number));
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(entry).sort()).toEqual(['durationMs', 'stage']);
    }
  });
  test('native handoff source ledger supplies exact originals without a duplicate text field', async () => {
    const data = setup();
    const requestBody = {
      conversationId: 'conversation-1',
      messageId: 'response-1',
      viventiumSourceEventId: 'original-source-1',
      viventiumTriggeringSourceSegments: [
        { text: '  Original task A.\nKeep its wording.  ' },
        { text: 'Original task B.' },
      ],
    };
    const targets = await data.host.ensureTargets({ user: { id: 'owner-1' }, requestBody });
    expect(targets).toHaveLength(6);
    for (const binding of data.bindings.values()) {
      expect(binding.sourceEventId).toBe('original-source-1');
      expect(binding.taskText).toBeUndefined();
      expect(await data.readBindingTaskText(binding)).toBe(
        '  Original task A.\nKeep its wording.  \n\nOriginal task B.',
      );
    }
    const second = await data.host.ensureTargets({
      user: { id: 'owner-1' },
      requestBody: {
        ...requestBody,
        text: 'Unselected older text must not become this binding.',
        viventiumSourceEventId: 'original-source-2',
        viventiumTriggeringSourceSegments: [{ text: 'Only the selected original.' }],
      },
    });
    expect(
      await data.readBindingTaskText(data.bindings.get(second[0].request_data.request_ref)!),
    ).toBe('Only the selected original.');
    expect(second[0].request_data.request_ref).not.toBe(targets[0].request_data.request_ref);
  });

  test.each([undefined, 'Run the distinct follow-up action now'])(
    'scheduler-origin follow-up inherits the original source, not its internal prompt (%s)',
    async (instruction) => {
      const data = setup();
      const { admission, binding } = await data.admit();
      admission.status = 'accepted';
      admission.conversationId = 'materialized-conversation';
      const targets = await data.host.ensureTargets({
        user: { id: 'owner-1' },
        requestBody: {
          conversationId: admission.conversationId,
          messageId: 'internal-response',
          viventiumSourceEventId: admission.eventId,
          viventiumTriggeringSourceSegments: [
            { text: 'Internal scheduling envelope, not the original.' },
          ],
          viventiumSchedulerDueAdmissionId: admission._id,
          viventiumStreamId: admission.streamId,
        },
      });
      expect(targets).toHaveLength(6);
      const followupBinding = data.bindings.get(targets[0].request_data.request_ref)!;
      expect(followupBinding).toMatchObject({
        conversationId: 'materialized-conversation',
        sourceConversationId: binding.sourceConversationId,
        sourceEventId: binding.sourceEventId,
        taskSource: binding.taskSource,
      });
      expect(followupBinding.taskText).toBeUndefined();
      expect(data.prepareTaskSource).toHaveBeenCalledTimes(1);
      const followup = {
        ...admission,
        _id: 'followup-admission',
        status: 'reserved' as const,
        bindingRef: followupBinding._id,
        envelope: { ...admission.envelope, instruction },
      };
      data.claimAgain(followup);
      await data.host.reconcile();
      const request = data.dispatch.mock.calls[0][0];
      expect(request.titleText).toBe('Exact original scheduled task');
      expect(request.text.endsWith(instruction || 'Exact original scheduled task')).toBe(true);
      expect(request.text).not.toContain('Internal scheduling envelope, not the original.');
      if (instruction) expect(request.text).not.toContain('Exact original scheduled task');
    },
  );
  test('legacy due binding upgrades from its original source without internal source segments', async () => {
    const data = setup();
    const { admission, binding } = await data.admit();
    binding.taskSource = undefined;
    binding.taskText = 'Exact original scheduled task';
    admission.status = 'accepted';
    const targets = await data.host.ensureTargets({
      user: { id: 'owner-1' },
      requestBody: {
        conversationId: admission.conversationId,
        viventiumStreamId: admission.streamId,
        viventiumSchedulerDueAdmissionId: admission._id,
        viventiumTriggeringSourceSegments: [{ text: 'Internal scheduler envelope' }],
      },
    });
    expect(targets).toHaveLength(6);
    expect(data.prepareTaskSource).toHaveBeenLastCalledWith({
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      sourceEventId: 'source-1',
      taskText: 'Exact original scheduled task',
      sources: undefined,
    });
  });

  test.each([
    'missing',
    'owner',
    'tenant',
    'stream',
    'conversation',
    'unaccepted',
    'revoked',
    'source_acl',
  ])(
    'scheduler-origin target refuses invalid %s provenance without using internal text',
    async (change) => {
      const data = setup();
      const { admission, binding } = await data.admit();
      admission.status = 'accepted';
      const requestBody = {
        conversationId: admission.conversationId,
        viventiumSourceEventId: 'internal-source',
        text: 'Internal envelope must never become a new original.',
        viventiumSchedulerDueAdmissionId: admission._id,
        viventiumStreamId: admission.streamId,
      };
      if (change === 'missing') data.admissions.delete(admission._id);
      if (change === 'owner') admission.userId = 'another-owner';
      if (change === 'tenant') admission.envelope.principal.tenant_id = 'another-tenant';
      if (change === 'stream') requestBody.viventiumStreamId = 'another-stream';
      if (change === 'conversation') admission.conversationId = 'another-conversation';
      if (change === 'unaccepted') admission.status = 'reserved';
      if (change === 'revoked') binding.active = false;
      if (change === 'source_acl') {
        binding.sourceConversationId = 'unavailable-source';
        data.readConversation.mockImplementation(async (_owner, id) =>
          id === 'unavailable-source' ? null! : { endpoint: 'agents' },
        );
      }
      const before = data.bindings.size;
      expect(await data.host.ensureTargets({ user: { id: 'owner-1' }, requestBody })).toEqual([]);
      expect(data.bindings.size).toBe(before);
    },
  );

  test('web/call default retains chat; Telegram retains verified chat and Telegram destinations', async () => {
    const web = setup();
    const { binding } = await web.admit('voice');
    expect(binding.destinations).toEqual([{ surface: 'librechat' }]);
    const telegram = setup();
    const tg = await telegram.admit('telegram');
    expect(tg.binding.destinations).toEqual([
      {
        surface: 'telegram',
        telegramChatId: 'chat-1',
        telegramUserId: 'telegram-1',
      },
    ]);
    expect(Object.keys(tg.target.request_data)).toEqual(['request_ref']);
    expect(JSON.stringify(tg.target)).not.toContain('Exact original');
  });
  test('real linked Telegram user mapping supplies its existing private-chat destination', async () => {
    const data = setup();
    data.readTelegram.mockResolvedValue({ telegramUserId: 'telegram-1' });
    const { target, binding, admission } = await data.admit('telegram');
    expect(target).toBeTruthy();
    expect(binding.destinations).toEqual([
      {
        surface: 'telegram',
        telegramChatId: 'telegram-1',
        telegramUserId: 'telegram-1',
      },
    ]);
    await data.host.reconcile();
    expect(data.dispatch).toHaveBeenCalledTimes(1);
    expect(admission.dueState).toBe('delivery_queued');
  });
  test('persisted canonical result recovers presentation after the generation job has gone', async () => {
    const data = setup();
    const { admission } = await data.admit();
    admission.status = 'accepted';
    admission.dueState = 'unknown';
    admission.resultMessageId = 'response-1';
    admission.failureCode = 'schedule_due_stream_unavailable';
    data.enqueue.mockImplementationOnce(async () => {
      expect(admission.dueState).toBe('running');
      expect(admission.failureCode).toBe('schedule_due_stream_unavailable');
      return { configured: 1, enqueued: 1, unresolved: 0 };
    });
    data.readJob.mockImplementation(async () => {
      throw new Error('transient job no longer exists');
    });
    await data.host.reconcile();
    expect(data.readJob).not.toHaveBeenCalled();
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.enqueue).toHaveBeenCalledTimes(1);
    expect(admission.dueState).toBe('delivery_queued');
    expect(admission.failureCode).toBe('');
  });
  test('missing persisted result stays unknown without replaying accepted work', async () => {
    const data = setup();
    const { admission } = await data.admit();
    admission.status = 'accepted';
    admission.dueState = 'running';
    admission.resultMessageId = 'response-1';
    data.readMessage.mockResolvedValue(null);
    await data.host.reconcile();
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.enqueue).not.toHaveBeenCalled();
    expect(admission.dueState).toBe('unknown');
    expect(admission.failureCode).toBe('schedule_due_result_unavailable');
  });
  test('failed recovered presentation keeps its diagnostic until a confirmed presentation', async () => {
    const data = setup();
    const { admission } = await data.admit();
    admission.status = 'accepted';
    admission.dueState = 'unknown';
    admission.resultMessageId = 'response-1';
    admission.failureCode = 'schedule_due_stream_unavailable';
    data.enqueue.mockRejectedValueOnce(new Error('presentation_unavailable'));
    await expect(data.host.reconcile()).rejects.toThrow('presentation_unavailable');
    expect(admission.dueState).toBe('running');
    expect(admission.failureCode).toBe('schedule_due_stream_unavailable');
    expect(data.dispatch).not.toHaveBeenCalled();
  });
  test('all selected channel and conversation options are labeled original-context references', async () => {
    const data = setup();
    data.readConversation.mockImplementation(async (_owner, conversation) => ({
      endpoint: conversation === 'foreign' ? 'not-owned' : 'agents',
    }));
    const targets = await data.host.ensureTargets({
      user: { id: 'owner-1' },
      requestBody: {
        conversationId: 'conversation-1',
        messageId: 'source-1',
        text: 'Exact original scheduled task',
        viventiumScheduleConversationIds: ['specified-1', 'foreign'],
      },
    });
    expect(targets).toHaveLength(9);
    expect(targets.map((target) => target.label)).toContain(
      'Same conversation · Web chat and Telegram',
    );
    expect(targets.map((target) => target.label)).toContain('New conversation when due · Telegram');
    expect(targets.map((target) => target.label)).toContain(
      'Selected conversation specified-1 · Web chat',
    );
    expect(targets.some((target) => target.label.includes('foreign'))).toBe(false);
    const newTarget = targets.find(
      (target) => target.label === 'New conversation when due · Web chat',
    )!;
    expect(data.bindings.get(newTarget.request_data.request_ref)?.conversationPolicy).toBe('new');
    expect(
      [...data.bindings.values()].every(
        (binding) => binding.sourceConversationId === 'conversation-1',
      ),
    ).toBe(true);
    expect(await Promise.all([...data.bindings.values()].map(data.readBindingTaskText))).toEqual(
      Array(data.bindings.size).fill('Exact original scheduled task'),
    );
    expect([...data.bindings.values()].every((binding) => binding.taskText == null)).toBe(true);
  });
  test('startup rotation is retryable before signature verification until protected setup is ready', async () => {
    let release: (owners: string[]) => void = () => undefined;
    const data = setup(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const input = {
      rawBody: Buffer.from('{}'),
      eventId: 'event',
      timestamp: '0',
      signature: 'invalid',
    };
    await expect(data.host.receive(input)).rejects.toMatchObject({
      status: 503,
      code: 'schedule_destination_refresh_pending',
    });
    release([]);
    await data.host.reconcile();
    await expect(data.host.receive(input)).rejects.toMatchObject({ status: 401 });
    expect(data.admissions.size).toBe(0);
  });
  test('secret rotation reuses stable destination identity through supported update', async () => {
    const data = setup();
    delete data.environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://receiver.example.test/api/viventium/scheduler/due';
    await data.admit();
    const firstKey = data.ensureDestination.mock.calls[0][0].idempotency_key;
    const originalSecret = data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET;
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 'b').toString('base64')}`;
    data.ensureDestination.mockRejectedValueOnce({
      status: 409,
      body: {
        detail: {
          code: 'webhook_destination_create_conflict',
          destination_id: 'auto-destination',
          changed_fields: ['secret'],
        },
      },
    });
    await data.admit();
    expect(data.ensureDestination.mock.calls[1][0].idempotency_key).toBe(firstKey);
    expect(data.updateDestination).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      destinationId: 'auto-destination',
      secret: data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET,
      max_body_bytes: 65536,
    });
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET = originalSecret;
    data.ensureDestination.mockRejectedValueOnce({
      status: 409,
      body: {
        detail: {
          code: 'webhook_destination_create_conflict',
          destination_id: 'auto-destination',
          changed_fields: ['secret'],
        },
      },
    });
    await data.admit();
    expect(data.ensureDestination.mock.calls[2][0].idempotency_key).toBe(firstKey);
    expect(data.updateDestination).toHaveBeenLastCalledWith({
      ownerId: 'owner-1',
      destinationId: 'auto-destination',
      secret: originalSecret,
      max_body_bytes: 65536,
    });
  });
  test('explicit destination URL drift is checked by safe fingerprint before retarget', async () => {
    const data = setup();
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://replacement.example.test/api/viventium/scheduler/due';
    await data.admit();
    expect(data.readDestination).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      destinationId: 'destination-1',
    });
    expect(data.readDestinationSchedules).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      destinationId: 'destination-1',
    });
    expect(data.updateDestination).not.toHaveBeenCalled();
    expect(data.ensureDestination).toHaveBeenCalledWith(
      expect.objectContaining({ url: data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL }),
    );
  });
  test('URL move retargets only old destination through versioned supported API', async () => {
    const data = setup();
    delete data.environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://receiver.example.test/api/viventium/scheduler/due';
    await data.admit();
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://replacement.example.test/api/viventium/scheduler/due';
    data.ensureDestination.mockRejectedValueOnce({
      status: 409,
      body: {
        detail: {
          code: 'webhook_destination_create_conflict',
          destination_id: 'old-destination',
          changed_fields: ['url'],
        },
      },
    });
    data.readDestinationSchedules
      .mockResolvedValueOnce([
        {
          definition_id: 'definition-old',
          version: 7,
          target: {
            kind: 'webhook',
            destination_id: 'old-destination',
            request_data: { request_ref: 'original-ref' },
          },
        },
      ])
      .mockResolvedValueOnce([]);
    await data.admit();
    expect(data.retargetSchedule).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      definitionId: 'definition-old',
      expected_version: 7,
      target: {
        kind: 'webhook',
        destination_id: 'auto-destination',
        request_data: { request_ref: 'original-ref' },
      },
    });
    expect(
      data.readDestinationSchedules.mock.calls.every(
        ([input]) => input.destinationId === 'old-destination',
      ),
    ).toBe(true);
  });
  test('automatic destination setup is idempotent and shared across this owner only', async () => {
    const data = setup();
    delete data.environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    data.environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL =
      'https://receiver.example.test/api/viventium/scheduler/due';
    await data.admit();
    await data.admit();
    expect(data.ensureDestination).toHaveBeenCalledTimes(1);
    expect(data.ensureDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        payload_mode: 'envelope',
        idempotency_key: expect.stringMatching(/^scheduled-main:[a-f0-9]{64}$/),
      }),
    );
  });
  test('normal Main receives existing compiled scheduler envelope and exact original task', async () => {
    const data = setup();
    const { admission } = await data.admit();
    await data.host.reconcile();
    expect(data.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Existing scheduled self-prompt'),
        titleText: 'Exact original scheduled task',
        source_event_id: 'event-1',
        scheduleRunId: 'occurrence-1',
      }),
    );
    expect(data.dispatch.mock.calls[0][0].text).toMatch(/Exact original scheduled task$/);
    expect(data.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { messageId: 'response-1', text: 'Useful original result' },
      }),
    );
    expect(admission.dueState).toBe('delivery_queued');
  });
  test('due dispatch retains the selected Telegram topic without taking one from webhook data', async () => {
    const data = setup();
    const { binding, admission } = await data.admit('telegram');
    const telegram = binding.destinations.find((item) => item.surface === 'telegram');
    if (!telegram) throw new Error('Synthetic Telegram destination missing');
    telegram.telegramMessageThreadId = '42';
    Object.assign(admission.envelope.request_data, { telegramMessageThreadId: 'forged-topic' });
    await data.host.reconcile();
    expect(data.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      viventiumSchedulerDeliveryChannels: ['telegram'],
      viventiumTelegramMessageThreadId: '42',
    }));
  });
  test('A-at-nine and B-at-ten sharing original context execute only their own saved instruction', async () => {
    for (const instruction of ['Run action A now', 'Run action B now']) {
      const data = setup();
      const { admission, binding } = await data.admit();
      binding.taskSource = undefined;
      binding.taskText = 'Run A at nine and B at ten';
      admission.envelope.instruction = instruction;
      await data.host.reconcile();
      const request = data.dispatch.mock.calls[0][0];
      expect(request.text).toMatch(new RegExp(`${instruction}$`));
      expect(request.text).not.toContain('Run A at nine and B at ten');
      expect(binding.taskText).toBe('Run A at nine and B at ten');
    }
  });
  test('file-only canonical Main result keeps its files and creates no empty speech', async () => {
    const data = setup();
    await data.admit();
    data.readMessage.mockResolvedValue({
      messageId: 'response-1',
      text: '',
      attachments: [{ file_id: 'file-1' }],
    });
    await data.host.reconcile();
    expect(data.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ attachments: [{ file_id: 'file-1' }] }),
      }),
    );
    expect(data.readActiveCall).not.toHaveBeenCalled();
  });
  test('NTA is silent and never enters chat/TTS delivery queue', async () => {
    const data = setup();
    const { admission } = await data.admit();
    data.readMessage.mockResolvedValue({ messageId: 'response-1', text: '{NTA}' });
    await data.host.reconcile();
    expect(data.enqueue).not.toHaveBeenCalled();
    expect(admission.dueState).toBe('silent');
  });
  test('eligible current call speaks selected chat; other owners and Telegram-only choices do not', async () => {
    const data = setup();
    await data.admit();
    data.readActiveCall.mockResolvedValue({
      callSessionId: 'call-1',
      userId: 'owner-1',
      conversationId: 'conversation-1',
      mode: 'call',
    });
    await data.host.reconcile();
    expect(data.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          destinations: [
            { surface: 'librechat' },
            { surface: 'voice', voiceCallSessionId: 'call-1', voiceRequestId: 'stream-1' },
          ],
        }),
      }),
    );
    const tg = setup();
    await tg.admit('telegram');
    tg.readActiveCall.mockResolvedValue({
      callSessionId: 'call-1',
      userId: 'owner-1',
      conversationId: 'conversation-1',
      mode: 'call',
    });
    await tg.host.reconcile();
    expect(tg.readActiveCall).not.toHaveBeenCalled();
    const foreign = setup();
    await foreign.admit();
    foreign.readActiveCall.mockResolvedValue({
      callSessionId: 'call-2',
      userId: 'foreign',
      conversationId: 'conversation-1',
      mode: 'call',
    });
    await foreign.host.reconcile();
    expect(foreign.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({ destinations: [{ surface: 'librechat' }] }),
      }),
    );
  });
  test('a changed Telegram mapping cancels before executing against an unselected destination', async () => {
    const data = setup();
    const { admission } = await data.admit('telegram');
    data.readTelegram.mockResolvedValue({
      telegramChatId: 'other-chat',
      telegramUserId: 'telegram-1',
    });
    await data.host.reconcile();
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.enqueue).not.toHaveBeenCalled();
    expect(admission.dueState).toBe('cancelled');
  });
  test('accepted generation is observed, not launched again on channel recovery', async () => {
    const data = setup();
    const { admission } = await data.admit();
    data.readJob.mockResolvedValue({ status: 'running' });
    await data.host.reconcile();
    expect(admission.dueState).toBe('running');
    expect(data.enqueue).not.toHaveBeenCalled();
    data.readJob.mockResolvedValue({ status: 'complete' });
    data.claimAgain(admission);
    await data.host.reconcile();
    expect(data.dispatch).toHaveBeenCalledTimes(1);
    expect(data.enqueue).toHaveBeenCalledTimes(1);
  });
});
