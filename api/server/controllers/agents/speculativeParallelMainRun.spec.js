/**
 * Proof tests for the speculative-parallel main-run orchestrator (runSpeculativeParallelMainRun).
 *
 * These prove the single-delivery / no-double-bill correctness contract at the smallest seam: the
 * orchestrator drives injected closures (startSpeculativeRun / detect / abort / commit / discard),
 * and a harness simulates the real seams — a user "stream" (delivery), a usage ledger (billing), and
 * a persisted-content array. commit and discard are mutually exclusive and each fires at most once,
 * so the buffered speculative answer is delivered + billed exactly once on commit, and never on abort.
 *
 * Loaded with the same minimal mock set as speculativeParallelDetect.spec.js so the full client
 * module resolves without standing up real DB/config/agents deps.
 */
jest.mock('~/models/spendTokens', () => ({
  spendTokens: jest.fn(),
  spendStructuredTokens: jest.fn(),
}));

jest.mock('~/models/tx', () => ({
  getMultiplier: jest.fn(),
  getCacheMultiplier: jest.fn(),
}));

jest.mock('~/models', () => ({
  updateBalance: jest.fn(),
  bulkInsertTransactions: jest.fn(),
}));

jest.mock('~/config', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: jest.fn(),
  })),
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({
    handleLLMEnd: jest.fn(),
    collected: [],
  }),
}));

const {
  runSpeculativeParallelMainRun,
  speculativeParallelDirectActionBlocked,
  shouldSuppressSpeculativeRunError,
} = require('./client');

/**
 * Simulates the real delivery/billing/persistence seams with injected closures.
 * The speculative run writes ONLY to the isolated spec arrays; commit moves them to the real arrays +
 * the user stream exactly once; discard drops them.
 */
function harness({
  detection,
  runEmitsContent = ['ans'],
  runEmitsUsage = [{ output_tokens: 7 }],
  runThrows = false,
} = {}) {
  const realContentParts = []; // == this.contentParts (persisted)
  const realUsage = []; // == this.collectedUsage (billed)
  const userStream = []; // == emitEvent sink (live delivery)
  const specContent = []; // == specAgg.contentParts (isolated)
  const specUsage = []; // == specCollectedUsage (isolated)
  const state = { aborted: false, runFinished: false, skipNormal: false };

  const args = {
    startSpeculativeRun: async () => {
      if (runThrows) {
        throw new Error('spec run boom');
      }
      await Promise.resolve();
      if (state.aborted) {
        return; // aborted runs deliver nothing into the isolated sink
      }
      for (const c of runEmitsContent) {
        specContent.push({ type: 'text', text: c });
      }
      for (const u of runEmitsUsage) {
        specUsage.push(u);
      }
      state.runFinished = true;
    },
    detect: async () => detection,
    abortSpeculative: () => {
      state.aborted = true;
    },
    commit: async () => {
      for (const p of specContent) {
        realContentParts.push(p);
        userStream.push(p); // delivered exactly once (canonical final-event/DB path)
      }
      for (const u of specUsage) {
        realUsage.push(u); // billed exactly once (recordCollectedUsage finally)
      }
      state.skipNormal = true;
    },
    discard: () => {
      specContent.length = 0;
      specUsage.length = 0;
    },
    logger: { warn: jest.fn() },
  };

  return { args, state, realContentParts, realUsage, userStream };
}

