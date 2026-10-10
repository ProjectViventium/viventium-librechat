const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the production wiring, rather than only its already-tested policy helper.
const source = fs.readFileSync(
  process.env.VIVENTIUM_TEST_PHASE_A_CLIENT_SOURCE || path.join(__dirname, 'client.js'),
  'utf8',
);
const selectionStart = source.indexOf(
  '        onePassNonblockingMode = shouldRunOnePassNonblockingPhaseA({',
);
const selectionEnd = source.indexOf('        if (speculativeMode) {', selectionStart);
const onePassStart = source.indexOf('        if (onePassNonblockingMode) {', selectionEnd);
const onePassEnd = source.indexOf('        /* === VIVENTIUM END === */', onePassStart);
const helperStart = source.indexOf('function shouldRunOnePassNonblockingPhaseA(');
const helperEnd = source.indexOf('\nfunction resolveParallelDetectionNoticeMode', helperStart);
const budgetStart = source.indexOf('function getOnePassDetectionTimeoutMs(');
const budgetEnd = source.indexOf('\nfunction ', budgetStart + 1);
const runnerStart = source.indexOf('function startOnePassNonblockingMain(');
const runnerEnd = source.indexOf('\nfunction startParallelPhaseBRecovery', runnerStart);

describe('AgentClient production Phase A startup wiring', () => {
  test.each([
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ])('Main startup respects its async policy (native=%s, enabled=%s)', async (native, enabled) => {
    let resolveDetection;
    const pending = new Promise((resolve) => {
      resolveDetection = resolve;
    });
    const detectActivations = jest.fn(() => pending);
    const context = {
      req: { _viventiumHarnessExecutionEnabled: native },
      voicePhaseAPolicy: { enabled },
      speculativeMode: false,
      onePassNonblockingMode: false,
      onePassDetectionPromise: null,
      onePassDetectTimeoutMs: null,
      getCortexLateDetectTimeoutMs: () => 6000,
      shouldRunLiveSpeculativePhaseA: ({ policy }) => policy.enabled,
      detectActivations,
      initialMessages: [{ role: 'user', content: 'A routine question.' }],
      cortexDetectTimeoutMs: 100,
      phaseANoticeMode: 'all_within_budget',
      logger: { info() {} },
      options: { agent: { id: 'synthetic-agent' } },
      responseMessageId: 'synthetic-response',
    };
    vm.runInNewContext(
      source.slice(helperStart, helperEnd) +
        '\n' +
        source.slice(budgetStart, budgetEnd) +
        '\n' +
        source.slice(runnerStart, runnerEnd) +
        '\n' +
        source.slice(selectionStart, selectionEnd) +
        '\n' +
        source.slice(onePassStart, onePassEnd),
      context,
    );
    if (!enabled) {
      expect(context.onePassNonblockingMode).toBe(false);
      expect(context.speculativeMode).toBe(false);
      expect(detectActivations).not.toHaveBeenCalled();
      return;
    }
    expect(context.onePassNonblockingMode).toBe(true);
    expect(context.speculativeMode).toBe(false);
    expect(detectActivations).toHaveBeenCalledTimes(1);
    expect(detectActivations.mock.calls[0][0].mainAgent.id).toBe('synthetic-agent');
    expect(detectActivations.mock.calls[0][0].timeBudgetMs).toBe(6000);
    const runMain = jest.fn().mockResolvedValue('one answer');
    const onDetection = jest.fn(({ result }) => result.activatedCortices);
    const running = context.startOnePassNonblockingMain({
      runMain,
      detectionPromise: context.onePassDetectionPromise,
      onDetection,
    });
    await expect(running.mainPromise).resolves.toBe('one answer');
    expect(runMain).toHaveBeenCalledTimes(1);
    expect(onDetection).not.toHaveBeenCalled();
    const activatedCortices = native ? [{ agentId: 'synthetic-background' }] : [];
    resolveDetection({ activatedCortices });
    await expect(running.backgroundPromise).resolves.toEqual(activatedCortices);
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(runMain).toHaveBeenCalledTimes(1);
  });

  test('early initial Phase B starts before the same final detection settles and new IDs run once', async () => {
    let resolveFinal;
    let resolveInitial;
    const finalDetectionPromise = new Promise((resolve) => {
      resolveFinal = resolve;
    });
    const initialExecution = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    const early = [{ agentId: 'deep-memory' }];
    const executeOnePassCortices = jest.fn((cortices) =>
      cortices.some((cortex) => cortex.agentId === 'deep-memory')
        ? initialExecution
        : Promise.resolve(),
    );
    const context = {
      mainInvocationStarted: true,
      activatedCorticesList: [],
      options: { req: {}, agent: {} },
      onePassDetectTimeoutMs: 6000,
      cortexDetectTimeoutMs: 6000,
      getCortexLateDetectTimeoutMs: () => 0,
      emitOnePassActivationCards: jest.fn(async () => undefined),
      executeOnePassCortices,
      detectActivations: jest.fn(),
      pendingCortexParts: [],
      buildMergedInsightsDataFromCortexParts: jest.fn(() => 'completed'),
      logger: { error: jest.fn() },
      sanitizeCompletionErrorForLog: (error) => error,
    };
    const mergeStart = source.indexOf('function mergeLateActivationCandidates(');
    const mergeEnd = source.indexOf('\n/* === VIVENTIUM START ===', mergeStart);
    const recoveryStart = source.indexOf('function startParallelPhaseBRecovery(');
    const recoveryEnd = source.indexOf(
      '\nfunction shouldSuppressSpeculativeRunError(',
      recoveryStart,
    );
    const handlerStart = source.indexOf('        const handleOnePassDetection = async');
    const handlerEnd = source.indexOf(
      '\n        const onePass = startOnePassNonblockingMain(',
      handlerStart,
    );
    vm.runInNewContext(
      source.slice(mergeStart, mergeEnd) +
        '\n' +
        source.slice(recoveryStart, recoveryEnd) +
        '\n' +
        source.slice(handlerStart, handlerEnd) +
        '\nglobalThis.handleDetection = handleOnePassDetection;',
      context,
    );
    const completion = context.handleDetection({
      result: {
        earlyReturned: true,
        activatedCortices: early,
        finalDetectionPromise,
      },
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(executeOnePassCortices).toHaveBeenCalledTimes(1);
      expect(executeOnePassCortices).toHaveBeenCalledWith(early, 'initial');
      expect(context.detectActivations).not.toHaveBeenCalled();
      resolveFinal({
        timedOut: false,
        activatedCortices: [...early, { agentId: 'support' }, ...early],
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        executeOnePassCortices.mock.calls.flatMap(([cortices]) =>
          cortices.map((cortex) => cortex.agentId),
        ),
      ).toEqual(['deep-memory', 'support']);
      resolveInitial();
      await expect(completion).resolves.toBe('completed');
      expect(context.detectActivations).not.toHaveBeenCalled();
      expect(
        context.emitOnePassActivationCards.mock.calls.flatMap(([cortices]) =>
          cortices.map((cortex) => cortex.agentId),
        ),
      ).toEqual(['deep-memory', 'support']);
    } finally {
      resolveFinal({ timedOut: false, activatedCortices: early });
      resolveInitial();
      await completion;
    }
  });
});
