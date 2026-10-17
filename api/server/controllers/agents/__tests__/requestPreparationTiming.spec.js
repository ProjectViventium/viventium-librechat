const fs = require('fs');
const path = require('path');
const vm = require('vm');

const controller = fs.readFileSync(path.resolve(__dirname, '../request.js'), 'utf8');
const start = controller.indexOf('        const onStart = (userMsg, respMsgId, _isNewConvo) => {');
const end = controller.indexOf('        const startPartialCheckpointing = () => {', start);
if (start < 0 || end <= start) throw new Error('Controller start callback unavailable');
const startCallback = controller.slice(start, end);

function preparation({
  enabled = true,
  rejectSource = false,
  throwLogger = false,
  bindResponse,
  sourceRow,
  hostContext,
  native = false,
} = {}) {
  const events = [];
  const lines = [];
  let release;
  const originalError = new Error('Synthetic private persistence failure');
  const source = new Promise((resolve, reject) => {
    release = () => (rejectSource ? reject(originalError) : resolve(sourceRow));
  });
  let registered;
  const context = {
    Date,
    getTrustedInteractionContext: () => hostContext,
    nativeResponseSource: jest.requireActual('@librechat/data-schemas').nativeResponseSource,
    require: (name) => {
      if (name === '@librechat/api') return jest.requireActual(name);
      throw new Error(`Unexpected source reread: ${name}`);
    },
    jobCreatedAt: 1,
    job: { abortController: new AbortController() },
    voiceLatencyEnabled: enabled,
    voiceLatencyNow: () => 100,
    trackAssistantSnapshot: (work) => {
      registered = work();
      return registered;
    },
    ensureUserSourceSegmentPersisted: () => source,
    assistantTerminalPersistenceStarted: false,
    persistAssistantSnapshot: async () => {
      events.push('placeholder');
      return { persisted: true, fingerprint: 'synthetic-fingerprint' };
    },
    claimedInteractionContext: { source_event_id: 'source', logical_turn_id: 'turn', revision: 1 },
    req: {
      _viventiumBindResponseIdentity: bindResponse,
      config: { endpoints: { agents: { providerCapabilities: native ? { synthetic: { conversation_session: true, workspace_binding: true } } : {} } } },
    },
    streamId: 'synthetic-stream',
    userId: 'synthetic-owner',
    client: { options: { agent: { endpoint: 'synthetic' } } },
    conversationId: 'synthetic-conversation',
    sender: 'AI',
    GenerationJobManager: {
      getJobStore: () => ({ getJob: async () => ({ createdAt: 1, userId: 'synthetic-owner',
        conversationId: 'synthetic-conversation', status: 'running', interactionContext: hostContext }),
        isCurrentLogicalTurn: async () => true }),
      updateMetadata: async () => events.push('metadata'),
      emitChunk: async () => events.push('created'),
    },
    logger: { warn: jest.fn() },
    logVoiceLatencyStage: (_req, stage, startedAt, status) => {
      lines.push({ stage, startedAt, status });
      if (throwLogger) throw new Error('Synthetic private logger failure');
    },
  };
  vm.runInNewContext(
    `let userMessage,responseMessageId,generationStartedAt,placeholderSnapshotSaved,lastAssistantSnapshotFingerprint;\n${startCallback}\nglobalThis.onStartForTest = onStart;`,
    context,
  );
  const result = context.onStartForTest(
    { messageId: 'synthetic-user', text: 'Synthetic private message' },
    'synthetic-response',
    false,
  );
  return { events, lines, release, result, originalError, registered, context };
}

