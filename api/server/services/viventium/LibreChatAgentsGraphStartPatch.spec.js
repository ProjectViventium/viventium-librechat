'use strict';

const {
  installLibreChatAgentsGraphStartPatch,
  sourceComponentStartAgentIds,
} = require('./LibreChatAgentsGraphStartPatch');

describe('sourceComponentStartAgentIds', () => {
  test('preserves ordinary DAG entrypoints', () => {
    expect(
      sourceComponentStartAgentIds(['researcher', 'reviewer', 'writer'], [
        { from: 'researcher', to: 'reviewer' },
        { from: 'reviewer', to: 'writer' },
      ]),
    ).toEqual(['researcher']);
  });

  test('starts the primary handoff cycle and an unconnected added conversation', () => {
    expect(
      sourceComponentStartAgentIds(['main', 'specialist', 'main____1'], [
        { from: 'main', to: 'specialist' },
        { from: 'specialist', to: 'main' },
      ]),
    ).toEqual(['main', 'main____1']);
  });

  test('starts every independent agent when there are no edges', () => {
    expect(sourceComponentStartAgentIds(['one', 'two'], [])).toEqual(['one', 'two']);
  });
});

test('patch installs the source-component starts on a compatible graph runtime', () => {
  class FakeMultiAgentGraph {}
  FakeMultiAgentGraph.prototype.analyzeGraph = function upstreamAnalyzeGraph() {};
  FakeMultiAgentGraph.prototype.computeParallelCapability = function computeParallelCapability() {
    this.computed = true;
  };

  expect(installLibreChatAgentsGraphStartPatch({ MultiAgentGraph: FakeMultiAgentGraph })).toBe(true);
  const graph = new FakeMultiAgentGraph();
  graph.agentContexts = new Map([
    ['main', {}],
    ['specialist', {}],
    ['main____1', {}],
  ]);
  graph.edges = [
    { from: 'main', to: 'specialist' },
    { from: 'specialist', to: 'main' },
  ];
  graph.startingNodes = new Set();
  graph.agentParallelGroups = new Map([['stale', 1]]);

  graph.analyzeGraph();

  expect([...graph.startingNodes]).toEqual(['main', 'main____1']);
  expect(graph.agentParallelGroups.size).toBe(0);
  expect(graph.computed).toBe(true);
});

test('patch installs against the bundled LibreChat agents runtime', () => {
  const agentsModule = require('@librechat/agents');

  expect(installLibreChatAgentsGraphStartPatch(agentsModule)).toBe(true);

  const graph = Object.create(agentsModule.MultiAgentGraph.prototype);
  graph.agentContexts = new Map([
    ['main', {}],
    ['specialist', {}],
    ['main____1', {}],
  ]);
  graph.edges = [
    { from: 'main', to: 'specialist' },
    { from: 'specialist', to: 'main' },
  ];
  graph.directEdges = [];
  graph.handoffEdges = graph.edges;
  graph.startingNodes = new Set();
  graph.agentParallelGroups = new Map();

  graph.analyzeGraph();

  expect([...graph.startingNodes]).toEqual(['main', 'main____1']);
  expect(graph.getParallelGroupId('main')).toBe(1);
  expect(graph.getParallelGroupId('main____1')).toBe(1);
});
