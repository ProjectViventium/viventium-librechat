/* === VIVENTIUM START ===
 * Purpose: Prove the GlassHive deferred-discovery instruction shape returns a
 * discoverable artifact and makes that schema eligible in the same invocation.
 * Porting: Copy this file wholesale when reapplying Viventium changes.
 * === VIVENTIUM END === */

const { AIMessageChunk, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { createToolSearch, extractToolDiscoveries } = require('@librechat/agents');
const { installUnifiedSchemaToolBindingPatch } = require('../agentSchemaToolBindingPatch');

describe('GlassHive deferred discovery', () => {
  const artifactToolName = 'workspace_artifacts_mcp_glasshive-workers-projects';

  const createRegistry = () =>
    new Map([
      [
        artifactToolName,
        {
          name: artifactToolName,
          description: 'List workspace artifacts and files',
          parameters: {},
          defer_loading: true,
        },
      ],
      [
        'worker_pause_mcp_glasshive-workers-projects',
        {
          name: 'worker_pause_mcp_glasshive-workers-projects',
          description: 'Pause a running worker',
          parameters: {},
          defer_loading: true,
        },
      ],
      [
        'search_gmail_mcp_google_workspace',
        {
          name: 'search_gmail_mcp_google_workspace',
          description: 'Search Gmail',
          parameters: {},
          defer_loading: true,
        },
      ],
    ]);

  const executeSearch = async (params) => {
    const search = createToolSearch({ toolRegistry: createRegistry(), mode: 'local' });
    return search.func(params, { getChild: () => undefined }, {});
  };

  it('requires a non-empty query because server listing mode discovers no callable schema', async () => {
    const [, artifact] = await executeSearch({
      mcp_server: 'glasshive-workers-projects',
    });

    expect(artifact.metadata.listing_mode).toBe(true);
    expect(artifact.tool_references).toEqual([]);
  });

  it('discovers the scoped capability and binds it during the same invocation', async () => {
    const [content, artifact] = await executeSearch({
      query: 'workspace artifacts',
      mcp_server: 'glasshive-workers-projects',
    });
    const messages = [
      new HumanMessage('Show the workspace artifacts'),
      new AIMessageChunk({
        content: '',
        tool_calls: [
          {
            id: 'search-call',
            name: 'tool_search',
            args: {
              query: 'workspace artifacts',
              mcp_server: 'glasshive-workers-projects',
            },
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({
        content,
        tool_call_id: 'search-call',
        name: 'tool_search',
        artifact,
      }),
    ];
    const discoveredNames = extractToolDiscoveries(messages);
    const originalTools = [];
    const eagerTool = { name: 'workspace_launch_mcp_glasshive-workers-projects' };
    const discoveredTool = { name: artifactToolName, defer_loading: true };
    const agentContext = {
      tools: originalTools,
      getToolsForBinding: jest.fn(() => [
        eagerTool,
        ...(discoveredNames.includes(artifactToolName) ? [discoveredTool] : []),
      ]),
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

    expect(artifact.tool_references.map((reference) => reference.tool_name)).toEqual([
      artifactToolName,
    ]);
    expect(discoveredNames).toEqual([artifactToolName]);
    expect(installUnifiedSchemaToolBindingPatch(fakeProto)).toBe(true);
    const fakeGraph = { agentContexts: new Map([['default', agentContext]]) };
    const callModel = fakeProto.createCallModel.call(fakeGraph, 'default');

    await callModel({ messages }, {});

    expect(observed.tools.map((tool) => tool.name)).toEqual([
      'workspace_launch_mcp_glasshive-workers-projects',
      artifactToolName,
    ]);
    expect(agentContext.tools).toBe(originalTools);
  });
});