describe('awaited start preparation timing', () => {
  it('records completion only after source and placeholder work completes', async () => {
    const control = preparation();
    expect(control.lines).toEqual([]);
    expect(control.events).toEqual([]);
    control.release();
    await control.result;
    expect(control.events).toEqual(['placeholder', 'metadata', 'created']);
    expect(control.lines).toEqual([
      { stage: 'message_on_start_persistence', startedAt: 100, status: 'status=completed' },
    ]);
    expect(JSON.stringify(control.lines)).not.toContain('Synthetic private');
  });

  it('records failure and preserves the exact persistence error', async () => {
    const control = preparation({ rejectSource: true });
    control.release();
    await expect(control.result).rejects.toBe(control.originalError);
    expect(control.events).toEqual([]);
    expect(control.lines[0].status).toBe('status=failed');
    expect(JSON.stringify(control.lines)).not.toContain(control.originalError.message);
  });

  it('preserves the registered promise and emits nothing when disabled', async () => {
    const control = preparation({ enabled: false });
    expect(control.result).toBe(control.registered);
    control.release();
    await control.result;
    expect(control.events).toEqual(['placeholder', 'metadata', 'created']);
    expect(control.lines).toEqual([]);
  });

  test.each([false, true])(
    'logger failure preserves persistence outcome (rejected=%s)',
    async (rejectSource) => {
      const control = preparation({ throwLogger: true, rejectSource });
      control.release();
      if (rejectSource) await expect(control.result).rejects.toBe(control.originalError);
      else await expect(control.result).resolves.toBeUndefined();
      expect(control.lines).toHaveLength(1);
    },
  );
});

/* === VIVENTIUM START === Pre-job timing retains admission and error semantics. === */
const {
  observeVoiceLatencyOperation,
  markVoiceLatencyStart,
} = require('~/server/services/viventium/voiceLatencyTiming');
const ownerStart = controller.indexOf(
  '  const { streamId, requested: reqStreamId } = await observeVoiceLatencyOperation(',
);
const ownerEnd = controller.indexOf('\n  let client = null;', ownerStart);
if (ownerStart < 0 || ownerEnd <= ownerStart) throw new Error('Pre-job owner boundary unavailable');
const ownerSource = controller.slice(ownerStart, ownerEnd);

const jobStart = controller.indexOf(
  '    const job = await GenerationJobManager.createJob(',
  ownerEnd,
);
const jobEnd = controller.indexOf('    if (job.duplicateOfStreamId)', jobStart);
const initializeStart = controller.indexOf('    const result = await initializeClient({', jobEnd);
const initializeEnd = controller.indexOf('    recordPassiveTextTurnBoundary', initializeStart);
const generationStart = controller.indexOf('    startGeneration().catch', initializeEnd);
if (!(
  ownerEnd < jobStart &&
  jobStart < jobEnd &&
  jobEnd < initializeStart &&
  initializeStart < initializeEnd &&
  initializeEnd < generationStart
)) {
  throw new Error('Compaction preparation/join/generation boundaries unavailable');
}
const policyStart = controller.indexOf('    req._viventiumDeliveryDispositionRequired =', ownerEnd);
const policyEnd = controller.indexOf(
  '    logger.debug(`[ResumableAgentController] Creating job`',
  policyStart,
);
if (!(ownerEnd < policyStart && policyStart < policyEnd && policyEnd < jobStart))
  throw new Error('Protected delivery policy boundary unavailable');
const actualPreparation =
  controller.slice(policyStart, policyEnd) +
  controller.slice(jobStart, jobEnd) +
  controller.slice(initializeStart, initializeEnd);

