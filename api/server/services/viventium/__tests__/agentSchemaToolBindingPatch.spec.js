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
});
