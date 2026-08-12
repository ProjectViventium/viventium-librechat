const { SystemMessage } = require('@langchain/core/messages');
const {
  installUnifiedSchemaToolBindingPatch,
  sameToolList,
} = require('../agentSchemaToolBindingPatch');

describe('agentSchemaToolBindingPatch', () => {
  const capabilityRefreshSymbol = Symbol.for('viventium.agent.model.route.capability.refresh.v1');
  const fallbackContextSymbol = Symbol.for('viventium.agent.graph.fallback.runtime.context.v1');

  it('treats tool lists with matching names as equivalent', () => {
    expect(sameToolList([{ name: 'file_search' }], [{ lc_kwargs: { name: 'file_search' } }])).toBe(
      true,
    );
    expect(sameToolList([{ name: 'file_search' }], [{ name: 'execute_code' }])).toBe(false);
  });

  it('exposes unified schema tools during a model call and restores the context afterward', async () => {
    const originalTools = [];
    const unifiedTools = [{ name: 'file_search' }, { lc_kwargs: { name: 'graph_handoff' } }];
    const agentContext = {
      tools: originalTools,
      getToolsForBinding: jest.fn(() => unifiedTools),
    };
    const observed = {};
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          const context = graph.agentContexts.get(agentId);
          observed.tools = context.tools;
          observed.bindingTools = context.getToolsForBinding();
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = Object.assign(Object.create(fakeProto), {
      agentContexts: new Map([['default', agentContext]]),
    });
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await callModel({ messages: [] }, {});

    expect(observed.tools).toBe(unifiedTools);
    expect(observed.bindingTools).toBe(unifiedTools);
    expect(agentContext.tools).toBe(originalTools);
    expect(agentContext.getToolsForBinding()).toBe(unifiedTools);
  });

  it('keeps unified tools invocation-scoped across overlapping calls', async () => {
    const originalTools = [];
    const unifiedTools = [{ name: 'file_search' }];
    const agentContext = {
      tools: originalTools,
      getToolsForBinding: jest.fn(() => unifiedTools),
    };
    const releases = [];
    const starts = [];
    const observations = [];
    let callCount = 0;
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          const index = callCount++;
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          releases[index] = release;
          starts[index]?.();
          await gate;
          observations[index] = graph.agentContexts.get(agentId).tools;
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = Object.assign(Object.create(fakeProto), {
      agentContexts: new Map([['default', agentContext]]),
    });
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    const firstStarted = new Promise((resolve) => {
      starts[0] = resolve;
    });
    const first = callModel({ messages: [] }, {});
    await firstStarted;
    expect(agentContext.tools).toBe(originalTools);

    const secondStarted = new Promise((resolve) => {
      starts[1] = resolve;
    });
    const second = callModel({ messages: [] }, {});
    await secondStarted;

    releases[0]();
    await first;
    releases[1]();
    await second;

    expect(observations).toEqual([unifiedTools, unifiedTools]);
    expect(agentContext.tools).toBe(originalTools);
  });

  it('includes schema tools discovered after the invocation begins', async () => {
    const originalTools = [];
    let unifiedTools = [{ name: 'base' }];
    const agentContext = {
      tools: originalTools,
      toolDefinitions: [{ name: 'base' }, { name: 'newly_discovered', defer_loading: true }],
      getToolsForBinding: jest.fn(function getToolsForBinding() {
        return [...this.tools, ...unifiedTools];
      }),
    };
    const observed = {};
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          unifiedTools = [{ name: 'base' }, { name: 'newly_discovered' }];
          observed.tools = graph.agentContexts.get(agentId).tools;
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await callModel({ messages: [] }, {});

    expect(observed.tools).toEqual([{ name: 'base' }, { name: 'newly_discovered' }]);
    expect(agentContext.tools).toBe(originalTools);
  });

  it('does not feed scoped schema tools back into the event-driven binding merge', async () => {
    const originalTools = [];
    const schemaTools = [{ name: 'schedule_create_mcp_scheduling-cortex' }];
    const agentContext = {
      tools: originalTools,
      toolDefinitions: [{ name: 'schedule_create_mcp_scheduling-cortex' }],
      getToolsForBinding() {
        return [...schemaTools, ...(this.tools ?? [])];
      },
    };
    const observed = {};
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          observed.bindingTools = graph.agentContexts.get(agentId).getToolsForBinding();
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await callModel({ messages: [] }, {});

    expect(observed.bindingTools).toEqual(schemaTools);
    expect(agentContext.tools).toBe(originalTools);
  });

  it('keeps dynamic unified tools scoped across overlapping calls', async () => {
    const originalTools = [];
    const dynamicTools = [{ name: 'file_search' }, { name: 'newly_discovered' }];
    const agentContext = {
      tools: originalTools,
      toolDefinitions: [{ name: 'newly_discovered', defer_loading: true }],
      getToolsForBinding() {
        return [...this.tools, ...dynamicTools];
      },
    };
    const releases = [];
    const starts = [];
    const observations = [];
    let callCount = 0;
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          const index = callCount++;
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          releases[index] = release;
          starts[index]?.();
          await gate;
          observations[index] = graph.agentContexts.get(agentId).tools;
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    const firstStarted = new Promise((resolve) => {
      starts[0] = resolve;
    });
    const first = callModel({ messages: [] }, {});
    await firstStarted;

    const secondStarted = new Promise((resolve) => {
      starts[1] = resolve;
    });
    const second = callModel({ messages: [] }, {});
    await secondStarted;

    releases[1]();
    await second;
    releases[0]();
    await first;

    expect(observations).toEqual([dynamicTools, dynamicTools]);
    expect(agentContext.tools).toBe(originalTools);
  });

  it('does not recurse when empty definitions are combined with graph tools', async () => {
    const originalTools = [];
    const graphTools = [{ name: 'file_search' }];
    const agentContext = {
      tools: originalTools,
      toolDefinitions: [],
      graphTools,
      getToolsForBinding() {
        return [...(this.tools ?? []), ...this.graphTools];
      },
    };
    const observed = {};
    const fakeProto = {
      createCallModel(agentId = 'default') {
        const graph = this;
        return async function fakeCallModel() {
          observed.tools = graph.agentContexts.get(agentId).tools;
          return { messages: [] };
        };
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await expect(callModel({ messages: [] }, {})).resolves.toEqual({ messages: [] });
    expect(observed.tools).toEqual(graphTools);
    expect(agentContext.tools).toBe(originalTools);
  });

  it('rejects an aborted graph attempt before invoking any primary or fallback provider', async () => {
    const providerInvoke = jest.fn(async () => ({ messages: [] }));
    const capabilityRefresh = jest.fn();
    const fakeProto = {
      createCallModel() {
        const graph = this;
        return async (_state, config) =>
          graph.attemptInvoke(
            { provider: 'synthetic', finalMessages: [], currentModel: {} },
            config,
          );
      },
      attemptInvoke(...args) {
        return providerInvoke(...args);
      },
    };
    const abortController = new AbortController();
    abortController.abort();

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const agentContext = { clientOptions: {} };
    Object.defineProperty(agentContext.clientOptions, capabilityRefreshSymbol, {
      value: capabilityRefresh,
      enumerable: false,
    });
    const fakeGraph = Object.assign(Object.create(fakeProto), {
      agentContexts: new Map([['default', agentContext]]),
    });
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');
    await expect(
      callModel({ messages: [] }, { signal: abortController.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerInvoke).not.toHaveBeenCalled();
    expect(capabilityRefresh).not.toHaveBeenCalled();
  });

  it('rechecks Stop after an asynchronous capability refresh and before provider invocation', async () => {
    const abortController = new AbortController();
    const providerInvoke = jest.fn(async () => ({ messages: [] }));
    const capabilityRefresh = jest.fn(async () => {
      abortController.abort('user_cancelled');
      return { attached: true, defaultHeaders: {} };
    });
    const fakeProto = {
      createCallModel() {
        const graph = this;
        return async (_state, config) =>
          graph.attemptInvoke(
            { provider: 'synthetic', finalMessages: [], currentModel: {} },
            config,
          );
      },
      attemptInvoke(...args) {
        return providerInvoke(...args);
      },
    };

    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const clientOptions = {};
    Object.defineProperty(clientOptions, capabilityRefreshSymbol, {
      value: capabilityRefresh,
      enumerable: false,
    });
    const fakeGraph = Object.assign(Object.create(fakeProto), {
      agentContexts: new Map([['default', { clientOptions }]]),
    });
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await expect(
      callModel({ messages: [] }, { signal: abortController.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(capabilityRefresh).toHaveBeenCalledTimes(1);
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'fresh fallback authority',
      fallbackInstructionAppend: 'Fresh fallback capability authority.',
    },
    {
      label: 'an intentionally empty fallback authority after a null projection',
      fallbackInstructionAppend: '',
    },
  ])(
    'refreshes the exact primary and recoverable fallback routes immediately before invocation with $label',
    async ({ fallbackInstructionAppend }) => {
      const calls = [];
      const observedSystemMessages = [];
      const primaryRefresh = jest.fn(async () => {
        calls.push('primary-refresh');
        return {
          previousInstructionAppend: 'Old primary capability claim.',
          instructionAppend: 'Primary capability is unavailable now.',
        };
      });
      const fallbackRefresh = jest.fn(async () => {
        calls.push('fallback-refresh');
        return {
          previousInstructionAppend: 'Old fallback capability claim.',
          instructionAppend: fallbackInstructionAppend,
        };
      });
      const fallbackClientOptions = { model: 'synthetic-fallback' };
      Object.defineProperty(fallbackClientOptions, capabilityRefreshSymbol, {
        value: fallbackRefresh,
        enumerable: false,
      });
      Object.defineProperty(fallbackClientOptions, fallbackContextSymbol, {
        value: Object.freeze({
          provider: 'synthetic-fallback-provider',
          model: 'synthetic-fallback',
        }),
        enumerable: false,
      });
      const fakeProto = {
        createCallModel(agentId = 'default') {
          const graph = this;
          return async function fakeCallModel(state, config) {
            try {
              return await graph.attemptInvoke(
                {
                  provider: 'synthetic-primary-provider',
                  finalMessages: state.messages,
                  currentModel: {},
                },
                config,
              );
            } catch (_) {
              const currentModel = graph.getNewModel({
                provider: 'synthetic-fallback-provider',
                clientOptions: fallbackClientOptions,
              });
              return graph.attemptInvoke(
                {
                  provider: 'synthetic-fallback-provider',
                  finalMessages: state.messages,
                  currentModel,
                },
                config,
              );
            }
          };
        },
        async attemptInvoke(input) {
          observedSystemMessages.push(
            input.finalMessages.map((message) => message.content).join('\n'),
          );
          if (input.provider === 'synthetic-primary-provider') {
            calls.push('primary-invoke-429');
            throw Object.assign(new Error('synthetic rate limit'), { status: 429 });
          }
          calls.push('fallback-invoke');
          return { messages: [] };
        },
        getNewModel({ clientOptions }) {
          return { clientOptions };
        },
      };

      expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
      const primaryClientOptions = {};
      Object.defineProperty(primaryClientOptions, capabilityRefreshSymbol, {
        value: primaryRefresh,
        enumerable: false,
      });
      const fakeGraph = Object.assign(Object.create(fakeProto), {
        agentContexts: new Map([
          [
            'default',
            {
              clientOptions: primaryClientOptions,
              systemRunnable: {
                invoke: jest.fn(async () => [
                  new SystemMessage('Fallback base.\n\nOld fallback capability claim.'),
                ]),
              },
            },
          ],
        ]),
      });
      const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

      await expect(
        callModel(
          { messages: [new SystemMessage('Primary base.\n\nOld primary capability claim.')] },
          {},
        ),
      ).resolves.toEqual({ messages: [] });
      expect(calls).toEqual([
        'primary-refresh',
        'primary-invoke-429',
        'fallback-refresh',
        'fallback-invoke',
      ]);
      expect(primaryRefresh).toHaveBeenCalledTimes(1);
      expect(fallbackRefresh).toHaveBeenCalledTimes(1);
      expect(observedSystemMessages[0]).not.toContain('Old primary capability claim.');
      expect(observedSystemMessages[0]).toContain('Primary capability is unavailable now.');
      expect(observedSystemMessages[1]).not.toContain('Old fallback capability claim.');
      if (fallbackInstructionAppend) {
        expect(observedSystemMessages[1]).toContain(fallbackInstructionAppend);
      }
    },
  );
});