function preJobOwners({
  enabled = true,
  failedOwner = '',
  throwLogger = false,
  pendingCompaction = false,
  pendingInitialization = false,
} = {}) {
  const calls = [];
  const req = { body: { text: 'Private source text.' } };
  markVoiceLatencyStart(req, 'synthetic-request');
  req.viventiumVoiceLogLatency = enabled;
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const error = new Error('Private owner failure.');
  let releaseCompaction;
  const compaction = new Promise((resolve, reject) => {
    releaseCompaction = () => (failedOwner === 'compaction' ? reject(error) : resolve());
  });
  if (!pendingCompaction) releaseCompaction();
  // The real service returns a Promise and requests abort before its first await.
  // Its early rejection must be handled even while client preparation is pending.
  let releaseInitialization;
  const initialization = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  if (!pendingInitialization) releaseInitialization();
  const context = {
    req,
    logger: {
      debug: jest.fn(() => {
        if (throwLogger) throw new Error('Private logger.');
      }),
    },
    observeVoiceLatencyOperation,
    userId: 'synthetic-user',
    conversationId: 'synthetic-conversation',
    endpointOption: {},
    clientPresentation: null,
    getTrustedAdapterCapabilities: () => ({}),
    getTrustedDeliveryPolicy: () => ({}),
    GenerationJobManager: {
      createJob: jest.fn(async () => {
        calls.push('job');
        if (failedOwner === 'job') throw error;
        return { abortController: new AbortController() };
      }),
    },
    initializeClient: jest.fn(async () => {
      calls.push('initialize');
      await initialization;
      if (failedOwner === 'initialize') throw error;
      return { client: {} };
    }),
    startGeneration: jest.fn(() => {
      calls.push('generation');
      return Promise.resolve();
    }),
    isVoiceLatencyEnabled: (value) => value.viventiumVoiceLogLatency === true,
    resolveRequestStreamId: jest.fn(async () => {
      calls.push('stream');
      await wait;
      if (failedOwner === 'stream') throw error;
      return { streamId: 'synthetic-stream', requested: 'synthetic-requested' };
    }),
    captureRequestInteractionContext: jest.fn(async () => {
      calls.push('interaction');
      if (failedOwner === 'interaction') throw error;
      return { actor_kind: 'external_user', origin: 'interactive' };
    }),
    acquireInteractiveMainAdmissionFence: jest.fn(() => () => calls.push('release-fence')),
    yieldAcceptedMainCompaction: jest.fn(() => {
      calls.push('compaction');
      return compaction;
    }),
    resolveDeliveryDispositionRequirement: jest.fn(async () => {
      calls.push('delivery');
      if (failedOwner === 'delivery') throw error;
      return true;
    }),
    maybeDecrement: jest.fn(async () => calls.push('decrement')),
    res: { status: jest.fn().mockReturnThis(), json: jest.fn() },
  };
  const result = vm.runInNewContext(
    `(async () => {${ownerSource}
    try {
      ${actualPreparation}
      startGeneration();
      return { streamId, interactionContext, required: req._viventiumDeliveryDispositionRequired };
    } catch (error) {
      await maybeDecrement();
      throw error;
    }
  })()`,
    context,
  );
  return { context, result, calls, release, releaseCompaction, releaseInitialization, error };
}

