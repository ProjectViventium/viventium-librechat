/**
 * @jest-environment @happy-dom/jest-environment
 */
/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { TAuthConfig } from '~/common';

import { AuthContextProvider, useAuthContext } from '../AuthContext';
import { SESSION_KEY } from '~/utils';
import { useGetUserQuery } from '~/data-provider';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const mockApiBaseUrl = jest.fn(() => '');

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  setTokenHeader: jest.fn(),
  apiBaseUrl: () => mockApiBaseUrl(),
}));

let mockCapturedLoginOptions: {
  onSuccess: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
};

let mockCapturedLogoutOptions: {
  onSuccess: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
};

const mockRefreshMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useLoginUserMutation: jest.fn(
    (options: {
      onSuccess: (...args: unknown[]) => void;
      onError: (...args: unknown[]) => void;
    }) => {
      mockCapturedLoginOptions = options;
      return { mutate: jest.fn() };
    },
  ),
  useLogoutUserMutation: jest.fn(
    (options: {
      onSuccess: (...args: unknown[]) => void;
      onError: (...args: unknown[]) => void;
    }) => {
      mockCapturedLogoutOptions = options;
      return { mutate: jest.fn() };
    },
  ),
  useRefreshTokenMutation: jest.fn(() => ({ mutate: mockRefreshMutate })),
  useGetUserQuery: jest.fn(() => ({
    data: undefined,
    isError: false,
    error: null,
  })),
  useGetRole: jest.fn(() => ({ data: null })),
}));

const authConfig: TAuthConfig = { loginRedirect: '/login', test: true };

function TestConsumer() {
  const ctx = useAuthContext();
  return (
    <div
      data-testid="consumer"
      data-authenticated={ctx.isAuthenticated}
      data-unavailable={ctx.isAuthUnavailable}
    >
      <button onClick={ctx.retryAuthentication}>Retry</button>
      <button onClick={() => ctx.logout()}>Log out</button>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContextProvider authConfig={authConfig}>
            <TestConsumer />
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

/** Renders without test:true so silentRefresh actually runs */
function renderProviderLive() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContextProvider authConfig={{ loginRedirect: '/login' }}>
            <TestConsumer />
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderProvider: () => result.rerender(tree()) };
}

describe('AuthContextProvider — login onError redirect handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/login');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('preserves a valid redirect_to param across login failure', () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Fc%2Fabc123');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login?redirect_to=%2Fc%2Fabc123', {
      replace: true,
    });
  });

  it('drops redirect_to when it contains an absolute URL (open-redirect prevention)', () => {
    window.history.replaceState({}, '', '/login?redirect_to=https%3A%2F%2Fevil.com');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('drops redirect_to when it points to /login (recursive redirect prevention)', () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Flogin');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('navigates to plain /login when no redirect_to param exists', () => {
    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Server error' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('preserves redirect_to with query params and hash', () => {
    const target = '/c/abc123?model=gpt-4#section';
    window.history.replaceState({}, '', `/login?redirect_to=${encodeURIComponent(target)}`);

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    const navigatedUrl = mockNavigate.mock.calls[0][0] as string;
    const params = new URLSearchParams(navigatedUrl.split('?')[1]);
    expect(decodeURIComponent(params.get('redirect_to')!)).toBe(target);
  });
});

describe('AuthContextProvider — logout onSuccess/onError handling', () => {
  const mockSetTokenHeader = jest.requireMock('librechat-data-provider').setTokenHeader;

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/c/some-chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('calls window.location.replace and setTokenHeader(undefined) when redirect is present', () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({
        message: 'Logout successful',
        redirect: 'https://idp.example.com/logout?id_token_hint=abc',
      });
    });

    expect(replaceSpy).toHaveBeenCalledWith('https://idp.example.com/logout?id_token_hint=abc');
    expect(mockSetTokenHeader).toHaveBeenCalledWith(undefined);
  });

  it('does not call window.location.replace when redirect is absent', async () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({ message: 'Logout successful' });
    });

    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'] as const)(
    'opens local sign-in after the user logs out (%s)',
    (result) => {
      jest.useFakeTimers();
      sessionStorage.setItem(SESSION_KEY, '/c/old-destination');
      const { getByRole, getByTestId } = renderProvider();

      act(() => {
        mockCapturedLoginOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'token' });
        jest.advanceTimersByTime(100);
      });
      expect(getByTestId('consumer').getAttribute('data-authenticated')).toBe('true');
      mockNavigate.mockClear();

      fireEvent.click(getByRole('button', { name: 'Log out' }));
      act(() => {
        if (result === 'success') {
          mockCapturedLogoutOptions.onSuccess({ message: 'Logout successful' });
        } else {
          mockCapturedLogoutOptions.onError(new Error('Logout failed'));
        }
        jest.advanceTimersByTime(100);
      });

      expect(getByTestId('consumer').getAttribute('data-authenticated')).toBe('false');
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
      jest.useRealTimers();
      sessionStorage.clear();
    },
  );

  it('does not trigger silentRefresh after OIDC redirect', () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProviderLive();
    mockRefreshMutate.mockClear();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({
        message: 'Logout successful',
        redirect: 'https://idp.example.com/logout?id_token_hint=abc',
      });
    });

    expect(replaceSpy).toHaveBeenCalled();
    expect(mockRefreshMutate).not.toHaveBeenCalled();
  });
});

