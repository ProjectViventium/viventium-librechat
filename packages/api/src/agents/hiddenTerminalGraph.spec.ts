/* === VIVENTIUM START === Hidden foreground results complete the accepted consult pair. === */
import { AIMessageChunk, HumanMessage, isToolMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { installLibreChatAgentsHandoffResultPatch } from './handoffResultProvenance';

const agents = jest.requireActual('@librechat/agents');
const api = jest.requireActual('@librechat/api');
api.installLibreChatAgentsGraphStartPatch(agents);
installLibreChatAgentsHandoffResultPatch(agents);

const transfer = (id: string, destination: string, content = '', args = {}) =>
  new AIMessageChunk({
    id: `${id}-ai`,
    content,
    tool_call_chunks: [
      {
        id,
        name: `lc_transfer_to_${destination}`,
        args: JSON.stringify(args),
        index: 0,
        type: 'tool_call_chunk',
      },
    ],
  });
const terminal = (id: string, content: string) =>
  new AIMessageChunk({
    id,
    content,
    additional_kwargs: { selectedArtifact: { version: 1, fileId: 'owned-file', bytes: 19 } },
  });
const config = (run = 'run-one', overrides = {}) => ({
  version: 'v2',
  recursionLimit: 12,
  metadata: { run_id: run, thread_id: 'thread-one' },
  configurable: {
    run_id: run,
    thread_id: 'thread-one',
    hide_sequential_outputs: true,
    main_agent_id: 'main',
    visible_agent_id: 'main',
    visible_agent_ids: ['main'],
    ...overrides,
  },
});
function fixture(
  script: ((messages: any[]) => AIMessageChunk)[],
  edges: any[] = [
    { from: 'main', to: 'specialist', edgeType: 'handoff' },
    { from: 'specialist', to: 'main', edgeType: 'handoff' },
  ],
  ids = ['main', 'specialist'],
) {
  const graph = new agents.MultiAgentGraph({
    runId: 'test-hidden-terminal',
    agents: ids.map((agentId) => ({
      agentId,
      name: agentId,
      provider: agents.Providers.OPENAI,
      clientOptions: { model: 'test-model', apiKey: 'test-key' },
    })),
    edges,
  });
  const calls: any[][] = [];
  graph.overrideModel = {
    async *stream(messages: any[]) {
      calls.push(messages);
      const action = script[calls.length - 1];
      if (!action) throw new Error('unexpected_extra_model_invocation');
      yield action(messages);
    },
  };
  return {
    graph,
    calls,
    invoke: (cfg = config()) =>
      graph
        .createWorkflow()
        .invoke(
          {
            messages: [
              new HumanMessage({ id: 'user', content: 'Create and verify the requested file.' }),
            ],
            agentMessages: [],
          },
          cfg,
        ),
  };
}
const completedResult = (messages: any[], id = 'consult') =>
  messages.find((message) => isToolMessage(message) && message.tool_call_id === id);

test('installed SDK resumes Main with the original call and exact terminal evidence and metadata', async () => {
  const t = fixture([
    () => transfer('consult', 'specialist', 'Preparing the file.'),
    () => terminal('child-final', 'Verified 19 bytes with a newline.'),
    (messages) => {
      const result = completedResult(messages);
      expect(result.content).toBe('Verified 19 bytes with a newline.');
      expect(result.additional_kwargs.selectedArtifact).toEqual({
        version: 1,
        fileId: 'owned-file',
        bytes: 19,
      });
      expect(messages.find((message) => message.id === 'consult-ai').tool_calls[0].id).toBe(
        'consult',
      );
      expect(messages.some((message) => message.id === 'child-final')).toBe(false);
      return terminal('main-final', 'The verified file is ready.');
    },
  ]);
  const result = await t.invoke();
  expect(t.calls).toHaveLength(3);
  expect(result.messages.at(-1).id).toBe('main-final');
});

test('input-bearing consult instructions remain in the same accepted run', async () => {
  const t = fixture(
    [
      () =>
        transfer('consult', 'specialist', '', { instructions: 'Verify the requested artifact.' }),
      () => terminal('child-final', 'Verified.'),
      (messages) => {
        expect(completedResult(messages).content).toBe('Verified.');
        return terminal('main-final', 'Done.');
      },
    ],
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff', prompt: 'Factual input.' },
      { from: 'specialist', to: 'main', edgeType: 'handoff' },
    ],
  );
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
});

