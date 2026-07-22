/* === VIVENTIUM START ===
 * Feature: Connected Accounts provider-auth flows.
 * Purpose: Give novice users one truthful place to save or remove local provider credentials.
 * === VIVENTIUM END === */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EModelEndpoint, apiBaseUrl, request } from 'librechat-data-provider';
import { useRevokeUserKeyMutation, useUserKeyQuery } from 'librechat-data-provider/react-query';
import { Button, Label, Spinner, useToastContext } from '@librechat/client';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { SetKeyDialog } from '~/components/Input/SetKeyDialog';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks';
import {
  CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT,
  CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY,
  type ConnectedAccountsManualFlowDetail,
  type ConnectedAccountProviderSlug,
} from '~/common/connectedAccounts';
import { cn } from '~/utils';

type ProviderSlug = ConnectedAccountProviderSlug;
type ApiKeyOnlyProviderSlug = 'groq' | 'xai';

type ProviderDefinition = {
  endpoint: EModelEndpoint | string;
  endpointType?: EModelEndpoint;
  labelKey: TranslationKeys;
  platformFallbackAvailable: boolean;
  queryKey: EModelEndpoint | string;
} & ({ oauth: true; slug: ProviderSlug } | { oauth: false; slug: ApiKeyOnlyProviderSlug });

type OAuthSuccessMessage = {
  type: 'viventium_connected_account_oauth_success';
  provider?: ProviderSlug;
};

type ConnectedAccountStartResponse = {
  authUrl?: string;
  flowMode?: 'popup_callback' | 'manual_code';
};

type ManualFlowState = {
  callbackInput: string;
  isSubmitting: boolean;
  state?: string;
};

const KEY_POLL_INTERVAL_MS = 1200;
const KEY_POLL_TIMEOUT_MS = 90_000;

function isProviderSlug(value: unknown): value is ProviderSlug {
  return value === 'openai' || value === 'anthropic';
}

function getEndpointForProviderSlug(provider: ProviderSlug): EModelEndpoint {
  return provider === 'openai' ? EModelEndpoint.openAI : EModelEndpoint.anthropic;
}

