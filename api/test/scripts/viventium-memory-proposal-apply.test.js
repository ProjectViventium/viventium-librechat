const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyProposalWithMethods,
  duplicateKeys,
  duplicateMergePlans,
  mergedMemoryValue,
  normalizeProposal,
  parseArgs,
} = require(path.join(__dirname, '../../../scripts/viventium-memory-proposal-apply.js'));

describe('viventium-memory-proposal-apply', () => {
  test('normalizes supported set and delete actions without exposing values in summaries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-proposal-'));
    const proposal = path.join(dir, 'memory-proposals-qa.json');
    fs.writeFileSync(
      proposal,
      JSON.stringify({
        actions: [
          { action: 'set', key: 'context', value: 'Synthetic context', reason: 'QA' },
          { action: 'delete', key: 'working' },
        ],
      }),
      'utf8',
    );

    expect(normalizeProposal(proposal)).toEqual([
      { action: 'set', key: 'context', value: 'Synthetic context', reason: 'QA' },
      { action: 'delete', key: 'working', value: '', reason: '' },
    ]);
  });

  test('detects duplicate live memory keys and builds governed merge plans', () => {
    expect(
      duplicateKeys([{ key: 'core' }, { key: 'context' }, { key: 'core' }, { key: '' }]),
    ).toEqual(['core']);

    expect(
      mergedMemoryValue([
        { value: 'newer', updated_at: '2026-05-22T04:00:00Z' },
        { value: 'older', updated_at: '2026-05-22T03:00:00Z' },
        { value: 'older', updated_at: '2026-05-22T03:01:00Z' },
      ]),
    ).toBe('older\n\nnewer');

    const plans = duplicateMergePlans([
      { key: 'core', value: 'older', tokenCount: 1, updated_at: '2026-05-22T03:00:00Z' },
      { key: 'context', value: 'only', tokenCount: 1 },
      { key: 'core', value: 'newer', tokenCount: 1, updated_at: '2026-05-22T04:00:00Z' },
    ]);
    expect(plans).toEqual([
      expect.objectContaining({
        key: 'core',
        originalCount: 2,
        ok: true,
        mergedValue: 'older\n\nnewer',
      }),
    ]);
    expect(plans[0].mergedValueHash).toMatch(/^[a-f0-9]{16}$/);
  });

  test('apply mode is explicit and dry-run remains default', () => {
    expect(parseArgs(['--proposal', '/tmp/proposal.json', '--user-id', 'user-1'])).toEqual(
      expect.objectContaining({ apply: false, proposal: '/tmp/proposal.json', userId: 'user-1' }),
    );
    expect(
      parseArgs(['--proposal', '/tmp/proposal.json', '--user-id', 'user-1', '--apply']),
    ).toEqual(expect.objectContaining({ apply: true }));
  });

  test('applyProposalWithMethods fails closed on duplicate keys that require offline migration', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-proposal-apply-'));
    const proposal = path.join(dir, 'memory-proposals-apply.json');
    fs.writeFileSync(
      proposal,
      JSON.stringify({
        actions: [{ action: 'set', key: 'context', value: 'Synthetic governed update' }],
      }),
      'utf8',
    );
    const memories = [
      {
        key: 'context',
        value: 'Older context',
        tokenCount: 1,
        __v: 3,
        updated_at: '2026-05-22T03:00:00Z',
      },
      {
        key: 'context',
        value: 'Newer context',
        tokenCount: 1,
        __v: 4,
        updated_at: '2026-05-22T04:00:00Z',
      },
      { key: 'core', value: 'Older core', tokenCount: 1, updated_at: '2026-05-22T03:30:00Z' },
      { key: 'core', value: 'Stable core', tokenCount: 1, updated_at: '2026-05-22T04:30:00Z' },
    ];
    const calls = [];
    const methods = {
      getAllUserMemories: async () => memories.map((memory) => ({ ...memory })),
      deleteMemory: async ({ key }) => {
        calls.push(['delete', key]);
        const index = memories.findIndex((memory) => memory.key === key);
        if (index < 0) return { ok: false };
        memories.splice(index, 1);
        return { ok: true };
      },
      setMemory: async ({ key, value, tokenCount }) => {
        calls.push(['set', key]);
        const existing = memories.find((memory) => memory.key === key);
        if (existing) {
          existing.value = value;
          existing.tokenCount = tokenCount;
        } else {
          memories.push({ key, value, tokenCount, updated_at: new Date().toISOString() });
        }
        return { ok: true };
      },
    };

    const result = await applyProposalWithMethods(
      { proposal, userId: 'user-1', apply: true },
      methods,
      { validKeys: ['context', 'core'], tokenLimit: 10000 },
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('apply');
    expect(result.reason).toBe('duplicate_memory_merge_requires_offline_migration');
    expect(result.dedupe).toEqual([
      expect.objectContaining({
        key: 'context',
        originalCount: 2,
        status: 'requires_offline_migration',
      }),
    ]);
    expect(result.actions).toEqual([
      expect.objectContaining({
        action: 'set',
        key: 'context',
        status: 'blocked_duplicate_key_migration',
      }),
    ]);
    expect(calls).toEqual([]);
    expect(memories.filter((memory) => memory.key === 'context')).toHaveLength(2);
    expect(memories.filter((memory) => memory.key === 'core')).toHaveLength(2);
  });

  test('applyProposalWithMethods does not block on unrelated duplicate keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-proposal-unrelated-'));
    const proposal = path.join(dir, 'memory-proposals-apply.json');
    fs.writeFileSync(
      proposal,
      JSON.stringify({
        actions: [{ action: 'set', key: 'context', value: 'Scoped governed update' }],
      }),
      'utf8',
    );
    const memories = [
      { key: 'context', value: 'Existing context', tokenCount: 1 },
      { key: 'core', value: 'A very long unrelated core value', tokenCount: 100 },
      { key: 'core', value: 'Another very long unrelated core value', tokenCount: 100 },
    ];
    const methods = {
      getAllUserMemories: async () => memories.map((memory) => ({ ...memory })),
      deleteMemory: jest.fn(async () => ({ ok: true })),
      setMemory: jest.fn(async ({ key, value, tokenCount }) => {
        const existing = memories.find((memory) => memory.key === key);
        if (existing) {
          existing.value = value;
          existing.tokenCount = tokenCount;
        }
        return { ok: true, revision: 1 };
      }),
    };

    const result = await applyProposalWithMethods(
      { proposal, userId: 'user-1', apply: true },
      methods,
      { validKeys: ['context', 'core'], tokenLimit: 10000, keyLimits: { core: 1 } },
    );

    expect(result.ok).toBe(true);
    expect(result.dedupe).toEqual([]);
    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'set', key: 'context', status: 'updated' }),
    ]);
    expect(methods.deleteMemory).not.toHaveBeenCalled();
    expect(methods.setMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'context' }));
    expect(methods.setMemory).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'core' }));
  });

  test('post-apply maintenance preserves the reviewed proposal value', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-proposal-protected-'));
    const proposal = path.join(dir, 'memory-proposals-apply.json');
    const proposedContext =
      'Project Atlas has a complete reviewed outcome and a deliberately detailed set of follow-up commitments that must remain intact after the proposal is applied, even when deterministic maintenance is already due for the account.';
    fs.writeFileSync(
      proposal,
      JSON.stringify({
        actions: [{ action: 'set', key: 'context', value: proposedContext }],
      }),
      'utf8',
    );
    let memories = [{ key: 'context', value: 'Previous context', tokenCount: 2, __v: 4 }];
    const methods = {
      getAllUserMemories: jest.fn(async () => memories.map((memory) => ({ ...memory }))),
      setMemory: jest.fn(async ({ key, value, tokenCount, expectedRevision }) => {
        const revision = Number(expectedRevision) + 1;
        memories = [
          ...memories.filter((memory) => memory.key !== key),
          { key, value, tokenCount, __v: revision },
        ];
        return { ok: true, revision };
      }),
      deleteMemory: jest.fn(),
    };

    try {
      const result = await applyProposalWithMethods(
        { proposal, userId: 'user-1', apply: true },
        methods,
        {
          validKeys: ['context', 'working'],
          tokenLimit: 100,
          keyLimits: { context: 100, working: 100 },
          maintenanceThresholdPercent: 1,
        },
      );

      expect(result.ok).toBe(true);
      expect(
        methods.setMemory.mock.calls.filter(([write]) => write.key === 'context'),
      ).toHaveLength(1);
      expect(memories.find((memory) => memory.key === 'context')?.value).toBe(proposedContext);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['set', { action: 'set', key: 'context', value: 'Rejected update' }],
    ['delete', { action: 'delete', key: 'context' }],
  ])('applyProposalWithMethods rejects an unsuccessful %s storage result', async (kind, action) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-proposal-rejected-'));
    const proposal = path.join(dir, 'memory-proposals-apply.json');
    fs.writeFileSync(proposal, JSON.stringify({ actions: [action] }), 'utf8');
    const memories = [{ key: 'context', value: 'Existing context', tokenCount: 1, __v: 3 }];
    const methods = {
      getAllUserMemories: async () => memories.map((memory) => ({ ...memory })),
      getAllUserMemoryStates: async () => memories.map((memory) => ({ ...memory })),
      deleteMemory: jest.fn(async () => ({ ok: false })),
      setMemory: jest.fn(async () => ({ ok: false })),
    };

    const result = await applyProposalWithMethods(
      { proposal, userId: 'user-1', apply: true },
      methods,
      { validKeys: ['context'], tokenLimit: 10000 },
    );

    expect(result.ok).toBe(false);
    expect(result.actions).toEqual([
      expect.objectContaining({ action: kind, key: 'context', status: 'rejected_storage_failure' }),
    ]);
  });
});
