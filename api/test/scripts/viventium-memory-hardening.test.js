const {
  buildHardenerPrompt,
  resolveProvider,
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
