const {
  buildUserProposal,
  buildHardenerPrompt,
  resolveProvider,
  selectMessagesForPrompt,
  validateProposal,
} = require('../../../scripts/viventium-memory-hardening');

describe('viventium-memory-hardening', () => {
  const memoryConfig = {
    validKeys: [
      'core',
      'preferences',
      'world',
      'context',
      'moments',
      'me',
      'working',
      'signals',
      'drafts',
    ],
    keyLimits: {
      core: 800,
      preferences: 600,
      world: 1200,
      context: 1200,
      moments: 1200,
      me: 600,
      working: 400,
      signals: 1000,
      drafts: 1000,
    },
    tokenLimit: 8000,
    instructions: 'working — RIGHT NOW (overwrite each conversation). core — durable identity.',
  };

  test('hardener prompt imports live instructions but overrides conversation scope', () => {
    const prompt = buildHardenerPrompt({
      user: { _id: '507f1f77bcf86cd799439011' },
      memoryConfig,
      memories: [],
      messages: [],
      now: new Date('2026-04-25T10:00:00Z'),
      lookbackDays: 7,
      maxChanges: 3,
    });

    expect(prompt).toContain('LIVE MEMORY INSTRUCTIONS');
    expect(prompt).toContain('working — RIGHT NOW');
    expect(prompt).toContain('Never edit the "working" key');
    expect(prompt).toContain('batch hardener rules above override');
  });

  test('prompt message selection reports full-lookback coverage before model invocation', () => {
    const messages = [
      { messageId: 'm1', conversationId: 'c1', text: 'a'.repeat(10) },
      { messageId: 'm2', conversationId: 'c2', text: 'b'.repeat(10) },
    ];

    expect(selectMessagesForPrompt(messages, 1000)).toMatchObject({
      messages,
      omittedMessages: 0,
      complete: true,
    });
    expect(selectMessagesForPrompt(messages, 270)).toMatchObject({
      omittedMessages: 1,
      complete: false,
    });
  });

  test('user proposal skips oversized corpora when full-lookback is required', async () => {
    const now = new Date('2026-04-25T10:00:00Z');
    const messages = [
      {
        messageId: 'm1',
        conversationId: 'c1',
        createdAt: new Date('2026-04-24T10:00:00Z'),
        isCreatedByUser: true,
        sender: 'User',
        text: 'a'.repeat(200),
      },
      {
        messageId: 'm2',
        conversationId: 'c2',
        createdAt: new Date('2026-04-24T11:00:00Z'),
        isCreatedByUser: false,
        sender: 'Assistant',
        text: 'b'.repeat(200),
      },
    ];
    const messageCollection = {
      find: jest
        .fn()
        .mockReturnValueOnce({
          sort: () => ({
            limit: () => ({
              next: async () => ({ createdAt: new Date('2026-04-24T11:00:00Z') }),
            }),
          }),
        })
        .mockReturnValueOnce({
          project: () => ({
            sort: () => ({
              toArray: async () => messages,
            }),
          }),
        }),
    };
    const result = await buildUserProposal({
      db: { collection: () => messageCollection },
      methods: { getAllUserMemories: jest.fn().mockResolvedValue([]) },
      user: { _id: '507f1f77bcf86cd799439011' },
      options: {
        lookbackDays: 7,
        minUserIdleMinutes: 60,
        maxChangesPerUser: 3,
        maxInputChars: 300,
        requireFullLookback: true,
        ignoreIdleGate: false,
      },
      memoryConfig,
      now,
      providerInfo: { provider: 'anthropic', model: 'claude-opus-4-7' },
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('input_cap_exceeded');
    expect(result.summary.telemetry).toMatchObject({
      messages_in_lookback: 2,
      messages_fed_to_model: 1,
      messages_omitted_for_input_cap: 1,
      lookback_complete: false,
    });
  });

  test('validator rejects working edits, deletes by default, bad keys, and excessive changes', () => {
    const result = validateProposal({
      proposal: {
        operations: [
          {
            key: 'working',
            action: 'set',
            value: 'stale batch state',
            rationale: 'bad',
            evidence: [],
          },
          {
            key: 'core',
            action: 'delete',
            rationale: 'bad',
            evidence: [{ messageId: 'm1', createdAt: 'now' }],
          },
          { key: 'bad_key', action: 'set', value: 'value', rationale: 'bad', evidence: [] },
          { key: 'core', action: 'set', value: 'Core memory.', rationale: 'ok', evidence: [] },
          {
            key: 'context',
            action: 'set',
            value: 'Context memory.',
            rationale: 'ok',
            evidence: [],
          },
        ],
      },
      memories: [],
      memoryConfig,
      options: { maxChangesPerUser: 1, allowDelete: false },
    });

    expect(result.accepted.filter((item) => item.action === 'set')).toHaveLength(1);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      'working_is_conversation_owned',
      'delete_not_enabled',
      'invalid_key',
      'max_changes_exceeded',
    ]);
  });

  test('provider resolver honors launch-ready provider-specific defaults', () => {
    const oldEnv = { ...process.env };
    process.env.VIVENTIUM_PRIMARY_PROVIDER = 'openai';
    process.env.VIVENTIUM_SECONDARY_PROVIDER = 'anthropic';
    process.env.VIVENTIUM_MEMORY_HARDENING_ANTHROPIC_MODEL = 'claude-opus-4-7';
    process.env.VIVENTIUM_MEMORY_HARDENING_OPENAI_MODEL = 'gpt-5.4';
    try {
      expect(resolveProvider({})).toEqual({ provider: 'anthropic', model: 'claude-opus-4-7' });
      expect(resolveProvider({ provider: 'openai' })).toEqual({
        provider: 'openai',
        model: 'gpt-5.4',
      });
    } finally {
      process.env = oldEnv;
    }
  });
});
