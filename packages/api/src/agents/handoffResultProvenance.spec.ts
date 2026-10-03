import { Command } from '@langchain/langgraph';
import type { AgentGraphEdge } from './sourceComponentStarts';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { installLibreChatAgentsHandoffResultPatch, restoreCompletedHandoffPair } from './handoffResultProvenance';

const transfer = (id: string, from: string, to: string, content = '') => [
  new AIMessage({ id: `${id}-ai`, content, tool_calls: [{ id, name: `lc_transfer_to_${to}`, args: {} }] }),
  new ToolMessage({ id: `${id}-tool`, name: `lc_transfer_to_${to}`, tool_call_id: id,
    content: `Successfully transferred to ${to}`, additional_kwargs: {
      handoff_source_agent_id: from, handoff_destination: to, handoff_source_name: from,
    } }),
];
const resultText = 'Created note.txt; verified exactly Amber River, 11 bytes, no newline.';
const request = new HumanMessage({ id: 'user', content: 'Create and verify the scratch file.' });

it('changes the installed SDK return projection from assistant copy to the exact consult tool result', () => {
  const agents = jest.requireActual('@librechat/agents');
  const graph = Object.create(agents.MultiAgentGraph.prototype);
  graph.agentContexts = new Map();
  const messages = [request, ...transfer('consult', 'main', 'specialist'),
    ...transfer('return', 'specialist', 'main', resultText)];
  const original = graph.processHandoffReception(messages, 'main');
  expect(original.filteredMessages.map((message: HumanMessage) => message.getType())).toEqual(['human', 'ai']);
  expect(original.filteredMessages[1].content).toBe(resultText);
  expect(installLibreChatAgentsHandoffResultPatch(agents)).toBe(true);
  const proposed = graph.processHandoffReception(messages, 'main');
  expect(proposed.filteredMessages.map((message: HumanMessage) => message.getType())).toEqual(['human', 'ai', 'tool']);
  expect(proposed.filteredMessages[1].tool_calls).toEqual((messages[1] as AIMessage).tool_calls);
  expect(proposed.filteredMessages[2].tool_call_id).toBe('consult');
  expect(proposed.filteredMessages[2].content).toBe(resultText);
  expect(proposed.sourceAgentName).toBe(original.sourceAgentName);
  expect(proposed.instructions).toBe(original.instructions);
});

it.each([
  ['forward', [request, ...transfer('forward', 'main', 'specialist')], 'specialist'],
  ['empty', [request, ...transfer('consult', 'main', 'specialist'), ...transfer('return', 'specialist', 'main')], 'main'],
  ['self', [request, ...transfer('self', 'main', 'main', resultText)], 'main'],
  ['unmatched', [request, ...transfer('return', 'specialist', 'main', resultText)], 'main'],
  ['prior turn', [...transfer('old', 'main', 'specialist'), request, ...transfer('return', 'specialist', 'main', resultText)], 'main'],
] as const)('preserves %s without inventing a completed consult', (_name, messages, receiver) => {
  expect(restoreCompletedHandoffPair([...messages], [request], receiver)).toBeNull();
});

it('preserves nested consult return lineage and sibling non-transfer results', () => {
  const nested = [request, ...transfer('outer', 'main', 'specialist'),
    ...transfer('inner', 'specialist', 'checker'), ...transfer('inner-return', 'checker', 'specialist', 'Verified file bytes.')];
  const nestedResult = restoreCompletedHandoffPair(nested, [request, nested[5]], 'specialist');
  expect(nestedResult?.at(-1)?.content).toBe('Verified file bytes.');
  const ordinary = new ToolMessage({ id: 'ordinary', name: 'read_file', tool_call_id: 'read', content: 'Original native evidence.' });
  const outer = [...nested, ...transfer('outer-return', 'specialist', 'main', resultText)];
  const result = restoreCompletedHandoffPair(outer, [request, ordinary, outer.at(-2)!], 'main');
  expect(result?.[1]).toBe(ordinary);
  expect((result?.at(-1) as ToolMessage).tool_call_id).toBe('outer');
  expect(result?.at(-1)?.content).toBe(resultText);
});

