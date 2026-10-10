// VIVENTIUM START: classifier lifecycle shares the existing typed owner cancellation gate.
jest.mock('../Config/app', () => ({
  getAppConfig: jest.fn(async () => ({ endpoints: { custom: [] } })),
}));
const { checkCortexActivation } = require('../BackgroundCortexService');

describe('BackgroundCortexService activation cancellation', () => {
  test.each(['user_cancelled', 'maintenance_yield'])(
    'stops a pending classifier on exact owner %s without a fallback invocation',
    async (reason) => {
      const { Run } = require('@librechat/agents');
      const owner = new AbortController();
      let resolveStream;
      let resolveStarted;
      const started = new Promise((resolve) => {
        resolveStarted = resolve;
      });
      const create = jest.spyOn(Run, 'create').mockResolvedValue({
        processStream: jest.fn((_input, config) => {
          resolveStarted(config.signal);
          return new Promise((resolve) => {
            resolveStream = resolve;
          });
        }),
      });
      let terminal = false;
      const resultPromise = checkCortexActivation({
        cortexConfig: {
          agent_id: 'cancelled-classifier',
          activation: {
            provider: 'groq',
            model: 'synthetic-classifier',
            reasoning_effort: 'high',
            fallbacks: [
              { provider: 'anthropic', model: 'claude-opus-5-5', reasoning_effort: 'high' },
            ],
          },
        },
        messages: [],
        runId: 'cancelled-classifier-run',
        timeoutMs: 6000,
        req: {
          user: { id: 'synthetic-owner' },
          body: {},
          config: {
            endpoints: { custom: [], agents: { activationOpenAITransportProviders: ['groq'] } },
          },
          _viventiumVoiceAbortSignal: owner.signal,
        },
      }).then((result) => {
        terminal = true;
        return result;
      });
      try {
        const runSignal = await Promise.race([
          started,
          resultPromise.then((result) => {
            throw new Error(`classifier failed before mocked stream: ${JSON.stringify(result)}`);
          }),
        ]);
        owner.abort(reason);
        await new Promise((resolve) => setImmediate(resolve));
        expect(terminal).toBe(true);
        expect(runSignal.aborted).toBe(true);
        expect(runSignal.reason).toBe(reason);
        expect(await resultPromise).toMatchObject({ shouldActivate: false, reason: 'cancelled' });
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        resolveStream?.('{"activate":false,"confidence":0.9,"reason":"late result"}');
        await resultPromise;
        create.mockRestore();
      }
    },
  );

  test('generation completion does not cancel the same classifier or invoke a fallback', async () => {
    const { Run } = require('@librechat/agents');
    const owner = new AbortController();
    owner.abort('generation_completed');
    let runSignal;
    const create = jest.spyOn(Run, 'create').mockResolvedValue({
      processStream: jest.fn(async (_input, config) => {
        runSignal = config.signal;
        return '{"activate":false,"confidence":0.9,"reason":"valid decision"}';
      }),
    });
    try {
      const result = await checkCortexActivation({
        cortexConfig: {
          agent_id: 'detached-classifier',
          activation: {
            provider: 'groq',
            model: 'synthetic-classifier',
            reasoning_effort: 'high',
            fallbacks: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
          },
        },
        messages: [],
        runId: 'detached-classifier-run',
        timeoutMs: 6000,
        req: {
          user: { id: 'synthetic-owner' },
          body: {},
          config: {
            endpoints: { custom: [], agents: { activationOpenAITransportProviders: ['groq'] } },
          },
          _viventiumVoiceAbortSignal: owner.signal,
        },
      });
      expect(result).toMatchObject({ shouldActivate: false, reason: 'valid decision' });
      expect(runSignal.aborted).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
    }
  });
});
// VIVENTIUM END