function getStateFromAuthUrl(authUrl: string): string | undefined {
  try {
    const parsed = new URL(authUrl);
    return parsed.searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
}

function getAllowedPostMessageOrigins(): Set<string> {
  const allowed = new Set<string>([window.location.origin]);
  try {
    allowed.add(new URL(apiBaseUrl(), window.location.origin).origin);
  } catch {
    // Ignore malformed configured API base URLs.
  }
  return allowed;
}

function ConnectedAccounts() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [keyDialogProvider, setKeyDialogProvider] = useState<ProviderDefinition | null>(null);
  const [manualFlows, setManualFlows] = useState<Partial<Record<ProviderSlug, ManualFlowState>>>(
    {},
  );
  const popupMonitorsRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const popupWindowsRef = useRef<Partial<Record<ProviderSlug, Window>>>({});
  const keyPollersRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const keyPollInFlightRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const flowAttemptsRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const connectedAccountsEnabled =
    (startupConfig as { viventiumConnectedAccountsEnabled?: boolean } | undefined)
      ?.viventiumConnectedAccountsEnabled === true;
  const experimentalDirectSubscriptionAuth =
    startupConfig?.viventiumExperimentalDirectSubscriptionAuth === true;
  const allowedPostMessageOrigins = useMemo(() => getAllowedPostMessageOrigins(), []);

  const openAIKeyQuery = useUserKeyQuery(EModelEndpoint.openAI, { refetchOnMount: 'always' });
  const anthropicKeyQuery = useUserKeyQuery(EModelEndpoint.anthropic, { refetchOnMount: 'always' });
  const groqKeyQuery = useUserKeyQuery('groq', { refetchOnMount: 'always' });
  const xAIKeyQuery = useUserKeyQuery('xai', { refetchOnMount: 'always' });
  const revokeOpenAIKeyMutation = useRevokeUserKeyMutation(EModelEndpoint.openAI);
  const revokeAnthropicKeyMutation = useRevokeUserKeyMutation(EModelEndpoint.anthropic);
  const revokeGroqKeyMutation = useRevokeUserKeyMutation('groq');
  const revokeXAIKeyMutation = useRevokeUserKeyMutation('xai');

  const openAIPlatformFallbackAvailable = useMemo(() => {
    const openAIConfig = endpointsConfig?.[EModelEndpoint.openAI];
    const azureOpenAIConfig = endpointsConfig?.[EModelEndpoint.azureOpenAI];
    return Boolean(
      (openAIConfig && !openAIConfig.userProvide) ||
      (azureOpenAIConfig && !azureOpenAIConfig.userProvide),
    );
  }, [endpointsConfig]);

  const anthropicPlatformFallbackAvailable = useMemo(() => {
    const anthropicConfig = endpointsConfig?.[EModelEndpoint.anthropic];
    return Boolean(anthropicConfig && !anthropicConfig.userProvide);
  }, [endpointsConfig]);

  const providers: ProviderDefinition[] = useMemo(
    () => [
      {
        endpoint: EModelEndpoint.openAI,
        queryKey: EModelEndpoint.openAI,
        labelKey: 'com_ui_openai',
        platformFallbackAvailable: openAIPlatformFallbackAvailable,
        oauth: true,
        slug: 'openai',
      },
      {
        endpoint: EModelEndpoint.anthropic,
        queryKey: EModelEndpoint.anthropic,
        labelKey: 'com_ui_anthropic',
        platformFallbackAvailable: anthropicPlatformFallbackAvailable,
        oauth: true,
        slug: 'anthropic',
      },
      {
        endpoint: 'groq',
        endpointType: EModelEndpoint.custom,
        queryKey: 'groq',
        labelKey: 'com_ui_groq',
        platformFallbackAvailable: false,
        oauth: false,
        slug: 'groq',
      },
      {
        endpoint: 'xai',
        endpointType: EModelEndpoint.custom,
        queryKey: 'xai',
        labelKey: 'com_ui_xai',
        platformFallbackAvailable: false,
        oauth: false,
        slug: 'xai',
      },
    ],
    [anthropicPlatformFallbackAvailable, openAIPlatformFallbackAvailable],
  );

  const getKeyQuery = useCallback(
    (endpoint: EModelEndpoint | string) => {
      if (endpoint === EModelEndpoint.openAI) {
        return openAIKeyQuery;
      }
      if (endpoint === EModelEndpoint.anthropic) {
        return anthropicKeyQuery;
      }
      return endpoint === 'groq' ? groqKeyQuery : xAIKeyQuery;
    },
    [anthropicKeyQuery, groqKeyQuery, openAIKeyQuery, xAIKeyQuery],
  );

  const getRevokeKeyMutation = useCallback(
    (endpoint: EModelEndpoint | string) => {
      if (endpoint === EModelEndpoint.openAI) {
        return revokeOpenAIKeyMutation;
      }
      if (endpoint === EModelEndpoint.anthropic) {
        return revokeAnthropicKeyMutation;
      }
      return endpoint === 'groq' ? revokeGroqKeyMutation : revokeXAIKeyMutation;
    },
    [
      revokeAnthropicKeyMutation,
      revokeGroqKeyMutation,
      revokeOpenAIKeyMutation,
      revokeXAIKeyMutation,
    ],
  );

  const providersBySlug = useMemo(
    () =>
      providers.reduce(
        (acc, provider) => {
          if (provider.oauth) {
            acc[provider.slug] = provider;
          }
          return acc;
        },
        {} as Record<ProviderSlug, ProviderDefinition>,
      ),
    [providers],
  );

  const clearPopupMonitor = useCallback((provider: ProviderSlug) => {
    const monitorId = popupMonitorsRef.current[provider];
    if (monitorId != null) {
      window.clearInterval(monitorId);
      delete popupMonitorsRef.current[provider];
    }
  }, []);

  const clearKeyPoller = useCallback((provider: ProviderSlug) => {
    const pollerId = keyPollersRef.current[provider];
    if (pollerId != null) {
      window.clearInterval(pollerId);
      delete keyPollersRef.current[provider];
    }
    delete keyPollInFlightRef.current[provider];
  }, []);

  const clearPopupWindow = useCallback((provider: ProviderSlug) => {
    const popup = popupWindowsRef.current[provider];
    if (popup && !popup.closed) {
      popup.close();
    }
    delete popupWindowsRef.current[provider];
  }, []);

  const beginFlowAttempt = useCallback((provider: ProviderSlug) => {
    const attempt = (flowAttemptsRef.current[provider] ?? 0) + 1;
    flowAttemptsRef.current[provider] = attempt;
    return attempt;
  }, []);

  const isCurrentFlowAttempt = useCallback(
    (provider: ProviderSlug, attempt: number) => flowAttemptsRef.current[provider] === attempt,
    [],
  );

  const invalidateFlowAttempt = useCallback((provider: ProviderSlug) => {
    flowAttemptsRef.current[provider] = (flowAttemptsRef.current[provider] ?? 0) + 1;
  }, []);

  const upsertManualFlow = useCallback((provider: ProviderSlug, state?: string) => {
    setManualFlows((current) => ({
      ...current,
      [provider]: {
        callbackInput: current[provider]?.callbackInput ?? '',
        isSubmitting: false,
        state: state ?? current[provider]?.state,
      },
    }));
  }, []);

  const clearManualFlow = useCallback((provider: ProviderSlug) => {
    setManualFlows((current) => {
      if (!current[provider]) {
        return current;
      }
      const next = { ...current };
      delete next[provider];
      return next;
    });
  }, []);

  const setManualFlowInput = useCallback((provider: ProviderSlug, callbackInput: string) => {
    setManualFlows((current) => {
      const existing = current[provider];
      if (!existing) {
        return current;
      }
      return {
        ...current,
        [provider]: {
          ...existing,
          callbackInput,
        },
      };
    });
  }, []);

  const setManualFlowSubmitting = useCallback((provider: ProviderSlug, isSubmitting: boolean) => {
    setManualFlows((current) => {
      const existing = current[provider];
      if (!existing) {
        return current;
      }
      return {
        ...current,
        [provider]: {
          ...existing,
          isSubmitting,
        },
      };
    });
  }, []);

  const showProviderConnectedToast = useCallback(
    (provider: ProviderDefinition) => {
      showToast({
        message: localize('com_ui_provider_connected', {
          provider: localize(provider.labelKey),
        }),
        status: NotificationSeverity.SUCCESS,
      });
    },
    [localize, showToast],
  );

  const pollForConnectedKey = useCallback(
    (provider: ProviderDefinition, attempt: number) => {
      clearKeyPoller(provider.slug);
      const startedAt = Date.now();
      keyPollersRef.current[provider.slug] = window.setInterval(() => {
        if (!isCurrentFlowAttempt(provider.slug, attempt)) {
          return;
        }
        if (keyPollInFlightRef.current[provider.slug] === attempt) {
          return;
        }

        keyPollInFlightRef.current[provider.slug] = attempt;
        void getKeyQuery(provider.queryKey)
          .refetch()
          .then((result) => {
            if (!isCurrentFlowAttempt(provider.slug, attempt)) {
              return;
            }
            const isConnected = Boolean(result.data?.expiresAt);
            if (isConnected) {
              invalidateFlowAttempt(provider.slug);
              clearPopupMonitor(provider.slug);
              clearKeyPoller(provider.slug);
              clearPopupWindow(provider.slug);
              clearManualFlow(provider.slug);
              setConnectingProvider((current) => (current === provider.endpoint ? null : current));
              showProviderConnectedToast(provider);
              return;
            }

            if (Date.now() - startedAt > KEY_POLL_TIMEOUT_MS) {
              clearKeyPoller(provider.slug);
              setConnectingProvider((current) => (current === provider.endpoint ? null : current));
            }
          })
          .finally(() => {
            if (keyPollInFlightRef.current[provider.slug] === attempt) {
              delete keyPollInFlightRef.current[provider.slug];
            }
          });
      }, KEY_POLL_INTERVAL_MS);
    },
    [
      clearKeyPoller,
      clearManualFlow,
      clearPopupMonitor,
      clearPopupWindow,
      getKeyQuery,
      invalidateFlowAttempt,
      isCurrentFlowAttempt,
      showProviderConnectedToast,
    ],
  );

  const beginManualFlow = useCallback(
    (provider: ProviderSlug, state?: string) => {
      upsertManualFlow(provider, state);
      setConnectingProvider((current) =>
        current === getEndpointForProviderSlug(provider) ? null : current,
      );
    },
    [upsertManualFlow],
  );

  useEffect(() => {
    const messageHandler = (event: MessageEvent<OAuthSuccessMessage>) => {
      if (!experimentalDirectSubscriptionAuth) {
        return;
      }
      if (!allowedPostMessageOrigins.has(event.origin)) {
        return;
      }

      if (event.data?.type !== 'viventium_connected_account_oauth_success') {
        return;
      }

      const providerSlug = event.data.provider;
      if (!isProviderSlug(providerSlug)) {
        return;
      }

      const provider = providersBySlug[providerSlug];
      if (!provider) {
        return;
      }

      const hasActiveFlow =
        connectingProvider === provider.endpoint ||
        popupMonitorsRef.current[provider.slug] != null ||
        keyPollersRef.current[provider.slug] != null ||
        manualFlows[provider.slug] != null;

      if (!hasActiveFlow) {
        return;
      }

      invalidateFlowAttempt(provider.slug);
      clearPopupMonitor(provider.slug);
      clearKeyPoller(provider.slug);
      clearPopupWindow(provider.slug);
      clearManualFlow(provider.slug);
      setConnectingProvider((current) => (current === provider.endpoint ? null : current));
      void getKeyQuery(provider.queryKey).refetch();
      showProviderConnectedToast(provider);
    };

    window.addEventListener('message', messageHandler);
    return () => window.removeEventListener('message', messageHandler);
  }, [
    allowedPostMessageOrigins,
    clearKeyPoller,
    clearManualFlow,
    clearPopupMonitor,
    clearPopupWindow,
    connectingProvider,
    experimentalDirectSubscriptionAuth,
    getKeyQuery,
    invalidateFlowAttempt,
    manualFlows,
    providersBySlug,
    showProviderConnectedToast,
  ]);

  useEffect(() => {
    if (!connectedAccountsEnabled || !experimentalDirectSubscriptionAuth) {
      return;
    }

    const hydrateManualFlow = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const parsed = payload as Partial<ConnectedAccountsManualFlowDetail>;
      if (!isProviderSlug(parsed.provider)) {
        return;
      }
      beginManualFlow(parsed.provider, parsed.state);
    };

    const manualFlowHandler = (event: Event) => {
      hydrateManualFlow((event as CustomEvent<ConnectedAccountsManualFlowDetail>).detail);
    };

    const storedManualFlow = window.sessionStorage.getItem(
      CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY,
    );
    if (storedManualFlow) {
      try {
        hydrateManualFlow(JSON.parse(storedManualFlow));
      } catch {
        // Ignore parse failures.
      } finally {
        window.sessionStorage.removeItem(CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY);
      }
    }

    window.addEventListener(
      CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT,
      manualFlowHandler as EventListener,
    );
    return () =>
      window.removeEventListener(
        CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT,
        manualFlowHandler as EventListener,
      );
  }, [beginManualFlow, connectedAccountsEnabled, experimentalDirectSubscriptionAuth]);

  useEffect(() => {
    return () => {
      invalidateFlowAttempt('openai');
      invalidateFlowAttempt('anthropic');
      clearPopupMonitor('openai');
      clearPopupMonitor('anthropic');
      clearKeyPoller('openai');
      clearKeyPoller('anthropic');
      clearPopupWindow('openai');
      clearPopupWindow('anthropic');
    };
  }, [clearKeyPoller, clearPopupMonitor, clearPopupWindow, invalidateFlowAttempt]);

  const getSourceLine = (isConnected: boolean, platformFallbackAvailable: boolean) => {
    if (isConnected) {
      return localize('com_ui_connected_account_source_user');
    }
    if (platformFallbackAvailable) {
      return localize('com_ui_connected_account_source_platform');
    }
    return localize('com_ui_connected_account_source_none');
  };

  const connectProvider = async (provider: ProviderDefinition) => {
    if (!experimentalDirectSubscriptionAuth || !provider.oauth) {
      return;
    }
    const attempt = beginFlowAttempt(provider.slug);
    clearPopupMonitor(provider.slug);
    clearKeyPoller(provider.slug);
    clearPopupWindow(provider.slug);
    const popup = window.open('', '_blank', 'width=640,height=760');
    if (!popup) {
      showToast({
        message: localize('com_ui_provider_connect_error', {
          provider: localize(provider.labelKey),
        }),
        status: NotificationSeverity.ERROR,
      });
      return;
    }

    setConnectingProvider(provider.endpoint);
    popupWindowsRef.current[provider.slug] = popup;

    try {
      const startUrl = `${apiBaseUrl()}/api/connected-accounts/${provider.slug}/start`;
      const response = await request.get<ConnectedAccountStartResponse>(startUrl);
      const authUrl = response?.authUrl;
      const flowMode = response?.flowMode ?? 'popup_callback';

      if (!isCurrentFlowAttempt(provider.slug, attempt)) {
        popup.close();
        return;
      }

      if (!authUrl) {
        throw new Error('oauth_start_failed');
      }

      popup.location.href = authUrl;

      if (flowMode === 'manual_code') {
        beginManualFlow(provider.slug, getStateFromAuthUrl(authUrl));
        setConnectingProvider((current) => (current === provider.endpoint ? null : current));
        showToast({
          message: localize('com_ui_connected_account_manual_ready', {
            provider: localize(provider.labelKey),
          }),
          status: NotificationSeverity.INFO,
        });
        return;
      }

      clearPopupMonitor(provider.slug);
      pollForConnectedKey(provider, attempt);
      popupMonitorsRef.current[provider.slug] = window.setInterval(() => {
        if (!isCurrentFlowAttempt(provider.slug, attempt)) {
          clearPopupMonitor(provider.slug);
          return;
        }
        if (!popup.closed) {
          return;
        }

        clearPopupMonitor(provider.slug);
        delete popupWindowsRef.current[provider.slug];
        /* === VIVENTIUM START ===
         * Feature: Connected-account cancellation recovery.
         * Purpose: A closed OAuth popup must restore immediate retry without discarding bounded polling.
         */
        // The user may cancel the provider page without a callback. Restore
        // the Connect action immediately while the bounded key poll continues
        // in case authorization completed just before the popup closed.
        setConnectingProvider((current) => (current === provider.endpoint ? null : current));
        /* === VIVENTIUM END === */
      }, 800);
    } catch (_error) {
      if (!isCurrentFlowAttempt(provider.slug, attempt)) {
        if (!popup.closed) {
          popup.close();
        }
        return;
      }
      invalidateFlowAttempt(provider.slug);
      setConnectingProvider((current) => (current === provider.endpoint ? null : current));
      clearPopupMonitor(provider.slug);
      clearKeyPoller(provider.slug);
      clearPopupWindow(provider.slug);
      showToast({
        message: localize('com_ui_provider_connect_error', {
          provider: localize(provider.labelKey),
        }),
        status: NotificationSeverity.ERROR,
      });
    }
  };

  const submitManualFlow = async (provider: ProviderDefinition) => {
    const manualFlow = manualFlows[provider.slug];
    const callbackInput = manualFlow?.callbackInput.trim();
    if (!manualFlow || !callbackInput) {
      return;
    }

    setManualFlowSubmitting(provider.slug, true);
    setConnectingProvider(provider.endpoint);
    const attempt = flowAttemptsRef.current[provider.slug] ?? beginFlowAttempt(provider.slug);

    try {
      await request.post(`${apiBaseUrl()}/api/connected-accounts/${provider.slug}/complete`, {
        callbackInput,
        ...(manualFlow.state ? { state: manualFlow.state } : {}),
      });

      if (!isCurrentFlowAttempt(provider.slug, attempt)) {
        return;
      }

      invalidateFlowAttempt(provider.slug);
      clearPopupMonitor(provider.slug);
      clearKeyPoller(provider.slug);
      clearPopupWindow(provider.slug);
      clearManualFlow(provider.slug);
      await getKeyQuery(provider.queryKey).refetch();
      setConnectingProvider((current) => (current === provider.endpoint ? null : current));
      showProviderConnectedToast(provider);
    } catch (_error) {
      if (!isCurrentFlowAttempt(provider.slug, attempt)) {
        return;
      }
      setConnectingProvider((current) => (current === provider.endpoint ? null : current));
      setManualFlowSubmitting(provider.slug, false);
      showToast({
        message: localize('com_ui_provider_connect_error', {
          provider: localize(provider.labelKey),
        }),
        status: NotificationSeverity.ERROR,
      });
    }
  };

  const cancelManualFlow = (provider: ProviderDefinition) => {
    invalidateFlowAttempt(provider.slug);
    clearManualFlow(provider.slug);
    clearPopupMonitor(provider.slug);
    clearKeyPoller(provider.slug);
    clearPopupWindow(provider.slug);
    setConnectingProvider((current) => (current === provider.endpoint ? null : current));
  };

  const disconnectLocalCredential = (provider: ProviderDefinition) => {
    const mutation = getRevokeKeyMutation(provider.endpoint);
    mutation.mutate(
      {},
      {
        onSuccess: async () => {
          await getKeyQuery(provider.queryKey).refetch();
          const providerLabel = localize(provider.labelKey);
          showToast({
            message: localize('com_ui_provider_disconnected', { provider: providerLabel }),
            status: NotificationSeverity.SUCCESS,
          });
        },
        onError: () => {
          const providerLabel = localize(provider.labelKey);
          showToast({
            message: localize('com_ui_provider_disconnect_error', { provider: providerLabel }),
            status: NotificationSeverity.ERROR,
          });
        },
      },
    );
  };

  if (!connectedAccountsEnabled) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label id="connected-accounts-label">{localize('com_ui_connected_accounts')}</Label>
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_accounts_description')}
        </p>
      </div>
      {experimentalDirectSubscriptionAuth && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="text-sm font-medium">
            {localize('com_ui_connected_accounts_experimental')}
          </p>
          <p className="mt-1 text-xs">
            {localize('com_ui_connected_accounts_experimental_description')}
          </p>
        </div>
      )}
      <div className="space-y-2" aria-labelledby="connected-accounts-label">
        {providers.map((provider) => {
          const providerLabel = localize(provider.labelKey);
          const keyQuery = getKeyQuery(provider.queryKey);
          const revokeMutation = getRevokeKeyMutation(provider.endpoint);
          const isConnected = Boolean(keyQuery.data?.expiresAt);
          const manualFlow = provider.oauth ? manualFlows[provider.slug] : undefined;
          const isManualSubmitting = manualFlow?.isSubmitting === true;
          const isConnecting = connectingProvider === provider.endpoint || isManualSubmitting;
          const statusText = isConnected
            ? localize('com_ui_connected_accounts_local_credential_saved')
            : localize('com_ui_connected_accounts_no_local_credential');

          return (
            <section
              key={provider.endpoint}
              className="rounded-xl border border-border-light bg-surface-primary p-3"
              aria-label={`${providerLabel} account`}
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="font-medium">{providerLabel}</p>
                  <p
                    className={cn(
                      'text-xs',
                      isConnected ? 'text-amber-700 dark:text-amber-300' : 'text-text-secondary',
                    )}
                  >
                    {statusText}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {getSourceLine(isConnected, provider.platformFallbackAvailable)}
                  </p>
                </div>
                {keyQuery.isLoading && <Spinner className="icon-sm" />}
              </div>
              {manualFlow && (
                <div className="mb-3 space-y-2 rounded-lg border border-border-light bg-surface-secondary p-2">
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_connected_account_manual_instructions', {
                      provider: providerLabel,
                    })}
                  </p>
                  <textarea
                    rows={3}
                    value={manualFlow.callbackInput}
                    onChange={(event) => setManualFlowInput(provider.slug, event.target.value)}
                    placeholder={localize('com_ui_connected_account_manual_placeholder')}
                    className={cn(
                      'w-full resize-y rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary',
                      'placeholder:text-text-secondary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                    )}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => cancelManualFlow(provider)}
                      disabled={isManualSubmitting}
                    >
                      {localize('com_ui_cancel')}
                    </Button>
                    <Button
                      onClick={() => void submitManualFlow(provider)}
                      disabled={isManualSubmitting || manualFlow.callbackInput.trim().length === 0}
                    >
                      {isManualSubmitting ? (
                        <Spinner className="icon-sm" />
                      ) : (
                        localize('com_ui_submit')
                      )}
                    </Button>
                  </div>
                </div>
              )}
              {isConnected && (
                <p className="mb-3 text-xs text-text-secondary">
                  {localize('com_ui_connected_accounts_disconnect_local_only')}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                {isConnected && (
                  <Button
                    variant="outline"
                    onClick={() => disconnectLocalCredential(provider)}
                    disabled={revokeMutation.isLoading || isConnecting}
                  >
                    {revokeMutation.isLoading ? (
                      <Spinner className="icon-sm" />
                    ) : (
                      localize('com_ui_connected_accounts_disconnect')
                    )}
                  </Button>
                )}
                <Button variant="outline" onClick={() => setKeyDialogProvider(provider)}>
                  {localize('com_ui_connected_accounts_use_provider_api_key', {
                    provider: providerLabel,
                  })}
                </Button>
                {experimentalDirectSubscriptionAuth && provider.oauth && (
                  <Button onClick={() => connectProvider(provider)} disabled={isConnecting}>
                    {isConnecting ? (
                      <Spinner className="icon-sm" />
                    ) : (
                      localize('com_ui_connected_accounts_experimental')
                    )}
                  </Button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {keyDialogProvider && (
        <SetKeyDialog
          open={true}
          endpoint={keyDialogProvider.endpoint}
          endpointType={keyDialogProvider.endpointType}
          removalMode="disconnect"
          onOpenChange={(open) => {
            if (!open) {
              setKeyDialogProvider(null);
            }
          }}
        />
      )}
    </div>
  );
}

export default ConnectedAccounts;
