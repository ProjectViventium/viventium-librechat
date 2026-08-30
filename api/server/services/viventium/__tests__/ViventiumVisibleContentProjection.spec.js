'use strict';

const {
  projectVisibleTextFromContentParts,
  visibleTextSegmentsFromContentParts,
} = require('../ViventiumVisibleContentProjection');

describe('ViventiumVisibleContentProjection', () => {
  test('keeps parallel participant boundaries in the flat projection', () => {
    const content = [
      { type: 'text', text: 'Base answer.', agentId: 'agent-main', groupId: 1 },
      { type: 'text', text: 'Added answer.', agentId: 'agent-main____1', groupId: 1 },
    ];

    expect(visibleTextSegmentsFromContentParts(content)).toEqual(['Base answer.', 'Added answer.']);
    expect(projectVisibleTextFromContentParts(content)).toBe('Base answer.\n\nAdded answer.');
  });

  test('keeps separate Main invocations separated across an internal handoff', () => {
    expect(
      projectVisibleTextFromContentParts([
        { type: 'text', text: 'I will check that.', agentId: 'agent-main' },
        { type: 'text', text: 'Here is the result.', agentId: 'agent-main' },
      ]),
    ).toBe('I will check that.\n\nHere is the result.');
  });

  test('does not change an ordinary single-part answer', () => {
    expect(projectVisibleTextFromContentParts([{ type: 'text', text: 'One answer.' }])).toBe(
      'One answer.',
    );
  });
});
