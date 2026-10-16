import {
  collectCortexCitationAttachments,
  createCortexToolEvidence,
  reportCortexHostToolResult,
} from './cortexToolEvidence';
import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';

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

test('ordinary native tool artifacts remain isolated without a mandatory-evidence policy', () => {
  const receive = jest.fn();
  const evidence = createCortexToolEvidence(null, receive);
  evidence.observeGrant('ordinary-grant');
  reportCortexHostToolResult('foreign-grant', found);
  reportCortexHostToolResult('ordinary-grant', { ...found, status: 'blocked' });
  expect(receive).not.toHaveBeenCalled();
  reportCortexHostToolResult('ordinary-grant', found);
  expect(receive).toHaveBeenCalledWith({ name: 'file_search', artifact: found.artifact });
  evidence.close();
  reportCortexHostToolResult('ordinary-grant', found);
  expect(receive).toHaveBeenCalledTimes(1);
});

test('citation artifacts require canonical message and conversation and deduplicate replay', () => {
  const binding = { messageId: 'answer-owned', conversationId: 'conversation-owned' };
  const attachment = {
    ...binding,
    type: Tools.file_search,
    file_search: {
      sources: [
        {
          fileId: 'file-owned',
          fileName: 'Meeting.txt',
          content: 'Source evidence.',
          relevance: 1,
        },
      ],
    },
  } as TAttachment;
  expect(
    collectCortexCitationAttachments([{ attachments: [attachment, attachment] }], binding),
  ).toEqual([attachment]);
  for (const invalid of [
    { ...attachment, messageId: 'answer-other' },
    { ...attachment, conversationId: 'conversation-other' },
    { ...attachment, type: Tools.memory },
    { ...attachment, file_search: { sources: [] } },
  ])
    expect(
      collectCortexCitationAttachments([{ attachments: [invalid as TAttachment] }], binding),
    ).toEqual([]);
  expect(
    collectCortexCitationAttachments([{ attachments: [attachment] }], {
      ...binding,
      conversationId: '',
    }),
  ).toEqual([]);
});
