import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, apiBaseUrl, request } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { NotificationSeverity } from '~/common';
import {
  CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT,
  CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY,
  CONNECTED_ACCOUNTS_OPEN_EVENT,
  type ConnectedAccountsManualFlowDetail,
} from '~/common/connectedAccounts';
import useLocalize from '~/hooks/useLocalize';

type ProviderSlug = 'openai' | 'anthropic';

type OAuthSuccessMessage = {
  type: 'viventium_connected_account_oauth_success';
  provider?: ProviderSlug;
};

type ConnectedAccountStartResponse = {
  authUrl?: string;
  flowMode?: 'popup_callback' | 'manual_code';
};

type UseKeyDialogParams = {
  connectedAccountsEnabled?: boolean;
};

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

const getProviderFromEndpoint = (endpoint: EModelEndpoint): ProviderSlug | null => {
  if (endpoint === EModelEndpoint.openAI) {
    return 'openai';
  }
  if (endpoint === EModelEndpoint.anthropic) {
    return 'anthropic';
  }
  return null;
};

const getProviderEndpoint = (provider: ProviderSlug): EModelEndpoint => {
  return provider === 'openai' ? EModelEndpoint.openAI : EModelEndpoint.anthropic;
};

export const useKeyDialog = ({ connectedAccountsEnabled = false }: UseKeyDialogParams = {}) => {
  /* === VIVENTIUM START ===
   * Feature: Connected Accounts provider-auth flows from model selector.
   * Purpose: Open provider-specific sign-in flows without falling back to misleading API key prompts.
   * === VIVENTIUM END === */
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyDialogEndpoint, setKeyDialogEndpoint] = useState<EModelEndpoint | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<ProviderSlug | null>(null);
  const popupMonitorsRef = useRef<Partial<Record<ProviderSlug, number>>>({});
  const popupWindowsRef = useRef<Partial<Record<ProviderSlug, Window>>>({});
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const allowedPostMessageOrigins = useRef(getAllowedPostMessageOrigins());

  const clearPopupMonitor = useCallback((provider: ProviderSlug) => {
    const monitorId = popupMonitorsRef.current[provider];
    if (monitorId != null) {
      window.clearInterval(monitorId);
      delete popupMonitorsRef.current[provider];
    }
  }, []);

  const clearPopupWindow = useCallback((provider: ProviderSlug) => {
    const popup = popupWindowsRef.current[provider];
    if (popup && !popup.closed) {
      popup.close();
    }
    delete popupWindowsRef.current[provider];
  }, []);

  const invalidateProviderKey = useCallback(
    async (provider: ProviderSlug) => {
      await queryClient.invalidateQueries({
        queryKey: [QueryKeys.name, getProviderEndpoint(provider)],
      });
    },
    [queryClient],
  );

  useEffect(() => {
    const messageHandler = (event: MessageEvent<OAuthSuccessMessage>) => {
      if (!connectedAccountsEnabled) {
        return;
      }

      if (!allowedPostMessageOrigins.current.has(event.origin)) {
        return;
      }

      if (event.data?.type !== 'viventium_connected_account_oauth_success') {
        return;
      }

      const provider = event.data.provider;
      if (provider !== 'openai' && provider !== 'anthropic') {
        return;
      }
      const hasLocalPopupMonitor = popupMonitorsRef.current[provider] != null;
      if (!hasLocalPopupMonitor && connectingProvider !== provider) {
        return;
      }

      clearPopupMonitor(provider);
      const popup = popupWindowsRef.current[provider];
      if (popup && !popup.closed) {
        popup.close();
      }
      delete popupWindowsRef.current[provider];
      void invalidateProviderKey(provider);
      setConnectingProvider((current) => (current === provider ? null : current));

      const providerName =
        provider === 'openai' ? localize('com_ui_openai') : localize('com_ui_anthropic');
      showToast({
        message: localize('com_ui_provider_connected', { provider: providerName }),
        status: NotificationSeverity.SUCCESS,
      });
    };

    window.addEventListener('message', messageHandler);
    return () => window.removeEventListener('message', messageHandler);
  }, [
    clearPopupMonitor,
    connectedAccountsEnabled,
    connectingProvider,
    invalidateProviderKey,
    localize,
    showToast,
  ]);

  useEffect(() => {
    return () => {
      clearPopupMonitor('openai');
      clearPopupMonitor('anthropic');
      clearPopupWindow('openai');
      clearPopupWindow('anthropic');
    };
  }, [clearPopupMonitor, clearPopupWindow]);

  const connectProvider = useCallback(
    async (provider: ProviderSlug) => {
      if (!connectedAccountsEnabled) {
        return;
      }

      if (connectingProvider === provider) {
        return;
      }

      const popup = window.open('', '_blank', 'width=640,height=760');
      if (!popup) {
        const providerName =
          provider === 'openai' ? localize('com_ui_openai') : localize('com_ui_anthropic');
        showToast({
          message: localize('com_ui_provider_connect_error', { provider: providerName }),
          status: NotificationSeverity.ERROR,
        });
        return;
      }

      setConnectingProvider(provider);
      popupWindowsRef.current[provider] = popup;

      try {
        const startUrl = `${apiBaseUrl()}/api/connected-accounts/${provider}/start`;
        const response = await request.get<ConnectedAccountStartResponse>(startUrl);
        const authUrl = response?.authUrl;
        const flowMode = response?.flowMode ?? 'popup_callback';

        if (!authUrl) {
          throw new Error('oauth_start_failed');
        }

        popup.location.href = authUrl;

        if (flowMode === 'manual_code') {
          const providerName =
            provider === 'openai' ? localize('com_ui_openai') : localize('com_ui_anthropic');
          const detail: ConnectedAccountsManualFlowDetail = {
            provider,
            state: getStateFromAuthUrl(authUrl),
          };

          window.sessionStorage.setItem(
            CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY,
            JSON.stringify(detail),
          );
          window.dispatchEvent(
            new CustomEvent<ConnectedAccountsManualFlowDetail>(
              CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT,
              { detail },
            ),
          );
          window.dispatchEvent(new Event(CONNECTED_ACCOUNTS_OPEN_EVENT));

          clearPopupMonitor(provider);
          setConnectingProvider((current) => (current === provider ? null : current));
          showToast({
            message: localize('com_ui_connected_account_manual_open_settings', {
              provider: providerName,
            }),
            status: NotificationSeverity.INFO,
          });
          return;
        }

        clearPopupMonitor(provider);
        popupMonitorsRef.current[provider] = window.setInterval(() => {
          if (!popup.closed) {
            return;
          }

          clearPopupMonitor(provider);
          delete popupWindowsRef.current[provider];
          void invalidateProviderKey(provider);
          setConnectingProvider((current) => (current === provider ? null : current));
        }, 800);
      } catch (_error) {
        setConnectingProvider((current) => (current === provider ? null : current));
        clearPopupMonitor(provider);
        const activePopup = popupWindowsRef.current[provider];
        if (activePopup && !activePopup.closed) {
          activePopup.close();
        }
        delete popupWindowsRef.current[provider];
        const providerName =
          provider === 'openai' ? localize('com_ui_openai') : localize('com_ui_anthropic');
        showToast({
          message: localize('com_ui_provider_connect_error', { provider: providerName }),
          status: NotificationSeverity.ERROR,
        });
      }
    },
    [
      clearPopupMonitor,
      clearPopupWindow,
      connectedAccountsEnabled,
      connectingProvider,
      invalidateProviderKey,
      localize,
      showToast,
    ],
  );

  const handleOpenKeyDialog = useCallback(
    (ep: EModelEndpoint, e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const provider = getProviderFromEndpoint(ep);
      if (provider && connectedAccountsEnabled) {
        void connectProvider(provider);
        return;
      }

      setKeyDialogEndpoint(ep);
      setKeyDialogOpen(true);
    },
    [connectProvider, connectedAccountsEnabled],
  );

  const onOpenChange = (open: boolean) => {
    if (!open && keyDialogEndpoint) {
      const button = document.getElementById(`endpoint-${keyDialogEndpoint}-settings`);
      if (button) {
        setTimeout(() => {
          button.focus();
        }, 5);
      }
    }
    setKeyDialogOpen(open);
  };

  return {
    keyDialogOpen,
    keyDialogEndpoint,
    onOpenChange,
    handleOpenKeyDialog,
  };
};

export default useKeyDialog;
