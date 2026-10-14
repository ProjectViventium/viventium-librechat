/* === VIVENTIUM START === Hidden foreground results complete the accepted consult pair. === */
import { AIMessageChunk, HumanMessage, isToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
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
      graph.createWorkflow().invoke(
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

test('a native provider-limited hidden consult returns one attributed failed tool result to Main', async () => {
  const failure = Object.assign(new Error('PRIVATE PROVIDER DETAIL'), {
    error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  });
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => {
      throw failure;
    },
    (messages) => {
      const result = completedResult(messages);
      expect(result.status).toBe('error');
      expect(result.tool_call_id).toBe('consult');
      expect(result.additional_kwargs.handoff_source_agent_id).toBe('main');
      expect(result.additional_kwargs.handoff_destination).toBe('specialist');
      expect(result.additional_kwargs.handoff_failure).toEqual({
        version: 1,
        code: 'provider_rate_limited',
      });
      expect(JSON.parse(result.content)).toEqual({
        status: 'failed',
        error: { code: 'provider_rate_limited' },
      });
      expect(JSON.stringify(messages)).not.toContain('PRIVATE PROVIDER DETAIL');
      expect(
        messages.filter((entry) => isToolMessage(entry) && entry.tool_call_id === 'consult'),
      ).toHaveLength(1);
      expect(messages.some((entry) => entry.getType() === 'ai' && entry.id !== 'consult-ai')).toBe(
        false,
      );
      return terminal(
        'main-final',
        'The consult is unavailable; the authorized work can continue.',
      );
    },
  ]);
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(3);
});

test.each([
  ['visible child', { visible_agent_ids: ['main', 'specialist'] }, undefined],
  ['presentation disabled', { hide_sequential_outputs: false }, undefined],
  ['no return edge', {}, [{ from: 'main', to: 'specialist', edgeType: 'handoff' }]],
  [
    'conditional return',
    {},
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff' },
      { from: 'specialist', to: 'main', edgeType: 'handoff', condition: () => false },
    ],
  ],
])('provider failure still rejects with %s', async (_name, overrides, edges) => {
  const error = Object.assign(new Error('provider failure'), { code: 'rate_limit_exceeded' });
  const t = fixture(
    [
      () => transfer('consult', 'specialist'),
      () => {
        throw error;
      },
    ],
    edges,
  );
  await expect(t.invoke(config('run-one', overrides))).rejects.toBe(error);
  expect(t.calls).toHaveLength(2);
});

test.each(['tool_failure', 'provider_access_denied', 'native_input_declined', 'unknown_failure'])(
  'does not convert %s to a provider result',
  async (code) => {
    const error = Object.assign(new Error('failure'), { code });
    const t = fixture([
      () => transfer('consult', 'specialist'),
      () => {
        throw error;
      },
    ]);
    await expect(t.invoke()).rejects.toBe(error);
  },
);

test('a primary provider failure has no accepted consult and still rejects', async () => {
  const error = Object.assign(new Error('provider failure'), { code: 'rate_limit_exceeded' });
  await expect(
    fixture([
      () => {
        throw error;
      },
    ]).invoke(),
  ).rejects.toBe(error);
});

test('a real installed tool node with provider-shaped failure still rejects', async () => {
  const error = Object.assign(new Error('tool provider failure'), { code: 'rate_limit_exceeded' });
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () =>
      new AIMessageChunk({
        id: 'tool-ai',
        content: '',
        tool_call_chunks: [
          { id: 'read', name: 'read_file', args: '{}', index: 0, type: 'tool_call_chunk' },
        ],
      }),
  ]);
  const initializeTools = t.graph.initializeTools.bind(t.graph);
  t.graph.initializeTools = (options: { agentContext: unknown }) =>
    options.agentContext === t.graph.agentContexts.get('specialist')
      ? async () => {
          throw error;
        }
      : initializeTools(options);
  await expect(t.invoke()).rejects.toBe(error);
  expect(t.calls).toHaveLength(2);
});

test('an aborted provider attempt preserves cancellation instead of returning to Main', async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error('provider failure'), { code: 'rate_limit_exceeded' });
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => {
      controller.abort();
      throw error;
    },
  ]);
  await expect(t.invoke({ ...config(), signal: controller.signal })).rejects.toThrow();
  expect(t.calls).toHaveLength(2);
});

