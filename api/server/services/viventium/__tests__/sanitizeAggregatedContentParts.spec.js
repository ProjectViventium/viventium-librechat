const { createContentAggregator } = require('@librechat/agents');
const { GraphEvents } = require('@librechat/agents');
const { StepTypes, ContentTypes } = require('librechat-data-provider');
const {
  sanitizeAggregatedContentParts,
} = require('../sanitizeAggregatedContentParts');

describe('sanitizeAggregatedContentParts', () => {
  test('removes empty thinking shells left by streaming aggregation before tool follow-up', () => {
    const { contentParts, aggregateContent } = createContentAggregator();

    aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: {
        id: 'step-1',
        index: 0,
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'msg-1' },
        },
      },
    });

    aggregateContent({
      event: GraphEvents.ON_REASONING_DELTA,
      data: {
        id: 'step-1',
        delta: {
          content: [{ type: ContentTypes.THINK, think: '' }],
        },
      },
    });

    expect(contentParts).toEqual([{ type: ContentTypes.THINK, think: '' }]);

    const result = sanitizeAggregatedContentParts(contentParts);

    expect(result).toBe(contentParts);
    expect(contentParts).toEqual([]);
  });

  test('keeps valid reasoning content intact', () => {
    const contentParts = [{ type: ContentTypes.THINK, think: 'Plan before acting.' }];

    const result = sanitizeAggregatedContentParts(contentParts);

    expect(result).toBe(contentParts);
    expect(contentParts).toEqual([{ type: ContentTypes.THINK, think: 'Plan before acting.' }]);
  });
});