test('empty child evidence returns once without an automatic consult or repair loop', async () => {
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => terminal('child-final', ''),
    (messages) => {
      expect(completedResult(messages).content).toBe('');
      return terminal('main-final', 'The consult returned no evidence.');
    },
  ]);
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(3);
});

test('nested hidden consults return to the actual pending caller, then Main', async () => {
  const t = fixture(
    [
      () => transfer('outer', 'specialist'),
      () => transfer('inner', 'checker'),
      () => terminal('checker-final', 'Inner verified.'),
      (messages) => {
        expect(completedResult(messages, 'inner').content).toBe('Inner verified.');
        return terminal('specialist-final', 'Outer verified with inner evidence.');
      },
      (messages) => {
        expect(completedResult(messages, 'outer').content).toBe(
          'Outer verified with inner evidence.',
        );
        return terminal('main-final', 'The result is verified.');
      },
    ],
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff' },
      { from: 'specialist', to: 'main', edgeType: 'handoff' },
      { from: 'specialist', to: 'checker', edgeType: 'handoff' },
      { from: 'checker', to: 'specialist', edgeType: 'handoff' },
    ],
    ['main', 'specialist', 'checker'],
  );
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(5);
});

test.each([
  ['visible specialist', { visible_agent_ids: ['main', 'specialist'] }, undefined],
  ['presentation disabled', { hide_sequential_outputs: false }, undefined],
  ['no visible Main', { visible_agent_ids: ['other'] }, undefined],
  ['no declared return', {}, [{ from: 'main', to: 'specialist', edgeType: 'handoff' }]],
  [
    'conditional return',
    {},
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff' },
      { from: 'specialist', to: 'main', edgeType: 'handoff', condition: () => false },
    ],
  ],
])('does not invent a continuation for %s', async (_name, overrides, edges) => {
  const t = fixture(
    [() => transfer('consult', 'specialist'), () => terminal('child-final', 'Evidence.')],
    edges,
  );
  const result = await t.invoke(config('run-one', overrides));
  expect(t.calls).toHaveLength(2);
  expect(result.messages.at(-1).id).toBe('child-final');
});

test('an explicit model-authored return retains the installed handoff path', async () => {
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => transfer('return', 'main', 'Verified.'),
    (messages) => {
      expect(completedResult(messages).content).toBe('Verified.');
      return terminal('main-final', 'Done.');
    },
  ]);
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(3);
});

test('abort after specialist output prevents caller continuation', async () => {
  const controller = new AbortController();
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => {
      controller.abort();
      return terminal('child-final', 'Evidence.');
    },
  ]);
  await expect(t.invoke({ ...config(), signal: controller.signal })).rejects.toThrow();
  expect(t.calls).toHaveLength(2);
});

test('reusing the same compiled workflow and message IDs cannot replay a completed consult', async () => {
  const script = [
    () => transfer('consult', 'specialist'),
    () => terminal('child-final', 'First.'),
    (messages: any[]) => {
      expect(completedResult(messages).content).toBe('First.');
      return terminal('main-final', 'First final.');
    },
    () => transfer('consult', 'specialist'),
    () => terminal('child-final', 'Second.'),
    (messages: any[]) => {
      expect(completedResult(messages).content).toBe('Second.');
      return terminal('main-final', 'Second final.');
    },
  ];
  const t = fixture(script);
  const workflow = t.graph.createWorkflow();
  const input = () => ({
    messages: [new HumanMessage({ id: 'user', content: 'The request.' })],
    agentMessages: [],
  });
  expect((await workflow.invoke(input(), config('one'))).messages.at(-1).content).toBe(
    'First final.',
  );
  expect((await workflow.invoke(input(), config('two'))).messages.at(-1).content).toBe(
    'Second final.',
  );
  expect(t.calls).toHaveLength(6);
});