describe('AuthContextProvider — silentRefresh post-login redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('navigates to stored sessionStorage redirect after successful token refresh', () => {
    jest.useFakeTimers();
    sessionStorage.setItem(SESSION_KEY, '/c/new?endpoint=bedrock&model=claude-sonnet-4-5');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new?endpoint=bedrock&model=claude-sonnet-4-5', {
      replace: true,
    });
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    jest.useRealTimers();
  });

  it('navigates to current URL when no stored redirect exists', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/c/new');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
    jest.useRealTimers();
  });

  it('does not re-trigger silentRefresh after successful redirect', () => {
    jest.useFakeTimers();
    sessionStorage.setItem(SESSION_KEY, '/c/abc?endpoint=bedrock');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];
    mockRefreshMutate.mockClear();

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/abc?endpoint=bedrock', { replace: true });
    expect(mockRefreshMutate).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('falls back to current URL for unsafe stored redirect', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/c/new');
    sessionStorage.setItem(SESSION_KEY, 'https://evil.com/steal');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
    expect(mockNavigate).not.toHaveBeenCalledWith('https://evil.com/steal', expect.anything());
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — silentRefresh subdirectory deployment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockApiBaseUrl.mockReturnValue('/chat');
  });

  afterEach(() => {
    mockApiBaseUrl.mockReturnValue('');
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('strips base path from window.location.pathname before navigating (prevents /chat/chat doubling)', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/chat/c/abc123?model=gpt-4');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/abc123?model=gpt-4', { replace: true });
    expect(mockNavigate).not.toHaveBeenCalledWith(
      expect.stringContaining('/chat/c/'),
      expect.anything(),
    );
    jest.useRealTimers();
  });

  it('falls back to root when window.location.pathname equals the base path', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/chat');

    renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — logout error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/c/some-chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('clears auth state on logout error without external redirect', () => {
    jest.useFakeTimers();
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});
    const { getByTestId } = renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onError(new Error('Logout failed'));
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(getByTestId('consumer').getAttribute('data-authenticated')).toBe('false');
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — service availability is separate from authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/c/availability?view=notes#last');
    sessionStorage.clear();
  });
  afterEach(() => {
    (useGetUserQuery as jest.Mock).mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
    });
    jest.useRealTimers();
    window.history.replaceState({}, '', '/');
  });

  it.each([undefined, 408, 429, 500, 503])(
    'keeps the destination on refresh failure %s and allows recovery',
    (status) => {
      const { getByTestId, getByRole } = renderProviderLive();
      act(() => mockRefreshMutate.mock.calls[0][1].onError({ status, message: 'Unavailable' }));
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(getByTestId('consumer')).toHaveAttribute('data-authenticated', 'false');
      expect(getByTestId('consumer')).toHaveAttribute('data-unavailable', 'true');
      fireEvent.click(getByRole('button', { name: 'Retry' }));
      expect(mockRefreshMutate).toHaveBeenCalledTimes(2);
      act(() => {
        mockRefreshMutate.mock.calls[1][1].onSuccess({ token: 'restored', user: { id: 'owner' } });
        jest.advanceTimersByTime(50);
      });
      expect(getByTestId('consumer')).toHaveAttribute('data-authenticated', 'true');
      expect(getByTestId('consumer')).toHaveAttribute('data-unavailable', 'false');
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/availability?view=notes#last', {
        replace: true,
      });
    },
  );

  it.each([401, 403])(
    'redirects only after confirmed rejection %s and preserves the destination',
    (status) => {
      renderProviderLive();
      act(() => {
        mockRefreshMutate.mock.calls[0][1].onError({ status });
        jest.advanceTimersByTime(50);
      });
      expect(mockNavigate).toHaveBeenLastCalledWith(
        '/login?redirect_to=%2Fc%2Favailability%3Fview%3Dnotes%23last',
        { replace: true },
      );
    },
  );

  it('treats a successful refresh with no token as signed out', () => {
    renderProviderLive();
    act(() => {
      mockRefreshMutate.mock.calls[0][1].onSuccess(undefined);
      jest.advanceTimersByTime(50);
    });
    expect(mockNavigate).toHaveBeenLastCalledWith(
      '/login?redirect_to=%2Fc%2Favailability%3Fview%3Dnotes%23last',
      { replace: true },
    );
  });

  it('does not infer sign-in failure from a slow refresh', () => {
    const { getByTestId } = renderProviderLive();
    act(() => jest.advanceTimersByTime(10000));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByTestId('consumer')).toHaveAttribute('data-authenticated', 'false');
    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 429, 503])(
    'keeps the authenticated view when user lookup fails with %s',
    (status) => {
      const result = renderProviderLive();
      act(() => {
        mockRefreshMutate.mock.calls[0][1].onSuccess({ token: 'valid', user: { id: 'owner' } });
        jest.advanceTimersByTime(50);
      });
      mockNavigate.mockClear();
      (useGetUserQuery as jest.Mock).mockReturnValue({
        data: undefined,
        isError: true,
        error: { status },
      });
      result.rerenderProvider();
      act(() => jest.advanceTimersByTime(50));
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(result.getByTestId('consumer')).toHaveAttribute('data-authenticated', 'true');
    },
  );

  it('clears the authenticated view when user lookup confirms rejection', () => {
    const result = renderProviderLive();
    act(() => {
      mockRefreshMutate.mock.calls[0][1].onSuccess({ token: 'valid', user: { id: 'owner' } });
      jest.advanceTimersByTime(50);
    });
    mockNavigate.mockClear();
    (useGetUserQuery as jest.Mock).mockReturnValue({
      data: undefined,
      isError: true,
      error: { status: 401 },
    });
    result.rerenderProvider();
    act(() => jest.advanceTimersByTime(50));
    expect(result.getByTestId('consumer')).toHaveAttribute('data-authenticated', 'false');
    expect(mockNavigate).toHaveBeenLastCalledWith(
      '/login?redirect_to=%2Fc%2Favailability%3Fview%3Dnotes%23last',
      { replace: true },
    );
  });
});
