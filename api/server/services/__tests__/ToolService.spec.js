const { AgentCapabilities, defaultAgentCapabilities } = require('librechat-data-provider');

const mockEffectiveOrchestrationMode = jest.fn();
const mockParallelWorkClaimStateAsync = jest.fn();

jest.mock('~/server/services/viventium/ViventiumOrchestrationMode', () => ({
  effectiveOrchestrationMode: (...args) => mockEffectiveOrchestrationMode(...args),
  parallelWorkClaimStateAsync: (...args) => mockParallelWorkClaimStateAsync(...args),
}));

const { __testables } = require('../ToolService');

/**
 * Tests for ToolService capability checking logic.
 * The actual loadAgentTools function has many dependencies, so we test
 * the capability checking logic in isolation.
 */
describe('ToolService - Capability Checking', () => {
  describe('Parallel Work turn authority', () => {
    const orchestrationAgent = {
      tools: ['worker_delegate_once_mcp_glasshive-workers-projects'],
    };
    const originalTimeout = process.env.VIVENTIUM_PARALLEL_WORK_TURN_AUTHORITY_TIMEOUT_MS;

    beforeEach(() => {
      jest.clearAllMocks();
      mockEffectiveOrchestrationMode.mockReturnValue('parallel');
      delete process.env.VIVENTIUM_PARALLEL_WORK_TURN_AUTHORITY_TIMEOUT_MS;
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimeout === undefined) {
        delete process.env.VIVENTIUM_PARALLEL_WORK_TURN_AUTHORITY_TIMEOUT_MS;
      } else {
        process.env.VIVENTIUM_PARALLEL_WORK_TURN_AUTHORITY_TIMEOUT_MS = originalTimeout;
      }
    });

    test('pins and reuses one exact async claim before orchestration tool discovery', async () => {
      const claimState = { available: true, label: 'PRE-GATE / NOT READY', blockers: [] };
      mockParallelWorkClaimStateAsync.mockResolvedValue(claimState);
      const req = { user: { id: 'owner-1', personalization: { orchestration_mode: 'parallel' } } };

      const first = __testables.startParallelWorkTurnAuthority(req, orchestrationAgent);
      const second = __testables.startParallelWorkTurnAuthority(req, orchestrationAgent);

      expect(first).toBe(second);
      await expect(first).resolves.toBe(true);
      expect(mockParallelWorkClaimStateAsync).toHaveBeenCalledTimes(1);
      expect(mockParallelWorkClaimStateAsync).toHaveBeenCalledWith('owner-1');
      expect(req._viventiumParallelWorkTurnAvailable).toBe(true);
      expect(req._viventiumParallelWorkTurnClaim).toBe(claimState);
    });

    test('pins false on timeout and ignores a late true result', async () => {
      jest.useFakeTimers();
      process.env.VIVENTIUM_PARALLEL_WORK_TURN_AUTHORITY_TIMEOUT_MS = '25';
      let resolveClaim;
      mockParallelWorkClaimStateAsync.mockReturnValue(
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
      );
      const req = { user: { id: 'owner-1', personalization: { orchestration_mode: 'parallel' } } };

      const decision = __testables.startParallelWorkTurnAuthority(req, orchestrationAgent);
      await jest.advanceTimersByTimeAsync(25);

      await expect(decision).resolves.toBe(false);
      expect(req._viventiumParallelWorkTurnAvailable).toBe(false);
      expect(req._viventiumParallelWorkTurnClaim).toBeUndefined();
      resolveClaim({ available: true, label: 'PRE-GATE / NOT READY', blockers: [] });
      await Promise.resolve();
      expect(req._viventiumParallelWorkTurnAvailable).toBe(false);
      expect(req._viventiumParallelWorkTurnClaim).toBeUndefined();
    });

    test('keeps focused requests fast and fail closed without validating release authority', async () => {
      mockEffectiveOrchestrationMode.mockReturnValue('focused');
      const req = { user: { id: 'owner-1', personalization: { orchestration_mode: 'focused' } } };

      await expect(
        __testables.startParallelWorkTurnAuthority(req, orchestrationAgent),
      ).resolves.toBe(false);

      expect(mockParallelWorkClaimStateAsync).not.toHaveBeenCalled();
      expect(req._viventiumParallelWorkTurnAvailable).toBe(false);
    });
  });

  describe('checkCapability logic', () => {
    /**
     * Simulates the checkCapability function from loadAgentTools
     */
    const createCheckCapability = (enabledCapabilities, logger = { warn: jest.fn() }) => {
      return (capability) => {
        const enabled = enabledCapabilities.has(capability);
        if (!enabled) {
          const isToolCapability = [
            AgentCapabilities.file_search,
            AgentCapabilities.execute_code,
            AgentCapabilities.web_search,
          ].includes(capability);
          const suffix = isToolCapability ? ' despite configured tool.' : '.';
          logger.warn(`Capability "${capability}" disabled${suffix}`);
        }
        return enabled;
      };
    };

    it('should return true when capability is enabled', () => {
      const enabledCapabilities = new Set([AgentCapabilities.deferred_tools]);
      const checkCapability = createCheckCapability(enabledCapabilities);

      expect(checkCapability(AgentCapabilities.deferred_tools)).toBe(true);
    });

    it('should return false when capability is not enabled', () => {
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities);

      expect(checkCapability(AgentCapabilities.deferred_tools)).toBe(false);
    });

    it('should log warning with "despite configured tool" for tool capabilities', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.file_search);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.execute_code);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.web_search);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));
    });

    it('should log warning without "despite configured tool" for non-tool capabilities', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.deferred_tools);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "deferred_tools" disabled.'),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('despite configured tool'),
      );

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.tools);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "tools" disabled.'),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('despite configured tool'),
      );

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.actions);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "actions" disabled.'),
      );
    });

    it('should not log warning when capability is enabled', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([
        AgentCapabilities.deferred_tools,
        AgentCapabilities.file_search,
      ]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.deferred_tools);
      checkCapability(AgentCapabilities.file_search);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('defaultAgentCapabilities', () => {
    it('should include deferred_tools capability by default', () => {
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.deferred_tools);
    });

    it('should include all expected default capabilities', () => {
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.execute_code);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.file_search);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.web_search);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.artifacts);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.actions);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.context);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.tools);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.chain);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.ocr);
    });
  });

  describe('deferredToolsEnabled integration', () => {
    it('should correctly determine deferredToolsEnabled from capabilities set', () => {
      const createCheckCapability = (enabledCapabilities) => {
        return (capability) => enabledCapabilities.has(capability);
      };

      // When deferred_tools is in capabilities
      const withDeferred = new Set([AgentCapabilities.deferred_tools, AgentCapabilities.tools]);
      const checkWithDeferred = createCheckCapability(withDeferred);
      expect(checkWithDeferred(AgentCapabilities.deferred_tools)).toBe(true);

      // When deferred_tools is NOT in capabilities
      const withoutDeferred = new Set([AgentCapabilities.tools, AgentCapabilities.actions]);
      const checkWithoutDeferred = createCheckCapability(withoutDeferred);
      expect(checkWithoutDeferred(AgentCapabilities.deferred_tools)).toBe(false);
    });

    it('should use defaultAgentCapabilities when no capabilities configured', () => {
      // Simulates the fallback behavior in loadAgentTools
      const endpointsConfig = {}; // No capabilities configured
      const enabledCapabilities = new Set(
        endpointsConfig?.capabilities ?? defaultAgentCapabilities,
      );

      expect(enabledCapabilities.has(AgentCapabilities.deferred_tools)).toBe(true);
    });
  });
});