test('actual installed Run.processStream supplies the run fence from normal client-shaped config', async () => {
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => terminal('child-final', 'Verified.'),
    (messages) => {
      expect(completedResult(messages).content).toBe('Verified.');
      return terminal('main-final', 'Done.');
    },
  ]);
  const run = await agents.Run.create({
    runId: 'actual-response-id',
    skipCleanup: true,
    graphConfig: {
      type: 'multi-agent',
      agents: ['main', 'specialist'].map((agentId) => ({
        agentId,
        name: agentId,
        provider: agents.Providers.OPENAI,
        clientOptions: { model: 'test-model', apiKey: 'test-key' },
      })),
      edges: [
        { from: 'main', to: 'specialist', edgeType: 'handoff' },
        { from: 'specialist', to: 'main', edgeType: 'handoff' },
      ],
    },
  });
  class ScriptedModel extends FakeListChatModel {
    constructor() {
      super({ responses: [''] });
    }
    async *_streamResponseChunks(messages: any[], _options: any, runManager?: any) {
      for await (const chunk of t.graph.overrideModel.stream(messages)) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        yield new ChatGenerationChunk({ text, message: chunk });
        await runManager?.handleLLMNewToken(text);
      }
    }
  }
  run.Graph.overrideModel = new ScriptedModel();
  const cfg = config();
  delete (cfg.configurable as any).run_id;
  (cfg.configurable as any).requestBody = {
    messageId: 'actual-response-id',
    parentMessageId: 'user',
    conversationId: 'thread-one',
  };
  await run.processStream(
    { messages: [new HumanMessage({ id: 'user', content: 'The request.' })] },
    cfg,
  );
  expect(t.calls).toHaveLength(3);
});

test('concurrent invocations of one compiled workflow keep pending callers isolated', async () => {
  const t = fixture([]);
  const counts = new Map<string, number>();
  t.graph.overrideModel = {
    async *stream(messages: any[]) {
      const userId = messages.findLast((message) => message.getType() === 'human').id;
      const index = counts.get(userId) || 0;
      counts.set(userId, index + 1);
      if (index === 0) {
        yield transfer(`${userId}-consult`, 'specialist');
        return;
      }
      if (index === 1) {
        yield terminal(`${userId}-child`, `Evidence for ${userId}.`);
        return;
      }
      expect(completedResult(messages, `${userId}-consult`).content).toBe(
        `Evidence for ${userId}.`,
      );
      yield terminal(`${userId}-main`, `Final for ${userId}.`);
    },
  };
  const workflow = t.graph.createWorkflow();
  const results = await Promise.all(
    ['one', 'two'].map((id) =>
      workflow.invoke(
        { messages: [new HumanMessage({ id, content: `Request ${id}.` })], agentMessages: [] },
        config(`run-${id}`),
      ),
    ),
  );
  expect(results.map((result) => result.messages.at(-1).content)).toEqual([
    'Final for one.',
    'Final for two.',
  ]);
  expect([...counts.values()]).toEqual([3, 3]);
});

test('a new user turn during the child await denies automatic caller continuation', async () => {
  let childInput: any;
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => {
      childInput.messages.push(
        new HumanMessage({ id: 'new-user-turn', content: 'A different objective.' }),
      );
      return terminal('child-final', 'Old evidence.');
    },
  ]);
  const workflow = t.graph.createWorkflow();
  const invoke = workflow.nodes.specialist.bound.invoke.bind(workflow.nodes.specialist.bound);
  workflow.nodes.specialist.bound.invoke = (state: any, cfg: any) => {
    childInput = state;
    return invoke(state, cfg);
  };
  await workflow.invoke(
    {
      messages: [new HumanMessage({ id: 'user', content: 'Original objective.' })],
      agentMessages: [],
    },
    config(),
  );
  expect(t.calls).toHaveLength(2);
});

