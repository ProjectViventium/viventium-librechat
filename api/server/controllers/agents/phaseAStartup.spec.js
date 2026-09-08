const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the production wiring, rather than only its already-tested policy helper.
const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const selectionStart = source.indexOf('        speculativeMode =\n');
const selectionEnd = source.indexOf('        if (speculativeMode) {', selectionStart);
const onePassStart = source.indexOf('        if (onePassNonblockingMode) {', selectionEnd);
const onePassEnd = source.indexOf('        /* === VIVENTIUM END === */', onePassStart);
const helperStart = source.indexOf('function shouldRunOnePassNonblockingPhaseA(');
const helperEnd = source.indexOf('\nfunction resolveParallelDetectionNoticeMode', helperStart);
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
});
