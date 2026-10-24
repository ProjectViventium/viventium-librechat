const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

function preparationOwner(interactionContext = null) {
  const file = path.join(__dirname, 'client.js');
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let method;
  let requestBodyOwner;
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'buildMessages') method = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildViventiumMcpRequestBody')
      requestBodyOwner = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const boundary = method.body.statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(ast) === 'conversationContinuity',
      ),
  );
  if (boundary < 0) throw new Error('Continuity preparation owner missing');
  const continuity = jest.fn(async (options) => ({ messages: options.orderedMessages }));
  const scope = {
    module: { exports: {} },
    startActiveWorkTurnContext: () => {},
    startDeepTiming: () => null,
    isVoiceLatencyEnabled: () => false,
    isDeepTimingEnabled: () => false,
    createMultiAgentMapper: () => undefined,
    conversationProviderUsesNativeBody: () => true,
    getNativeConversationReplayBudgetForRoutes: async () => 237500,
    resolveConversationContinuity: continuity,
    getTrustedInteractionContext: () => interactionContext,
    trustedLoopbackWebPresentation: () => null,
    logger: { warn: jest.fn(), info: jest.fn() },
  };
  vm.runInNewContext(
    requestBodyOwner.getText(ast) +
      '\nmodule.exports=async function(messages,parentMessageId,_buildOptions,opts){' +
      method.body.statements
        .slice(0, boundary + 1)
        .map((node) => node.getText(ast))
        .join('\n') +
      ';return conversationContinuity;};',
    scope,
  );
  return {
    run: scope.module.exports,
    continuity,
    buildRequestBody: scope.buildViventiumMcpRequestBody,
  };
}

function fixture(attachments) {
  const message = { messageId: 'current', text: '', content: [], files: attachments };
  const context = {
    constructor: { getMessagesForConversation: ({ messages }) => messages },
    options: { req: {}, agent: { id: 'main' }, attachments },
    addFileContextToMessage: jest.fn(async (row) => {
      row.fileContext = 'Complete extracted context.';
    }),
    processAttachments: jest.fn(async (_row, files) => files),
  };
  return { message, context };
}

test('only trusted scheduler requests carry admitted due-source provenance', () => {
  const scheduler = preparationOwner({ origin: 'scheduler' });
  expect(
    scheduler.buildRequestBody({
      req: { viventiumSchedulerDueAdmissionId: 'admission-1', body: {} },
    }).viventiumSchedulerDueAdmissionId,
  ).toBe('admission-1');
  const user = preparationOwner({ origin: 'interactive' });
  expect(
    user.buildRequestBody({
      req: { body: { viventiumSchedulerDueAdmissionId: 'forged-admission' } },
    }).viventiumSchedulerDueAdmissionId,
  ).toBeUndefined();
});

test.each([
  ['native due', { viventiumSchedulerDeliveryChannels: ['telegram'] }, ['telegram']],
  ['legacy scheduler', { deliveryChannels: ['telegram', 'librechat'] }, ['telegram', 'librechat']],
  [
    'native due precedence',
    {
      viventiumSchedulerDeliveryChannels: ['telegram'],
      deliveryChannels: ['librechat'],
    },
    ['telegram'],
  ],
  [
    'explicit empty native selection',
    {
      viventiumSchedulerDeliveryChannels: [],
      deliveryChannels: ['telegram'],
    },
    [],
  ],
])(
  'preserves the trusted %s delivery selection through native worker handoff',
  (_name, channels, expected) => {
    const owner = preparationOwner({ origin: 'scheduler' });
    const projected = owner.buildRequestBody({
      messageId: 'scheduled-reply',
      conversationId: 'scheduled-conversation',
      parentMessageId: 'scheduled-input',
      req: {
        viventiumSchedulerDueAdmissionId: 'due-admission',
        viventiumSchedulerDispatchDocumentId: 'due-dispatch',
        body: { ...channels, idempotencyKey: 'due-occurrence', scheduleId: 'saved-schedule' },
      },
    });
    expect(projected).toMatchObject({
      viventiumSchedulerDeliveryChannels: expected,
      viventiumSchedulerDueAdmissionId: 'due-admission',
      viventiumSchedulerDispatchDocumentId: 'due-dispatch',
      viventiumSchedulerOccurrenceKey: 'due-occurrence',
      viventiumScheduleId: 'saved-schedule',
    });
  },
);

