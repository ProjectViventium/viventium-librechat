import { renderHook, act } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, request } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import useKeyDialog from '../useKeyDialog';

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    openAI: 'openAI',
    anthropic: 'anthropic',
  },
  QueryKeys: {
    name: 'name',
  },
  apiBaseUrl: jest.fn(() => ''),
  request: {
    get: jest.fn(),
  },
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

describe('useKeyDialog', () => {
  const mockInvalidateQueries = jest.fn();
  const mockShowToast = jest.fn();
  const mockUseQueryClient = useQueryClient as jest.MockedFunction<typeof useQueryClient>;
  const mockUseToastContext = useToastContext as jest.MockedFunction<typeof useToastContext>;
  const mockRequestGet = request.get as jest.MockedFunction<typeof request.get>;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: mockInvalidateQueries,
    } as never);
    mockUseToastContext.mockReturnValue({
      showToast: mockShowToast,
    } as never);
  });

  it('opens the Anthropic browser flow and primes manual-code settings state', async () => {
    mockRequestGet.mockResolvedValue({
      flowMode: 'manual_code',
      authUrl:
        'https://claude.ai/oauth/authorize?code=true&state=anthropic-state-123&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
    } as never);

    const popup = {
      closed: false,
      close: jest.fn(),
      location: { href: '' },
    } as unknown as Window;
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => popup);
    const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

    const { result } = renderHook(() => useKeyDialog({ connectedAccountsEnabled: true }));
    const event = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as never;

    await act(async () => {
      result.current.handleOpenKeyDialog(EModelEndpoint.anthropic, event);
    });

    expect(mockRequestGet).toHaveBeenCalledWith('/api/connected-accounts/anthropic/start');
    expect(openSpy).toHaveBeenCalled();
    expect(popup.location.href).toContain('https://claude.ai/oauth/authorize');
    expect(sessionStorage.getItem('viventium:connected-accounts:manual-flow')).toBe(
      JSON.stringify({ provider: 'anthropic', state: 'anthropic-state-123' }),
    );
    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'viventium:connected-accounts-manual-flow' }),
    );
    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'viventium:open-connected-accounts' }),
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'com_ui_connected_account_manual_open_settings:{"provider":"com_ui_anthropic"}',
      }),
    );

    openSpy.mockRestore();
    dispatchEventSpy.mockRestore();
  });
});
