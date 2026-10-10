const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../request.js'), 'utf8');

function metadataBlock(branch) {
  if (branch === 'resumable') {
    const start = source.indexOf('    const viventiumVoiceTaskId = voiceTaskIdForRequest(req);');
    const end = source.indexOf('    if (voiceLatencyEnabled) {', start);
    if (start < 0 || end <= start) throw new Error('Resumable metadata block unavailable');
    return source.slice(start, end);
  }
  const start = source.indexOf('    // Store endpoint metadata for abort handling');
  const end = source.indexOf('    // Store content parts reference for abort', start);
  if (start < 0 || end <= start) throw new Error('Legacy metadata block unavailable');
  return source.slice(start, end);
}

test.each(['resumable', 'legacy'])(
  '%s admission retains only server-created WorkAuthority',
  async (branch) => {
    const binding = {
      version: 1,
      callSessionId: 'call-1',
      userId: 'owner-1',
      kind: 'participant_text',
      fingerprint: 'a'.repeat(64),
      turnIds: [],
    };
    for (const serverBinding of [binding, undefined]) {
      const updateMetadata = jest.fn(async () => {});
      const req = {
        viventiumVoiceWorkAuthority: serverBinding,
        body: {
          viventiumCallSessionId: 'call-1',
          viventiumVoiceTaskId: 'task-1',
          viventiumVoiceWorkAuthority: { ...binding, fingerprint: 'caller-forged' },
        },
      };
      const context = {
        req,
        streamId: 'stream-1',
        voiceTaskIdForRequest: () => 'task-1',
        GenerationJobManager: { updateMetadata },
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'synthetic' } },
        client: { sender: 'Agent' },
      };
      await vm.runInNewContext(`(async () => { ${metadataBlock(branch)} })()`, context);
      expect(updateMetadata).toHaveBeenCalledTimes(1);
      expect(updateMetadata.mock.calls[0][1].viventiumVoiceWorkAuthority).toEqual(serverBinding);
      expect(updateMetadata.mock.calls[0][1].viventiumCallSessionId).toBe('call-1');
    }
  },
);

test.each(['resumable', 'legacy'])(
  '%s admission waits for its owned authority metadata before generation',
  async (branch) => {
    let release;
    const pendingWrite = new Promise((resolve) => {
      release = resolve;
    });
    const updateMetadata = jest.fn(() => pendingWrite);
    const context = {
      req: {
        viventiumVoiceWorkAuthority: {
          version: 1,
          callSessionId: 'call-1',
          userId: 'owner-1',
          kind: 'participant_text',
          fingerprint: 'a'.repeat(64),
          turnIds: [],
        },
        body: { viventiumCallSessionId: 'call-1', viventiumVoiceTaskId: 'task-1' },
      },
      streamId: 'stream-1',
      voiceTaskIdForRequest: () => 'task-1',
      GenerationJobManager: { updateMetadata },
      endpointOption: { endpoint: 'agents' },
      client: { sender: 'Agent' },
      generationStarted: false,
    };
    const run = vm.runInNewContext(
      `(async () => { ${metadataBlock(branch)}; generationStarted = true; })()`,
      context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const startedBeforeWrite = context.generationStarted;
    release();
    await run;
    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(startedBeforeWrite).toBe(false);
    expect(context.generationStarted).toBe(true);
  },
);

test('legacy onStart waits for response identity metadata before generation', async () => {
  const start = source.lastIndexOf('    const onStart = (userMsg, respMsgId, _isNewConvo) => {');
  const end = source.indexOf('    const messageOptions = {', start);
  if (start < 0 || end <= start) throw new Error('Legacy start callback unavailable');
  let release;
  const pendingWrite = new Promise((resolve) => {
    release = resolve;
  });
  const updateMetadata = jest.fn(() => pendingWrite);
  const context = {
    sendEvent: jest.fn(),
    res: {},
    streamId: 'stream-1',
    conversationId: 'conversation-1',
    GenerationJobManager: { updateMetadata },
    generationStarted: false,
    inputMessage: { messageId: 'user-1', parentMessageId: 'parent-1', text: 'Synthetic text' },
  };
  const run = vm.runInNewContext(
    `(async () => {
      let userMessage, userMessageId, responseMessageId;
      ${source.slice(start, end)}
      await onStart(inputMessage, 'response-1', false);
      generationStarted = true;
    })()`,
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeWrite = context.generationStarted;
  release();
  await run;
  expect(updateMetadata).toHaveBeenCalledWith('stream-1', {
    responseMessageId: 'response-1',
    userMessage: {
      messageId: 'user-1',
      parentMessageId: 'parent-1',
      conversationId: 'conversation-1',
      text: 'Synthetic text',
    },
  });
  expect(startedBeforeWrite).toBe(false);
  expect(context.generationStarted).toBe(true);
});