test.each(['interactive', 'system', undefined])(
  'does not accept body-supplied schedule destinations without trusted scheduler origin (%s)',
  (origin) => {
    const owner = preparationOwner(origin ? { origin } : null);
    const projected = owner.buildRequestBody({
      req: {
        body: {
          viventiumSchedulerDeliveryChannels: ['telegram'],
          deliveryChannels: ['telegram'],
          viventiumSchedulerDueAdmissionId: 'forged-admission',
          viventiumSchedulerDispatchDocumentId: 'forged-dispatch',
        },
      },
    });
    expect(projected).not.toHaveProperty('viventiumSchedulerDeliveryChannels');
    expect(projected).not.toHaveProperty('viventiumSchedulerDueAdmissionId');
    expect(projected).not.toHaveProperty('viventiumSchedulerDispatchDocumentId');
  },
);

test('preserves a scheduled Telegram topic only from the trusted scheduler projection', () => {
  const input = {
    req: { body: { viventiumTelegramMessageThreadId: '42', externalThreadId: 'legacy-topic' } },
  };
  expect(
    preparationOwner({ origin: 'scheduler' }).buildRequestBody(input)
      .viventiumTelegramMessageThreadId,
  ).toBe('42');
  expect(
    preparationOwner({ origin: 'interactive', surface: 'telegram' }).buildRequestBody(input)
      .viventiumTelegramMessageThreadId,
  ).toBe('legacy-topic');
  expect(
    preparationOwner(null).buildRequestBody({
      req: { body: { viventiumTelegramMessageThreadId: 'forged-topic' } },
    }).viventiumTelegramMessageThreadId,
  ).toBeUndefined();
});

