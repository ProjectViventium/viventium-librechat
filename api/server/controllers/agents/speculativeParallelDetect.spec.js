/**
 * Tests for speculative-parallel-detection decision primitives exported from AgentClient.
 *
 * These are the pure gate/decision helpers behind the default-OFF env flag
 * `VIVENTIUM_CORTEX_SPECULATIVE_PARALLEL_DETECT`:
 *   - getCortexSpeculativeParallelEnabled(req): flag + !voiceMode eligibility.
 *   - speculativeParallelDirectActionBlocked({...}): fail-closed gate on direct-action surfaces.
 *   - decideSpeculativeParallelOutcome({...}): commit-vs-abort keyed on activation/timeout.
 *
 * Loaded with the same minimal mock set used by recordCollectedUsage.spec.js so the full client
 * module resolves without standing up real DB/config/agents deps. We only exercise the pure exports.
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
  getCortexSpeculativeParallelEnabled,
  speculativeParallelDirectActionBlocked,
  decideSpeculativeParallelOutcome,
  shouldRunLiveSpeculativePhaseA,
} = require('./client');

const FLAG = 'VIVENTIUM_CORTEX_SPECULATIVE_PARALLEL_DETECT';

describe('speculative parallel cortex detection — decision primitives', () => {
  let originalFlag;

  beforeEach(() => {
    originalFlag = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = originalFlag;
    }
  });

  describe('(a) flag OFF -> disabled (default behavior unchanged)', () => {
    it('returns false when the flag is unset', () => {
      expect(getCortexSpeculativeParallelEnabled({ body: {} })).toBe(false);
    });

    it.each(['', '0', 'false', 'no', 'off', 'maybe', 'TRUEISH'])(
      'returns false for non-truthy flag value %p',
      (value) => {
        process.env[FLAG] = value;
        expect(getCortexSpeculativeParallelEnabled({ body: {} })).toBe(false);
      },
    );

    it('handles a missing/undefined req without throwing (defaults to disabled)', () => {
      expect(getCortexSpeculativeParallelEnabled(undefined)).toBe(false);
    });
  });

  describe('flag ON -> enabled only for TEXT (non-voice)', () => {
    it.each(['1', 'true', 'yes', 'on', 'ON', 'True', ' yes '])(
      'returns true for truthy flag value %p in text mode',
      (value) => {
        process.env[FLAG] = value;
        expect(getCortexSpeculativeParallelEnabled({ body: {} })).toBe(true);
      },
    );

    it('returns false in voice mode even when the flag is ON (voice owns its own Phase A policy)', () => {
      process.env[FLAG] = 'true';
      expect(getCortexSpeculativeParallelEnabled({ body: { voiceMode: true } })).toBe(false);
    });

    it('treats non-true voiceMode values as text mode', () => {
      process.env[FLAG] = 'true';
      expect(getCortexSpeculativeParallelEnabled({ body: { voiceMode: 'true' } })).toBe(true);
      expect(getCortexSpeculativeParallelEnabled({ body: { voiceMode: false } })).toBe(true);
    });
  });

  describe('(b) fail-closed gate forces blocking when a direct-action cortex is present', () => {
    it('blocks when ANY cortex declares a direct-action surface scope (intrinsic)', () => {
      const blocked = speculativeParallelDirectActionBlocked({
        cortices: [
          { agentId: 'a', directActionSurfaceScopes: [] },
          { agentId: 'b', directActionSurfaceScopes: ['email_send'] },
        ],
      });
      expect(blocked).toBe(true);
    });

    it('blocks when a configured direct-action surface matches a hydrated agent tool', () => {
      const blocked = speculativeParallelDirectActionBlocked({
        cortices: [{ agentId: 'a', directActionSurfaceScopes: [] }],
        directActionSurfaces: [{ scope_key: 'email_send', tool_names: ['gmail_send'] }],
        agentTools: [{ name: 'gmail_send' }],
      });
      expect(blocked).toBe(true);
    });

    it('does NOT block when no cortex/surface declares a direct action (speculation allowed)', () => {
      const blocked = speculativeParallelDirectActionBlocked({
        cortices: [{ agentId: 'a', directActionSurfaceScopes: [] }, { agentId: 'b' }],
        directActionSurfaces: [{ scope_key: 'email_send', tool_names: ['gmail_send'] }],
        // configured surface exists but the agent has no matching tool -> not effective
        agentTools: [{ name: 'web_search' }],
      });
      expect(blocked).toBe(false);
    });

    it('does NOT block for an empty / undefined cortex set with no configured surfaces', () => {
      expect(speculativeParallelDirectActionBlocked({})).toBe(false);
      expect(speculativeParallelDirectActionBlocked({ cortices: [] })).toBe(false);
    });
  });

  describe('(c) commit-vs-abort decision keyed on activatedCortices / timedOut', () => {
    it('aborts when one or more cortices activated', () => {
      expect(
        decideSpeculativeParallelOutcome({
          activatedCortices: [{ agentId: 'x' }],
          timedOut: false,
        }),
      ).toBe('abort');
    });

    it('aborts on activation even if detection also timed out', () => {
      expect(
        decideSpeculativeParallelOutcome({ activatedCortices: [{ agentId: 'x' }], timedOut: true }),
      ).toBe('abort');
    });

    it('commits when zero activations (clean no-activation result)', () => {
      expect(decideSpeculativeParallelOutcome({ activatedCortices: [], timedOut: false })).toBe(
        'commit',
      );
    });

    it('commits on a zero-activation timeout', () => {
      expect(decideSpeculativeParallelOutcome({ activatedCortices: [], timedOut: true })).toBe(
        'commit',
      );
    });

    it('commits when activatedCortices is missing/undefined (treated as zero)', () => {
      expect(decideSpeculativeParallelOutcome({})).toBe('commit');
      expect(decideSpeculativeParallelOutcome({ timedOut: true })).toBe('commit');
    });
  });

  describe('live speculative Phase A gate', () => {
    it('uses policy.enabled, not raw requested, so fail-closed tool cases do not speculate', () => {
      expect(
        shouldRunLiveSpeculativePhaseA({
          policy: {
            requested: true,
            enabled: false,
            forcedOff: true,
            reason: 'unowned_tool_hold_candidate_configured',
          },
        }),
      ).toBe(false);
    });

    it('allows speculation when the policy resolver has approved the mode', () => {
      expect(
        shouldRunLiveSpeculativePhaseA({
          policy: { requested: true, enabled: true, forcedOff: false, reason: 'enabled' },
        }),
      ).toBe(true);
    });
  });
});