test('input-bearing failed consult preserves the original human and exact failed pair', async () => {
  const error = Object.assign(new Error('limited'), {
    error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  });
  const t = fixture(
    [
      () => transfer('consult', 'specialist', '', { instructions: 'Check the artifact.' }),
      () => {
        throw error;
      },
      (messages) => {
        expect(completedResult(messages).status).toBe('error');
        expect(completedResult(messages).tool_call_id).toBe('consult');
        return terminal('main-final', 'The provider is unavailable.');
      },
    ],
    [
      { from: 'main', to: 'specialist', edgeType: 'handoff', prompt: 'Check the artifact.' },
      { from: 'specialist', to: 'main', edgeType: 'handoff' },
    ],
  );
  expect((await t.invoke()).messages.at(-1).id).toBe('main-final');
  expect(t.calls).toHaveLength(3);
});

test('a consumed provider error object does not authorize a later tool-node failure', async () => {
  const error = Object.assign(new Error('reused'), { code: 'rate_limit_exceeded' });
  const t = fixture([
    () => transfer('first-consult', 'specialist'),
    () => {
      throw error;
    },
    (messages) => {
      expect(completedResult(messages, 'first-consult').status).toBe('error');
      return transfer('second-consult', 'specialist');
    },
    () =>
      new AIMessageChunk({
        id: 'second-tool-ai',
        content: '',
        tool_call_chunks: [
          { id: 'read', name: 'read_file', args: '{}', index: 0, type: 'tool_call_chunk' },
        ],
      }),
  ]);
  const initializeTools = t.graph.initializeTools.bind(t.graph);
  t.graph.initializeTools = (options: { agentContext: unknown }) =>
    options.agentContext === t.graph.agentContexts.get('specialist')
      ? async () => {
          throw error;
        }
      : initializeTools(options);
  await expect(t.invoke()).rejects.toBe(error);
  expect(t.calls).toHaveLength(4);
});

test('an old failed await cannot delete a replacement consult in the same graph scope', async () => {
  let firstEntered!: () => void;
  let secondEntered!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const secondReady = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  let rejectFirst!: (error: Error) => void;
  let resolveSecond!: () => void;
  const firstAttempt = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const secondAttempt = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  const error = Object.assign(new Error('old provider attempt'), { code: 'rate_limit_exceeded' });
  const t = fixture([]);
  let calls = 0;
  t.graph.overrideModel = {
    async *stream(messages: BaseMessage[]) {
      calls += 1;
      if (calls === 1) {
        yield transfer('old-consult', 'specialist');
        return;
      }
      if (calls === 2) {
        firstEntered();
        await firstAttempt;
        return;
      }
      if (calls === 3) {
        yield transfer('new-consult', 'specialist');
        return;
      }
      if (calls === 4) {
        secondEntered();
        await secondAttempt;
        yield terminal('child-final', 'New result.');
        return;
      }
      expect(completedResult(messages, 'new-consult').content).toBe('New result.');
      yield terminal('main-final', 'Current result.');
    },
  };
  const workflow = t.graph.createWorkflow();
  const input = () => ({
    messages: [new HumanMessage({ id: 'user', content: 'Same scoped user.' })],
    agentMessages: [],
  });
  const first = workflow.invoke(input(), config()).catch((failure: Error) => failure);
  await firstReady;
  const second = workflow.invoke(input(), config());
  await secondReady;
  rejectFirst(error);
  expect(await first).toBe(error);
  resolveSecond();
  expect((await second).messages.at(-1).id).toBe('main-final');
  expect(calls).toBe(5);
});

test('a new user turn during a failed child await denies caller continuation', async () => {
  let childInput: { messages: BaseMessage[] };
  const error = Object.assign(new Error('limited'), { code: 'rate_limit_exceeded' });
  const t = fixture([
    () => transfer('consult', 'specialist'),
    () => {
      childInput.messages.push(new HumanMessage({ id: 'new-user', content: 'New objective.' }));
      throw error;
    },
  ]);
  const workflow = t.graph.createWorkflow();
  const invoke = workflow.nodes.specialist.bound.invoke.bind(workflow.nodes.specialist.bound);
  workflow.nodes.specialist.bound.invoke = (
    state: { messages: BaseMessage[] },
    cfg: RunnableConfig,
  ) => {
    childInput = state;
    return invoke(state, cfg);
  };
  await expect(
    workflow.invoke(
      {
        messages: [new HumanMessage({ id: 'user', content: 'Original objective.' })],
        agentMessages: [],
      },
      config(),
    ),
  ).rejects.toBe(error);
  expect(t.calls).toHaveLength(2);
});

test('parallel consultant provider failure keeps the installed error path', async () => {
  const error = Object.assign(new Error('limited'), { code: 'rate_limit_exceeded' });
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
      () => {
        throw error;
      },
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
  await expect(t.invoke()).rejects.toBe(error);
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