test('normal native request carries selected conversations to owner-checked scheduling targets', async () => {
  const { createScheduleDueHost } = require('@librechat/api');
  const owner = preparationOwner({
    source_event_id: 'source-event',
    source_segments: [
      {
        text: 'Use this exact original task.',
        source_event_id: 'source-event',
        source_message_id: 'original-message',
      },
    ],
  });
  const body = owner.buildRequestBody({
    messageId: 'reply-message',
    conversationId: 'source-conversation',
    req: {
      body: { viventiumScheduleConversationIds: ['owned-conversation', 'foreign-conversation'] },
    },
  });
  expect(body.text).toBeUndefined();
  expect(body.viventiumScheduleConversationIds).toEqual([
    'owned-conversation',
    'foreign-conversation',
  ]);
  const bindings = new Map();
  const readConversation = jest.fn(async (user, id) =>
    user === 'owner-1' && id !== 'foreign-conversation' ? { endpoint: 'agents' } : null,
  );
  const host = createScheduleDueHost({
    store: {
      readBinding: async (id) => bindings.get(id),
      saveBinding: async (binding) => {
        bindings.set(binding._id, binding);
        return binding;
      },
      readAdmission: async () => null,
      insertAdmission: async () => null,
      claim: async () => null,
      update: async () => {},
      release: async () => {},
      wakeStream: async () => {},
    },
    environment: {
      VIVENTIUM_XPERFECT_SCHEDULED_WAKES_ENABLED: 'true',
      VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 'k').toString('base64')}`,
      VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID: 'destination-1',
    },
    ensureDestination: async () => ({ destination_id: 'destination-1' }),
    prepareTaskSource: async (input) => ({
      messageIds: input.sources.map((source) => source.source_message_id),
      sha256: require('crypto').createHash('sha256').update(input.taskText).digest('hex'),
    }),
    readBindingTaskText: async () => 'Use this exact original task.',
    readOwner: async () => true,
    readConversation,
    readTelegram: async () => null,
    readActiveCall: async () => null,
    readJob: async () => null,
    readResume: async () => null,
    subscribe: async () => ({ unsubscribe() {} }),
    readMessage: async () => null,
    dispatch: async () => ({}),
    enqueue: async () => ({}),
    onRecoveryError() {},
  });
  const targets = await host.ensureTargets({ user: { id: 'owner-1' }, requestBody: body });
  expect(targets.map((target) => target.label)).toContain(
    'Selected conversation owned-conversation · Web chat',
  );
  expect(targets.some((target) => target.label.includes('foreign'))).toBe(false);
  const selected = [...bindings.values()].find(
    (binding) => binding.conversationId === 'owned-conversation',
  );
  expect(selected).toMatchObject({
    ownerId: 'owner-1',
    sourceConversationId: 'source-conversation',
    sourceEventId: 'source-event',
    taskSource: { messageIds: ['original-message'], sha256: expect.any(String) },
  });
  expect(selected.taskText).toBeUndefined();
});

test('current attachments and gateway images are fully prepared before continuity admission', async () => {
  const files = [
    { file_id: 'current-audio', filename: 'input.wav', type: 'audio/wav', bytes: 554998 },
  ];
  let resolveAttachments;
  const pending = new Promise((resolve) => {
    resolveAttachments = resolve;
  });
  const { message, context } = fixture(files);
  context.options.attachments = pending;
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWw=' } };
  context.options.req._gatewayImages = [image];
  const owner = preparationOwner();
  const preparation = owner.run.call(context, [message], '', {}, {});
  await Promise.resolve();
  expect(owner.continuity).not.toHaveBeenCalled();
  resolveAttachments(files);
  await preparation;
  expect(context.addFileContextToMessage).toHaveBeenCalledTimes(1);
  expect(context.processAttachments).toHaveBeenCalledTimes(1);
  expect(context.message_file_map.current).toBe(files);
  expect(context.options.attachments).toBe(files);
  expect(message.files).toBe(files);
  expect(message.fileContext).toBe('Complete extracted context.');
  expect(message.image_urls).toEqual([image]);
  expect(context._viventiumCurrentAttachmentPreparation.message).toBe(message);
  expect(context._viventiumCurrentAttachmentPreparation.messageId).toBe(message.messageId);
  expect(owner.continuity.mock.calls[0][0].orderedMessages[0]).toBe(message);
});

test('failed current attachment preparation cannot enter continuity or mark preparation complete', async () => {
  const { message, context } = fixture([{ file_id: 'input', type: 'audio/wav' }]);
  context.processAttachments.mockRejectedValue(new Error('Synthetic attachment unavailable'));
  const owner = preparationOwner();
  await expect(owner.run.call(context, [message], '', {}, {})).rejects.toThrow(
    'Synthetic attachment unavailable',
  );
  expect(owner.continuity).not.toHaveBeenCalled();
  expect(context._viventiumCurrentAttachmentPreparation).toBeNull();
});

test('preparation retains the existing caller cancellation signal at continuity admission', async () => {
  const { message, context } = fixture([]);
  const abortController = new AbortController();
  context.processAttachments.mockImplementation(async (_row, files) => {
    abortController.abort();
    return files;
  });
  const owner = preparationOwner();
  await owner.run.call(context, [message], '', {}, { abortController });
  expect(owner.continuity.mock.calls[0][0].signal).toBe(abortController.signal);
  expect(owner.continuity.mock.calls[0][0].signal.aborted).toBe(true);
});

test.each([
  null,
  { origin: 'interactive', surface: 'web' },
  { origin: 'system', surface: 'telegram' },
])(
  'ignores client-supplied Telegram routing outside the trusted Telegram adapter (%j)',
  (context) => {
    const result = preparationOwner(context).buildRequestBody({
      req: {
        body: {
          viventiumSurface: 'telegram',
          telegramChatId: 'foreign-chat',
          telegramUserId: 'foreign-user',
          telegramMessageId: 'foreign-message',
          externalThreadId: 'foreign-topic',
        },
      },
    });
    expect(result.viventiumTelegramChatId).toBeUndefined();
    expect(result.viventiumTelegramUserId).toBeUndefined();
    expect(result.viventiumTelegramMessageId).toBeUndefined();
    expect(result.viventiumTelegramMessageThreadId).toBeUndefined();
  },
);

test('preserves routing supplied by the actual trusted Telegram adapter', () => {
  const result = preparationOwner({ origin: 'interactive', surface: 'telegram' }).buildRequestBody({
    req: {
      body: {
        telegramChatId: 'owner-chat',
        telegramUserId: 'owner-user',
        telegramMessageId: 'owner-message',
        externalThreadId: 'owner-topic',
      },
    },
  });
  expect(result).toMatchObject({
    viventiumTelegramChatId: 'owner-chat',
    viventiumTelegramUserId: 'owner-user',
    viventiumTelegramMessageId: 'owner-message',
    viventiumTelegramMessageThreadId: 'owner-topic',
  });
});
