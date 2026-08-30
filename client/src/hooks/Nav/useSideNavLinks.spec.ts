/**
 * === VIVENTIUM START ===
 * Feature: Feelings navigation discovery regression coverage.
 * Purpose: Prove the ordinary chat navigation exposes Feelings only when runtime capability permits it.
 * === VIVENTIUM END ===
 */

import { act, renderHook } from '@testing-library/react';
import useSideNavLinks from './useSideNavLinks';

const mockNavigate = jest.fn();
const mockUseGetStartupConfig = jest.fn();
const mockUseOrchestrationPreferenceQuery = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));
jest.mock('~/data-provider/ViventiumOrchestration', () => ({
  useOrchestrationPreferenceQuery: (options) => mockUseOrchestrationPreferenceQuery(options),
}));

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useMCPServerManager: () => ({ availableMCPServers: [] }),
}));

const baseArguments = {
  hidePanel: jest.fn(),
  keyProvided: true,
  endpoint: null,
  endpointType: null,
  interfaceConfig: {},
  endpointsConfig: {},
};

describe('useSideNavLinks Feelings discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseOrchestrationPreferenceQuery.mockReturnValue({
      data: { hasKnownWork: false },
      isError: false,
    });
  });

  it.each([{}, { viventiumFeelingsAvailable: true }])(
    'shows Feelings when startup config is %p and navigates to the immersive route',
    (startupConfig) => {
      mockUseGetStartupConfig.mockReturnValue({ data: startupConfig });
      const { result } = renderHook(() => useSideNavLinks(baseArguments));
      const feelingsLink = result.current.find((link) => link.id === 'feelings');
      const linkIds = result.current.map((link) => link.id);

      expect(feelingsLink?.title).toBe('com_nav_feelings');
      expect(linkIds.indexOf('feelings')).toBe(linkIds.indexOf('prompts') + 1);
      expect(linkIds.indexOf('feelings')).toBe(linkIds.indexOf('memories') - 1);
      act(() => feelingsLink?.onClick?.());
      expect(mockNavigate).toHaveBeenCalledWith('/feelings');
    },
  );

  it('hides Feelings when the operator explicitly disables it', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { viventiumFeelingsAvailable: false },
    });
    const { result } = renderHook(() => useSideNavLinks(baseArguments));

    expect(result.current.some((link) => link.id === 'feelings')).toBe(false);
  });

  it('puts Active work in the Control Panel before reference tools', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: { viventiumParallelWorkAvailable: true } });
    const { result } = renderHook(() => useSideNavLinks(baseArguments));
    const linkIds = result.current.map((link) => link.id);
    const activeWork = result.current.find((link) => link.id === 'active-work');

    expect(activeWork?.title).toBe('com_ui_parallel_work_active');
    expect(activeWork?.Component).toBeDefined();
    expect(linkIds.indexOf('active-work')).toBeGreaterThanOrEqual(0);
    expect(linkIds.indexOf('active-work')).toBeLessThan(linkIds.indexOf('prompts'));
    expect(linkIds.indexOf('active-work')).toBeLessThan(linkIds.indexOf('feelings'));
    expect(linkIds.indexOf('active-work')).toBeLessThan(linkIds.indexOf('memories'));
    expect(mockUseOrchestrationPreferenceQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('keeps the dark empty feature out of the Control Panel', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: { viventiumParallelWorkAvailable: false } });
    const { result } = renderHook(() => useSideNavLinks(baseArguments));

    expect(result.current.some((link) => link.id === 'active-work')).toBe(false);
    expect(mockUseOrchestrationPreferenceQuery).toHaveBeenCalledWith({ enabled: true });
  });

  it('keeps known work reachable after Parallel admission is disabled', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: { viventiumParallelWorkAvailable: false } });
    mockUseOrchestrationPreferenceQuery.mockReturnValue({
      data: { hasKnownWork: true },
      isError: false,
    });
    const { result, rerender } = renderHook(() => useSideNavLinks(baseArguments));

    expect(result.current.some((link) => link.id === 'active-work')).toBe(true);

    mockUseOrchestrationPreferenceQuery.mockReturnValue({
      data: { hasKnownWork: false },
      isError: false,
    });
    rerender();

    expect(result.current.some((link) => link.id === 'active-work')).toBe(true);
  });
});
