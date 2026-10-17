const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

function preparationOwner() {
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
    getTrustedInteractionContext: () => null,
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
  return { run: scope.module.exports, continuity };
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
