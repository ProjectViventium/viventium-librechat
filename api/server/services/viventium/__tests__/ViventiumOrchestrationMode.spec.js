const ORIGINAL_ENV = { ...process.env };

jest.mock('../GlassHiveOrchestrationReadinessService', () => ({
  orchestrationReadinessSnapshot: () => ({
    available: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  }),
}));

describe('ViventiumOrchestrationMode', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'focused';
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('uses the compiled default only when the account has no explicit override', () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'parallel';
    const { effectiveOrchestrationMode } = require('../ViventiumOrchestrationMode');

    expect(effectiveOrchestrationMode({})).toBe('parallel');
    expect(
      effectiveOrchestrationMode({ personalization: { orchestration_mode: 'focused' } }),
    ).toBe('focused');
  });

  test('fails closed to focused whenever the capability is unavailable', () => {
    const { effectiveOrchestrationMode } = require('../ViventiumOrchestrationMode');

    expect(
      effectiveOrchestrationMode(
        { personalization: { orchestration_mode: 'parallel' } },
        { available: false },
      ),
    ).toBe('focused');
  });
});