describe('pre-job owner operation spans', () => {
  test.each([false, true])(
    'preserves sequential source/policy preparation enabled=%s',
    async (enabled) => {
      const probe = preJobOwners({ enabled });
      expect(probe.calls).toEqual(['stream']);
      expect(probe.context.logger.debug).not.toHaveBeenCalled();
      probe.release();
      await expect(probe.result).resolves.toMatchObject({
        streamId: 'synthetic-stream',
        required: true,
      });
      expect(probe.calls).toEqual([
        'stream',
        'interaction',
        'delivery',
        'job',
        'initialize',
        'generation',
      ]);
      const logs = probe.context.logger.debug.mock.calls;
      expect(logs.map(([, value]) => value.stage)).toEqual(
        enabled
          ? [
              'request_stream_identity_completed',
              'request_interaction_capture_completed',
              'request_delivery_policy_completed',
            ]
          : [],
      );
      expect(JSON.stringify(logs)).not.toContain('Private source text.');
    },
  );

  test.each(['stream', 'interaction'])(
    'preserves exact %s failure and existing preparation cleanup',
    async (failedOwner) => {
      const probe = preJobOwners({ failedOwner });
      probe.release();
      await expect(probe.result).rejects.toBe(probe.error);
      expect(probe.calls).not.toContain('delivery');
      expect(probe.calls).not.toContain('generation');
      if (failedOwner === 'interaction') expect(probe.calls).toContain('decrement');
      expect(JSON.stringify(probe.context.logger.debug.mock.calls)).not.toContain(
        probe.error.message,
      );
    },
  );

  test('real preparation and generation never cancel or join unrelated pending memory', async () => {
    const probe = preJobOwners({ pendingCompaction: true });
    probe.release();
    await probe.result;
    expect(probe.context.yieldAcceptedMainCompaction).not.toHaveBeenCalled();
    expect(probe.context.acquireInteractiveMainAdmissionFence).not.toHaveBeenCalled();
    expect(probe.context.startGeneration).toHaveBeenCalledTimes(1);
    expect(probe.calls).not.toContain('release-fence');
    probe.releaseCompaction();
  });

  test('generation still waits for its own client initialization', async () => {
    const probe = preJobOwners({ pendingInitialization: true, pendingCompaction: true });
    probe.release();
    await new Promise(setImmediate);
    expect(probe.context.startGeneration).not.toHaveBeenCalled();
    probe.releaseInitialization();
    await probe.result;
    expect(probe.context.startGeneration).toHaveBeenCalledTimes(1);
    expect(probe.context.yieldAcceptedMainCompaction).not.toHaveBeenCalled();
    probe.releaseCompaction();
  });

  test.each(['delivery', 'job', 'initialize'])(
    'preserves %s failure cleanup with unrelated memory pending',
    async (failedOwner) => {
      const probe = preJobOwners({ failedOwner, pendingCompaction: true });
      probe.release();
      await expect(probe.result).rejects.toBe(probe.error);
      expect(probe.context.startGeneration).not.toHaveBeenCalled();
      expect(probe.calls.at(-1)).toBe('decrement');
      if (failedOwner === 'delivery') {
        expect(probe.context.GenerationJobManager.createJob).not.toHaveBeenCalled();
        expect(probe.context.initializeClient).not.toHaveBeenCalled();
      }
      probe.releaseCompaction();
      await new Promise(setImmediate);
    },
  );

  test('logging failure cannot interrupt the original preparation', async () => {
    const probe = preJobOwners({ throwLogger: true });
    probe.release();
    await expect(probe.result).resolves.toMatchObject({ required: true });
    expect(probe.calls).toEqual([
      'stream',
      'interaction',
      'delivery',
      'job',
      'initialize',
      'generation',
    ]);
  });
});
/* === VIVENTIUM END === */

test('actual onStart awaits exact assistant binding before placeholder or preparation completion', async () => {
  let release;
  const bound = new Promise((resolve) => {
    release = resolve;
  });
  const bindResponse = jest.fn(() => bound);
  const control = preparation({ bindResponse });
  control.release();
  await new Promise(setImmediate);
  expect(bindResponse).toHaveBeenCalledWith({
    streamId: 'synthetic-stream',
    conversationId: 'synthetic-conversation',
    sourceMessageId: 'synthetic-user',
    responseMessageId: 'synthetic-response',
    interactionContext: { source_event_id: 'source', logical_turn_id: 'turn', revision: 1 },
  });
  expect(control.events).toEqual([]);
  release();
  await control.result;
  expect(control.events).toEqual(['placeholder', 'metadata', 'created']);
});

test.each([false, true])('actual onStart shares saved source proof without a second read (native=%s)', async (native) => {
  const sourceRow = { _id: 'synthetic-mongo-source', messageId: 'synthetic-user',
    parentMessageId: null, text: 'Source', content: [], files: ['owned-file'] };
  const hostContext = { origin: 'interactive', actor_kind: 'external_user', surface: 'web',
    conversation_id: 'synthetic-conversation', logical_turn_id: 'turn', revision: 1 };
  const control = preparation({ sourceRow, hostContext, native });
  control.release();
  await control.result;
  expect(control.context.req._viventiumHostResponseIdentity).toMatchObject({
    userId: 'synthetic-owner', conversationId: 'synthetic-conversation', responseMessageId: 'synthetic-response',
    streamId: 'synthetic-stream', jobCreatedAt: 1, logicalTurnId: 'turn', revision: 1, surface: 'web',
    source: { id: 'synthetic-mongo-source', messageId: 'synthetic-user', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(await control.context.req._viventiumHostResponseIsCurrent()).toBe(true);
  control.context.job.abortController.abort();
  expect(await control.context.req._viventiumHostResponseIsCurrent()).toBe(false);
  expect(Boolean(control.context.req._viventiumNativeResponseSource)).toBe(native);
});
