import {
  useRef,
  useMemo,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
} from 'react';
import { debounce } from 'lodash';
import { useRecoilState } from 'recoil';
import { useNavigate } from 'react-router-dom';
import {
  apiBaseUrl,
  SystemRoles,
  setTokenHeader,
  buildLoginRedirectUrl,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useGetRole,
  useGetUserQuery,
  useLoginUserMutation,
  useLogoutUserMutation,
  useRefreshTokenMutation,
} from '~/data-provider';
import { TAuthConfig, TUserContext, TAuthContext, TResError } from '~/common';
import {
  CONNECTED_ACCOUNTS_SETUP_PENDING_KEY,
  isConnectedAccountsSetupDestination,
} from '~/common/connectedAccounts';
import { SESSION_KEY, isSafeRedirect, getPostLoginRedirect, getResponseStatus } from '~/utils';
import useTimeout from './useTimeout';
import store from '~/store';

const AuthContext = createContext<TAuthContext | undefined>(undefined);

const AuthContextProvider = ({
  authConfig,
  children,
}: {
  authConfig?: TAuthConfig;
  children: ReactNode;
}) => {
  const isExternalRedirectRef = useRef(false);
  const [user, setUser] = useRecoilState(store.user);
  const logoutRedirectRef = useRef<string | undefined>(undefined);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  /* === VIVENTIUM START ===
   * A service outage is not evidence that the saved session was rejected.
   */
  const [isAuthUnavailable, setIsAuthUnavailable] = useState(false);
  /* === VIVENTIUM END === */

  const { data: userRole = null } = useGetRole(SystemRoles.USER, {
    enabled: !!(isAuthenticated && (user?.role ?? '')),
  });
  const { data: adminRole = null } = useGetRole(SystemRoles.ADMIN, {
    enabled: !!(isAuthenticated && user?.role === SystemRoles.ADMIN),
  });

  const navigate = useNavigate();

  const setUserContext = useMemo(
    () =>
      debounce((userContext: TUserContext) => {
        const { token, isAuthenticated, user, redirect } = userContext;
        setUser(user);
        setToken(token);
        setTokenHeader(token);
        setIsAuthenticated(isAuthenticated);
        /* === VIVENTIUM START === */
        setIsAuthUnavailable(false);
        /* === VIVENTIUM END === */

        const searchParams = new URLSearchParams(window.location.search);
        const postLoginRedirect = getPostLoginRedirect(searchParams);

        /* === VIVENTIUM START ===
         * Feature: Remount-safe Easy Install account handoff.
         * Purpose: Capture setup intent before authentication navigation mounts the chat shell.
         */
        if (isConnectedAccountsSetupDestination(postLoginRedirect)) {
          sessionStorage.setItem(CONNECTED_ACCOUNTS_SETUP_PENDING_KEY, 'true');
        }
        /* === VIVENTIUM END === */

        const logoutRedirect = logoutRedirectRef.current;
        logoutRedirectRef.current = undefined;

        const finalRedirect =
          logoutRedirect ??
          (isAuthenticated ? postLoginRedirect : null) ??
          (redirect && isSafeRedirect(redirect) ? redirect : null);

        if (finalRedirect == null) {
          return;
        }

        navigate(finalRedirect, { replace: true });
      }, 50),
    [navigate, setUser],
  );
  const doSetError = useTimeout({ callback: (error) => setError(error as string | undefined) });

  const { mutate: loginUser } = useLoginUserMutation({
    onSuccess: (data: t.TLoginResponse) => {
      const { user, token, twoFAPending, tempToken } = data;
      if (twoFAPending) {
        navigate(`/login/2fa?tempToken=${tempToken}`, { replace: true });
        return;
      }
      setError(undefined);
      setUserContext({ token, isAuthenticated: true, user, redirect: '/c/new' });
    },
    onError: (error: TResError | unknown) => {
      const resError = error as TResError;
      doSetError(resError.message);
      // Preserve a valid redirect_to across login failures so the deep link survives retries.
      // Cannot use buildLoginRedirectUrl() here — it reads the current pathname (already /login)
      // and would return plain /login, dropping the redirect_to destination.
      const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
      const loginPath =
        redirectTo && isSafeRedirect(redirectTo)
          ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
          : '/login';
      navigate(loginPath, { replace: true });
    },
  });
  const { mutate: logoutUser } = useLogoutUserMutation({
    onSuccess: (data) => {
      if (data.redirect) {
        /** data.redirect is the IdP's end_session_endpoint URL — an absolute URL generated
         * server-side from trusted IdP metadata (not user input), so isSafeRedirect is bypassed.
         * setUserContext is debounced (50ms) and won't fire before page unload, so clear the
         * axios Authorization header synchronously to prevent in-flight requests. */
        isExternalRedirectRef.current = true;
        setTokenHeader(undefined);
        window.location.replace(data.redirect);
        return;
      }
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
    onError: (error) => {
      doSetError((error as Error).message);
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
  });
  /* === VIVENTIUM START ===
   * Use the existing request lifecycle for bounded transport recovery.
   * A rejected session must never be retried as an outage.
   */
  const { mutate: refreshToken } = useRefreshTokenMutation({
    networkMode: 'always',
    retry: (failureCount, failure) => {
      const status = getResponseStatus(failure);
      return (
        failureCount < 2 && (status == null || status === 408 || status === 429 || status >= 500)
      );
    },
  });
  /* === VIVENTIUM END === */

  const logout = useCallback(
    (redirect = '/login') => {
      logoutRedirectRef.current = redirect;
      logoutUser(undefined);
    },
    [logoutUser],
  );

  const userQuery = useGetUserQuery({ enabled: !!(token ?? '') });

  const login = useCallback(
    (data: t.TLoginUser) => {
      loginUser(data);
    },
    [loginUser],
  );

  const silentRefresh = useCallback(() => {
    if (authConfig?.test === true) {
      console.log('Test mode. Skipping silent refresh.');
      return;
    }
    if (isExternalRedirectRef.current) {
      return;
    }
    /* === VIVENTIUM START === */
    setIsAuthUnavailable(false);
    /* === VIVENTIUM END === */
    refreshToken(undefined, {
      onSuccess: (data: t.TRefreshTokenResponse | undefined) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        const { user, token = '' } = data ?? {};
        if (token) {
          const storedRedirect = sessionStorage.getItem(SESSION_KEY);
          sessionStorage.removeItem(SESSION_KEY);
          const baseUrl = apiBaseUrl();
          const rawPath = window.location.pathname;
          const strippedPath =
            baseUrl && (rawPath === baseUrl || rawPath.startsWith(baseUrl + '/'))
              ? rawPath.slice(baseUrl.length) || '/'
              : rawPath;
          const currentUrl = `${strippedPath}${window.location.search}${window.location.hash}`;
          const fallbackRedirect = isSafeRedirect(currentUrl) ? currentUrl : '/c/new';
          const redirect =
            storedRedirect && isSafeRedirect(storedRedirect) ? storedRedirect : fallbackRedirect;
          /* === VIVENTIUM START ===
           * Feature: Remount-safe Easy Install account handoff.
           * Purpose: Preserve the same setup intent across OAuth/silent-refresh authentication.
           */
          if (isConnectedAccountsSetupDestination(redirect)) {
            sessionStorage.setItem(CONNECTED_ACCOUNTS_SETUP_PENDING_KEY, 'true');
          }
          /* === VIVENTIUM END === */
          setUserContext({ user, token, isAuthenticated: true, redirect });
          return;
        }
        console.log('Token is not present. User is not authenticated.');
        if (authConfig?.test === true) {
          return;
        }
        /* === VIVENTIUM START === */
        setUserContext({ user: undefined, token: undefined, isAuthenticated: false });
        navigate(buildLoginRedirectUrl(), { replace: true });
        /* === VIVENTIUM END === */
      },
      onError: (error) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        /* === VIVENTIUM START === */
        const status = getResponseStatus(error);
        if (status === 401 || status === 403) {
          setUserContext({ user: undefined, token: undefined, isAuthenticated: false });
          navigate(buildLoginRedirectUrl(), { replace: true });
          return;
        }
        setIsAuthUnavailable(true);
        /* === VIVENTIUM END === */
      },
    });
  }, [authConfig?.test, refreshToken, navigate, setUserContext]);

  /* === VIVENTIUM START ===
   * Authentication owns its initial refresh. Child routes must not infer failure
   * from an elapsed timer, and a user-query error must not start a refresh loop.
   */
  useEffect(() => {
    silentRefresh();
  }, [silentRefresh]);
  /* === VIVENTIUM END === */

  useEffect(() => {
    if (isExternalRedirectRef.current) {
      return;
    }
    if (userQuery.data) {
      setUser(userQuery.data);
    } else if (userQuery.isError) {
      /* === VIVENTIUM START === */
      const status = getResponseStatus(userQuery.error);
      if (status === 401 || status === 403) {
        setUserContext({ user: undefined, token: undefined, isAuthenticated: false });
        navigate(buildLoginRedirectUrl(), { replace: true });
      }
      /* === VIVENTIUM END === */
    }
    if (error != null && error && isAuthenticated) {
      setError(undefined);
    }
  }, [
    token,
    isAuthenticated,
    userQuery.data,
    userQuery.isError,
    userQuery.error,
    error,
    setUser,
    navigate,
    silentRefresh,
    setUserContext,
  ]);

  useEffect(() => {
    const handleTokenUpdate = (event: CustomEvent<string>) => {
      console.log('tokenUpdated event received event');
      setUserContext({
        token: event.detail,
        isAuthenticated: true,
        user: user,
      });
    };

    window.addEventListener('tokenUpdated', handleTokenUpdate as EventListener);

    return () => {
      window.removeEventListener('tokenUpdated', handleTokenUpdate as EventListener);
    };
  }, [setUserContext, user]);

  const memoedValue = useMemo(
    () => ({
      user,
      token,
      error,
      login,
      logout,
      setError,
      roles: {
        [SystemRoles.USER]: userRole,
        [SystemRoles.ADMIN]: adminRole,
      },
      isAuthenticated,
      /* === VIVENTIUM START === */
      isAuthUnavailable,
      retryAuthentication: silentRefresh,
      /* === VIVENTIUM END === */
    }),

    [
      user,
      error,
      isAuthenticated,
      token,
      userRole,
      adminRole,
      isAuthUnavailable,
      silentRefresh,
      login,
      logout,
    ],
  );

  return <AuthContext.Provider value={memoedValue}>{children}</AuthContext.Provider>;
};

const useAuthContext = () => {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuthContext should be used inside AuthProvider');
  }

  return context;
};

export { AuthContextProvider, useAuthContext, AuthContext };
