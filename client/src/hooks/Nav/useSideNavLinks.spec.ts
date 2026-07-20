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

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
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
});
