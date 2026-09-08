import { createCortexToolEvidence, reportCortexHostToolResult } from './cortexToolEvidence';

const policy = {
  visible_insight_requires: [{ tool: 'file_search', receipt: 'non_empty_sources' as const }],
};
const found = {
  status: 'ok',
  tool: 'file_search',
  artifact: { file_search: { sources: [{ content: 'Evidence' }] } },
};

test('broker receipts are isolated to the invocation grant, including refreshed grants', () => {
  const received = jest.fn();
  const a = createCortexToolEvidence(policy, received);
  const b = createCortexToolEvidence(policy);
  a.observeGrant('grant-a');
  b.observeGrant('grant-b');
  a.observeGrant('grant-a-refreshed');
  reportCortexHostToolResult('unrelated', found);
  expect(a.isSatisfied()).toBe(false);
  reportCortexHostToolResult('grant-a-refreshed', found);
  expect(a.isSatisfied()).toBe(true);
  expect(b.isSatisfied()).toBe(false);
  expect(received).toHaveBeenCalledTimes(1);
  a.close();
  a.observeGrant('late-refresh');
  reportCortexHostToolResult('grant-a', found);
  reportCortexHostToolResult('late-refresh', found);
  expect(received).toHaveBeenCalledTimes(1);
  b.close();
});

test('failed, empty, malformed and wrong-tool results cannot satisfy a declared receipt', () => {
  const evidence = createCortexToolEvidence(policy);
  evidence.observeGrant('proof');
  for (const result of [
    { ...found, status: 'blocked' },
    { ...found, artifact: { file_search: { sources: [] } } },
    { ...found, artifact: { file_search: { sources: [null] } } },
    { ...found, tool: 'web_search' },
  ]) {
    reportCortexHostToolResult('proof', result);
    expect(evidence.isSatisfied()).toBe(false);
  }
  reportCortexHostToolResult('proof', found);
  expect(evidence.isSatisfied()).toBe(true);
  evidence.close();
});

test('direct execution uses the same receipt rules and ordinary tool-free specialists remain valid', () => {
  const evidence = createCortexToolEvidence(policy);
  evidence.record({ name: found.tool, artifact: found.artifact });
  expect(evidence.isSatisfied()).toBe(true);
  const ordinary = createCortexToolEvidence();
  expect(ordinary.isSatisfied()).toBe(true);
  evidence.close();
  ordinary.close();
});