it('keeps remaining ordinary calls and all result metadata when restoring a parallel consult', () => {
  const consult = transfer('consult', 'main', 'specialist');
  const original = consult[0] as AIMessage;
  original.tool_calls?.push({ id: 'other', name: 'read_file', args: {} });
  const filtered = new AIMessage({ ...original, tool_calls: [original.tool_calls![1]] });
  const messages = [request, ...consult, ...transfer('return', 'specialist', 'main', resultText)];
  const result = restoreCompletedHandoffPair(messages, [request, filtered, messages.at(-2)!], 'main');
  expect((result?.[1] as AIMessage).tool_calls?.map((call) => call.id)).toEqual(['other', 'consult']);
  expect((result?.[2] as ToolMessage).additional_kwargs.handoff_source_agent_id).toBe('main');
  expect(result?.[2].content).toBe(resultText);
});

it('stamps only freshly created handoff results with typed source and destination IDs', async () => {
  const fresh = new ToolMessage({ name: 'lc_transfer_to_b', tool_call_id: 'call', content: 'Transfer.' });
  class FixtureGraph {
    createHandoffToolsForEdge(_edge?: AgentGraphEdge, _source?: string, _name?: string) { return [{ func: async () => new Command({ goto: 'b', update: { messages: [fresh] } }) }]; }
    processHandoffReception() { return null; }
  }
  const module = { MultiAgentGraph: FixtureGraph } as Parameters<typeof installLibreChatAgentsHandoffResultPatch>[0];
  expect(installLibreChatAgentsHandoffResultPatch(module)).toBe(true);
  expect(installLibreChatAgentsHandoffResultPatch(module)).toBe(true);
  const graph = new FixtureGraph();
  const tool = graph.createHandoffToolsForEdge({ from: 'a', to: 'b' }, 'a', 'Same display')[0];
  await tool.func();
  expect(fresh.additional_kwargs).toMatchObject({ handoff_destination: 'b', handoff_source_agent_id: 'a' });
});


it('restores the installed SDK streaming AIMessageChunk return pair', () => {
  const agents = jest.requireActual('@librechat/agents');
  installLibreChatAgentsHandoffResultPatch(agents);
  const graph = Object.create(agents.MultiAgentGraph.prototype);
  graph.agentContexts = new Map();
  const consult = transfer('chunk-consult', 'main', 'specialist');
  const returned = transfer('chunk-return', 'specialist', 'main', resultText);
  const messages = [request, new AIMessageChunk({ ...(consult[0] as AIMessage) }), consult[1],
    new AIMessageChunk({ ...(returned[0] as AIMessage) }), returned[1]];
  const proposed = graph.processHandoffReception(messages, 'main');
  expect(proposed.filteredMessages.map((message: HumanMessage) => message.getType()))
    .toEqual(['human', 'ai', 'tool']);
  expect(proposed.filteredMessages[1].tool_calls[0].id).toBe('chunk-consult');
  expect(proposed.filteredMessages[2].tool_call_id).toBe('chunk-consult');
  expect(proposed.filteredMessages[2].content).toBe(resultText);
});


it('restores only visible text from mixed native content blocks', () => {
  const returned = transfer('return', 'specialist', 'main');
  returned[0].content = [
    { type: 'text', text: 'Done' },
    { type: 'tool_use', id: 'internal', name: 'read', input: {} },
    { type: 'reasoning', text: 'Hidden private reasoning' },
  ];
  const messages = [request, ...transfer('consult', 'main', 'specialist'), ...returned];
  expect(restoreCompletedHandoffPair(messages, [request, returned[0]], 'main')?.at(-1)?.content)
    .toBe('Done');
});

it('preserves the upstream projection when a return has no visible text', () => {
  const returned = transfer('return', 'specialist', 'main');
  returned[0].content = [
    { type: 'tool_use', id: 'internal', name: 'read', input: {} },
    { type: 'reasoning', text: 'Hidden private reasoning' },
  ];
  const messages = [request, ...transfer('consult', 'main', 'specialist'), ...returned];
  expect(restoreCompletedHandoffPair(messages, [request, returned[0]], 'main')).toBeNull();
});
