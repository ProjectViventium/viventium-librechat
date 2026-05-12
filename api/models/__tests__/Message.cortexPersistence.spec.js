jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  createTempChatExpirationDate: jest.fn(() => null),
}));

jest.mock('~/db/models', () => ({
  Message: {},
}));

jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  scheduleConversationRecallSync: jest.fn(),
  getMessageText: jest.fn(() => ''),
  shouldSkipFromRecallCorpus: jest.fn(() => false),
}));

jest.mock('~/server/services/viventium/conversationRecallFilters', () => ({
  buildRecallDerivedParentIdSet: jest.fn(() => new Set()),
}));

const { __testables } = require('../Message');

describe('Message cortex persistence helpers', () => {
  it('preserves existing assistant text when a later cortex-only update arrives', () => {
    const update = {
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: 'cortex_insight',
          cortex_id: 'red_team',
          cortex_name: 'Red Team',
          status: 'complete',
          insight: 'Counter-case.',
        },
      ],
    };
    const existing = {
      text: 'Main Phase A answer.',
      content: [{ type: 'text', text: 'Main Phase A answer.' }],
    };

    const merged = __testables.mergeExistingTextIntoCortexOnlyUpdate(update, existing);

    expect(merged.text).toBe('Main Phase A answer.');
    expect(merged.content).toEqual([
      update.content[0],
      { type: 'text', text: 'Main Phase A answer.' },
    ]);
  });

  it('does not rewrite updates that already contain a text part', () => {
    const update = {
      isCreatedByUser: false,
      text: '',
      content: [
        { type: 'text', text: 'Fresh answer.' },
        { type: 'cortex_insight', cortex_id: 'red_team', cortex_name: 'Red Team' },
      ],
    };

    expect(__testables.mergeExistingTextIntoCortexOnlyUpdate(update, { text: 'Old answer.' })).toBe(
      update,
    );
  });

  it('does not preserve text for user-authored updates', () => {
    const update = {
      isCreatedByUser: true,
      text: '',
      content: [{ type: 'cortex_insight', cortex_id: 'red_team', cortex_name: 'Red Team' }],
    };

    expect(__testables.mergeExistingTextIntoCortexOnlyUpdate(update, { text: 'Old answer.' })).toBe(
      update,
    );
  });

  it('does not treat generation placeholders as durable Phase A text', () => {
    const update = {
      isCreatedByUser: false,
      text: '',
      content: [{ type: 'cortex_insight', cortex_id: 'red_team', cortex_name: 'Red Team' }],
    };
    const existing = {
      text: 'Generation in progress.',
      content: [{ type: 'text', text: 'Generation in progress.' }],
    };

    expect(__testables.visibleMessageText(existing)).toBe('');
    expect(__testables.mergeExistingTextIntoCortexOnlyUpdate(update, existing)).toBe(update);
  });
});