test('an aborted graph does not keep a pending child on a reused workflow and run ID', async () => {
  const controller = new AbortController();
  const t = fixture([
    () => transfer('old-consult', 'specialist'),
    () => {
      controller.abort();
      return terminal('old-child', 'Old evidence.');
    },
    () => transfer('new-consult', 'specialist'),
    () => terminal('new-child', 'New evidence.'),
    (messages) => {
      expect(completedResult(messages, 'new-consult').content).toBe('New evidence.');
      expect(completedResult(messages, 'old-consult')).toBeUndefined();
      return terminal('main-final', 'New final.');
    },
  ]);
  const workflow = t.graph.createWorkflow();
  const input = () => ({
    messages: [new HumanMessage({ id: 'user', content: 'The objective.' })],
    agentMessages: [],
  });
  await expect(
    workflow.invoke(input(), { ...config(), signal: controller.signal }),
  ).rejects.toThrow();
  expect((await workflow.invoke(input(), config())).messages.at(-1).content).toBe('New final.');
  expect(t.calls).toHaveLength(5);
});

test('receiver copies retain the completed pair by unique result and current-turn IDs', async () => {
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => terminal('child-final', 'Verified.'),
    (messages) => {
      expect(completedResult(messages).content).toBe('Verified.');
      return terminal('main-final', 'Done.');
    },
  ]);
  const receive = t.graph.processHandoffReception.bind(t.graph);
  t.graph.processHandoffReception = (messages: any[], receiver: string) =>
    receive([...messages], receiver);
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(3);
});

test('unknown compiled node shape disables only the terminal-return hook with an explicit warning', () => {
  class ChangedSdkGraph {
    agentContexts = new Map([['main', {}]]);
    createHandoffToolsForEdge() {
      return [];
    }
    processHandoffReception() {
      return null;
    }
    createWorkflow() {
      return { nodes: {} };
    }
  }
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(
    installLibreChatAgentsHandoffResultPatch({ MultiAgentGraph: ChangedSdkGraph } as any),
  ).toBe(true);
  const graph = new ChangedSdkGraph();
  expect(graph.createWorkflow()).toEqual({ nodes: {} });
  expect(warning).toHaveBeenCalledWith(
    '[Viventium][handoff] Terminal return unavailable: unsupported SDK node shape.',
  );
  expect(graph.processHandoffReception()).toBeNull();
  warning.mockRestore();
});

test('parallel terminal siblings keep the installed path instead of scheduling duplicate callers', async () => {
  const t = fixture(
    [
      () =>
        new AIMessageChunk({
          id: 'parallel-ai',
          content: '',
          tool_call_chunks: [
            {
              id: 'call-a',
              name: 'lc_transfer_to_specialist',
              args: '{}',
              index: 0,
              type: 'tool_call_chunk',
            },
            {
              id: 'call-b',
              name: 'lc_transfer_to_checker',
              args: '{}',
              index: 1,
              type: 'tool_call_chunk',
            },
          ],
        }),
      () => terminal('a-final', 'First evidence.'),
      () => terminal('b-final', 'Second evidence.'),
    ],
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff' },
      { from: 'specialist', to: 'main', edgeType: 'handoff' },
      { from: 'main', to: 'checker', edgeType: 'handoff' },
      { from: 'checker', to: 'main', edgeType: 'handoff' },
    ],
    ['main', 'specialist', 'checker'],
  );
  await t.invoke();
  expect(t.calls).toHaveLength(3);
});
/* === VIVENTIUM END === */