describe('speculative parallel main run — single-delivery / no-double-bill proofs', () => {
  // PROOF 4: fail-closed — a cortex declaring a direct-action surface disables speculation entirely.
  it('(4) fail-closed: a direct-action cortex blocks speculation', () => {
    expect(
      speculativeParallelDirectActionBlocked({
        cortices: [{ agentId: 'a', directActionSurfaceScopes: ['email_send'] }],
      }),
    ).toBe(true);
    expect(speculativeParallelDirectActionBlocked({ cortices: [{ agentId: 'b' }] })).toBe(false);
  });

  // PROOF 2: COMMIT — answer delivered once, billed once, normal run skipped.
  it('(2) commit on zero-activation: delivered once, billed once, normal run skipped', async () => {
    const h = harness({ detection: { activatedCortices: [], timedOut: false } });
    const r = await runSpeculativeParallelMainRun(h.args);
    expect(r.outcome).toBe('commit');
    expect(r.committed).toBe(true);
    expect(h.state.runFinished).toBe(true);
    expect(h.realContentParts).toEqual([{ type: 'text', text: 'ans' }]); // persisted once
    expect(h.userStream).toHaveLength(1); // delivered once (no double-stream)
    expect(h.realUsage).toEqual([{ output_tokens: 7 }]); // billed once (no double-bill)
    expect(h.state.skipNormal).toBe(true); // the normal main run is skipped
  });

  it('(2b) commit on zero-activation TIMEOUT still delivers exactly once', async () => {
    const h = harness({ detection: { activatedCortices: [], timedOut: true } });
    const r = await runSpeculativeParallelMainRun(h.args);
    expect(r.outcome).toBe('commit');
    expect(h.userStream).toHaveLength(1);
    expect(h.realUsage).toHaveLength(1);
  });

  it('(2c) commit path propagates speculative-run failure so fallback/error handling can run', async () => {
    const h = harness({
      detection: { activatedCortices: [], timedOut: false },
      runThrows: true,
    });

    await expect(runSpeculativeParallelMainRun(h.args)).rejects.toThrow('spec run boom');
    expect(h.realContentParts).toHaveLength(0);
    expect(h.userStream).toHaveLength(0);
    expect(h.realUsage).toHaveLength(0);
    expect(h.state.skipNormal).toBe(false);
  });

  // PROOF 3: ABORT — speculative output never delivered/billed/persisted; abort fired; normal run runs.
  it('(3) abort on activation: nothing delivered/billed/persisted, abort signalled', async () => {
    const h = harness({ detection: { activatedCortices: [{ agentId: 'x' }], timedOut: false } });
    const r = await runSpeculativeParallelMainRun(h.args);
    expect(r.outcome).toBe('abort');
    expect(r.committed).toBe(false);
    expect(h.state.aborted).toBe(true);
    expect(h.realContentParts).toHaveLength(0); // never persisted
    expect(h.userStream).toHaveLength(0); // never delivered
    expect(h.realUsage).toHaveLength(0); // never billed
    expect(h.state.skipNormal).toBe(false); // the post-inject normal run delivers instead
  });

  it('(3b) detection failure aborts + discards, never commits', async () => {
    const h = harness({ detection: undefined });
    h.args.detect = async () => {
      throw new Error('detect down');
    };
    const r = await runSpeculativeParallelMainRun(h.args);
    expect(r.outcome).toBe('abort');
    expect(r.detectFailed).toBe(true);
    expect(h.userStream).toHaveLength(0);
    expect(h.realUsage).toHaveLength(0);
  });

  it('(3c) speculative-run failure is ignored on activation abort and does not commit', async () => {
    const h = harness({
      detection: { activatedCortices: [{ agentId: 'x' }], timedOut: false },
      runThrows: true,
    });
    const r = await runSpeculativeParallelMainRun(h.args);
    expect(r.outcome).toBe('abort');
    expect(h.realUsage).toHaveLength(0);
    expect(h.userStream).toHaveLength(0);
  });

  it('suppresses only intentional abort errors from the live speculative branch', () => {
    expect(
      shouldSuppressSpeculativeRunError(new Error('operation was aborted'), { aborted: true }),
    ).toBe(true);
    expect(shouldSuppressSpeculativeRunError(new Error('status 403'), { aborted: false })).toBe(
      false,
    );
    expect(shouldSuppressSpeculativeRunError(new Error('status 403'), { aborted: true })).toBe(
      false,
    );
  });
});
