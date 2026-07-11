const {
  installUnifiedSchemaToolBindingPatch,
  sameToolList,
} = require('../agentSchemaToolBindingPatch');

describe('agentSchemaToolBindingPatch', () => {
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
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
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
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
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
});
