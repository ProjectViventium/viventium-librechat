/* === VIVENTIUM START ===
 * Feature: Connected Accounts provider-auth flows.
 * Purpose: Let users connect OpenAI/Anthropic through account login without API key dialogs.
 * === VIVENTIUM END === */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EModelEndpoint, apiBaseUrl, request } from 'librechat-data-provider';
import { useRevokeUserKeyMutation, useUserKeyQuery } from 'librechat-data-provider/react-query';
import { Button, Label, Spinner, useToastContext } from '@librechat/client';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
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

type ProviderDefinition = {
  endpoint: EModelEndpoint;
  labelKey: TranslationKeys;
  connectLabelKey: TranslationKeys;
  platformFallbackAvailable: boolean;
  queryKey: EModelEndpoint;
  slug: ProviderSlug;
};

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
  const [connectingProvider, setConnectingProvider] = useState<EModelEndpoint | null>(null);
  const [manualFlows, setManualFlows] = useState<Partial<Record<ProviderSlug, ManualFlowState>>>(
    {},
  );
  const popupMonitorsRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const popupWindowsRef = useRef<Partial<Record<ProviderSlug, Window>>>({});
  const keyPollersRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const keyPollInFlightRef = useRef<Partial<Record<ProviderSlug, boolean>>>({});
  const connectedAccountsEnabled =
    (startupConfig as { viventiumConnectedAccountsEnabled?: boolean } | undefined)
      ?.viventiumConnectedAccountsEnabled === true;
  const allowedPostMessageOrigins = useMemo(() => getAllowedPostMessageOrigins(), []);

  const openAIKeyQuery = useUserKeyQuery(EModelEndpoint.openAI, { refetchOnMount: 'always' });
  const anthropicKeyQuery = useUserKeyQuery(EModelEndpoint.anthropic, { refetchOnMount: 'always' });
  const revokeOpenAIKeyMutation = useRevokeUserKeyMutation(EModelEndpoint.openAI);
  const revokeAnthropicKeyMutation = useRevokeUserKeyMutation(EModelEndpoint.anthropic);

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
        connectLabelKey: 'com_ui_connect_openai_account',
        platformFallbackAvailable: openAIPlatformFallbackAvailable,
        slug: 'openai',
      },
      {
        endpoint: EModelEndpoint.anthropic,
        queryKey: EModelEndpoint.anthropic,
        labelKey: 'com_ui_anthropic',
        connectLabelKey: 'com_ui_connect_anthropic_account',
        platformFallbackAvailable: anthropicPlatformFallbackAvailable,
        slug: 'anthropic',
      },
    ],
    [anthropicPlatformFallbackAvailable, openAIPlatformFallbackAvailable],
  );

  const getKeyQuery = useCallback(
    (endpoint: EModelEndpoint) =>
      endpoint === EModelEndpoint.openAI ? openAIKeyQuery : anthropicKeyQuery,
    [anthropicKeyQuery, openAIKeyQuery],
  );

  const getRevokeKeyMutation = useCallback(
    (endpoint: EModelEndpoint) =>
      endpoint === EModelEndpoint.openAI ? revokeOpenAIKeyMutation : revokeAnthropicKeyMutation,
    [revokeAnthropicKeyMutation, revokeOpenAIKeyMutation],
  );

  const providersBySlug = useMemo(
    () =>
      providers.reduce(
        (acc, provider) => {
          acc[provider.slug] = provider;
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
    (provider: ProviderDefinition) => {
      clearKeyPoller(provider.slug);
      const startedAt = Date.now();
      keyPollersRef.current[provider.slug] = window.setInterval(() => {
        if (keyPollInFlightRef.current[provider.slug]) {
          return;
        }

        keyPollInFlightRef.current[provider.slug] = true;
        void getKeyQuery(provider.queryKey)
          .refetch()
          .then((result) => {
            const isConnected = Boolean(result.data?.expiresAt);
            if (isConnected) {
              clearPopupMonitor(provider.slug);
              clearKeyPoller(provider.slug);
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
            keyPollInFlightRef.current[provider.slug] = false;
          });
      }, KEY_POLL_INTERVAL_MS);
    },
    [clearKeyPoller, clearManualFlow, clearPopupMonitor, getKeyQuery, showProviderConnectedToast],
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

      clearPopupMonitor(provider.slug);
      clearKeyPoller(provider.slug);
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
    connectingProvider,
    getKeyQuery,
    manualFlows,
    providersBySlug,
    showProviderConnectedToast,
  ]);

  useEffect(() => {
    if (!connectedAccountsEnabled) {
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
  }, [beginManualFlow, connectedAccountsEnabled]);

  useEffect(() => {
    return () => {
      clearPopupMonitor('openai');
      clearPopupMonitor('anthropic');
      clearKeyPoller('openai');
      clearKeyPoller('anthropic');
      clearPopupWindow('openai');
      clearPopupWindow('anthropic');
    };
  }, [clearKeyPoller, clearPopupMonitor, clearPopupWindow]);

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
      pollForConnectedKey(provider);
      popupMonitorsRef.current[provider.slug] = window.setInterval(() => {
        if (!popup.closed) {
          return;
        }

        clearPopupMonitor(provider.slug);
        delete popupWindowsRef.current[provider.slug];
      }, 800);
    } catch (_error) {
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

    try {
      await request.post(`${apiBaseUrl()}/api/connected-accounts/${provider.slug}/complete`, {
        callbackInput,
        ...(manualFlow.state ? { state: manualFlow.state } : {}),
      });

      clearPopupMonitor(provider.slug);
      clearKeyPoller(provider.slug);
      clearPopupWindow(provider.slug);
      clearManualFlow(provider.slug);
      await getKeyQuery(provider.queryKey).refetch();
      setConnectingProvider((current) => (current === provider.endpoint ? null : current));
      showProviderConnectedToast(provider);
    } catch (_error) {
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
    clearManualFlow(provider.slug);
    clearPopupMonitor(provider.slug);
    clearKeyPoller(provider.slug);
    clearPopupWindow(provider.slug);
    setConnectingProvider((current) => (current === provider.endpoint ? null : current));
  };

  const revokeConnection = (provider: ProviderDefinition) => {
    const mutation = getRevokeKeyMutation(provider.endpoint);
    mutation.mutate(
      {},
      {
        onSuccess: () => {
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
      <div className="space-y-2" aria-labelledby="connected-accounts-label">
        {providers.map((provider) => {
          const providerLabel = localize(provider.labelKey);
          const keyQuery = getKeyQuery(provider.queryKey);
          const revokeMutation = getRevokeKeyMutation(provider.endpoint);
          const isConnected = Boolean(keyQuery.data?.expiresAt);
          const manualFlow = manualFlows[provider.slug];
          const isManualSubmitting = manualFlow?.isSubmitting === true;
          const isConnecting = connectingProvider === provider.endpoint || isManualSubmitting;
          const statusText = isConnected
            ? localize('com_nav_mcp_status_connected')
            : localize('com_nav_mcp_status_disconnected');
          let connectButtonLabel = localize(provider.connectLabelKey);
          if (isConnected) {
            connectButtonLabel = localize('com_ui_reconnect');
          }

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
                      isConnected ? 'text-green-600 dark:text-green-400' : 'text-text-secondary',
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
              <div className="flex items-center justify-end gap-2">
                {isConnected && (
                  <Button
                    variant="outline"
                    onClick={() => revokeConnection(provider)}
                    disabled={revokeMutation.isLoading || isConnecting}
                  >
                    {revokeMutation.isLoading ? (
                      <Spinner className="icon-sm" />
                    ) : (
                      localize('com_ui_revoke')
                    )}
                  </Button>
                )}
                <Button onClick={() => connectProvider(provider)} disabled={isConnecting}>
                  {isConnecting ? <Spinner className="icon-sm" /> : connectButtonLabel}
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default ConnectedAccounts;
