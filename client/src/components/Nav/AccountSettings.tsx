import { useState, memo, useRef, useCallback, useEffect } from 'react';
import * as Select from '@ariakit/react/select';
import { FileText, FlaskConical, HeartPulse, LogOut, Plug2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SettingsTabValues, SystemRoles, apiBaseUrl, request } from 'librechat-data-provider';
import {
  LinkIcon,
  GearIcon,
  DropdownMenuSeparator,
  Avatar,
  Spinner,
  useToastContext,
} from '@librechat/client';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import {
  CONNECTED_ACCOUNTS_SETUP_PENDING_KEY,
  CONNECTED_ACCOUNTS_OPEN_EVENT,
  connectedAccountsSetupCleanUrl,
  isConnectedAccountsSetupDestination,
  shouldResumeConnectedAccountsSetup,
} from '~/common/connectedAccounts';
import Settings from './Settings';

type PromptWorkbenchStartResponse = {
  started?: boolean;
  status?: 'running' | 'stopped';
  url?: string;
};

/* === VIVENTIUM START ===
 * Feature: Keyboard-accessible account actions.
 * Purpose: Ariakit Select options need unique values for arrow-key virtual focus and activation.
 */
const ACCOUNT_ACTION_VALUES = {
  connectedAccounts: 'connected-accounts',
  feelings: 'feelings',
  files: 'files',
  help: 'help',
  promptWorkbench: 'prompt-workbench',
  settings: 'settings',
} as const;
/* === VIVENTIUM END === */

function AccountSettings() {
  const navigate = useNavigate();
  const location = useLocation();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { user, isAuthenticated, logout } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const connectedAccountsEnabled =
    (startupConfig as { viventiumConnectedAccountsEnabled?: boolean } | undefined)
      ?.viventiumConnectedAccountsEnabled === true;
  const installExperience = startupConfig?.viventiumInstallExperience;
  const promptWorkbenchLinkEnabled =
    (startupConfig as { viventiumPromptWorkbenchLinkEnabled?: boolean } | undefined)
      ?.viventiumPromptWorkbenchLinkEnabled === true && user?.role === SystemRoles.ADMIN;
  const feelingsAvailable = startupConfig?.viventiumFeelingsAvailable !== false;
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [isOpeningPromptWorkbench, setIsOpeningPromptWorkbench] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabValues>(
    SettingsTabValues.GENERAL,
  );
  const accountSettingsButtonRef = useRef<HTMLButtonElement>(null);

  /* === VIVENTIUM START ===
   * Feature: Connected Accounts shortcut entry.
   * Purpose: Open Settings directly on Account tab to reduce clicks and improve discovery.
   * === VIVENTIUM END === */
  const openSettings = useCallback((initialTab = SettingsTabValues.GENERAL) => {
    setSettingsInitialTab(initialTab);
    setShowSettings(true);
  }, []);

  const onSettingsOpenChange = useCallback((open: boolean) => {
    setShowSettings(open);
    if (!open) {
      window.sessionStorage.removeItem(CONNECTED_ACCOUNTS_SETUP_PENDING_KEY);
    }
  }, []);

  /* === VIVENTIUM START ===
   * Feature: Easy Install browser-first onboarding.
   * Purpose: Consume the registration handoff once, open the real account UI, and leave a clean URL.
   * === VIVENTIUM END === */
  useEffect(() => {
    const setupRequested = isConnectedAccountsSetupDestination(
      `${location.pathname}${location.search}`,
    );
    if (setupRequested) {
      /* Capture the route intent before startup config resolves. Chat-route initialization may
       * normalize `/c/new` and remove its query before the feature gate becomes available. */
      window.sessionStorage.setItem(CONNECTED_ACCOUNTS_SETUP_PENDING_KEY, 'true');
    }

    if (!connectedAccountsEnabled) {
      return;
    }

    const setupPending =
      window.sessionStorage.getItem(CONNECTED_ACCOUNTS_SETUP_PENDING_KEY) === 'true';
    if (!shouldResumeConnectedAccountsSetup(installExperience, location.search, setupPending)) {
      return;
    }

    openSettings(SettingsTabValues.ACCOUNT);
    /* === VIVENTIUM START ===
     * Feature: Deterministic Easy Install account handoff.
     * Purpose: URL cleanup must not remount AccountSettings and discard its newly opened dialog state.
     */
    if (setupRequested) {
      window.history.replaceState(
        window.history.state,
        '',
        connectedAccountsSetupCleanUrl(location),
      );
    }
    /* === VIVENTIUM END === */
  }, [
    connectedAccountsEnabled,
    installExperience,
    location.hash,
    location.pathname,
    location.search,
    openSettings,
  ]);

  /* === VIVENTIUM START ===
   * Feature: Prompt Workbench account-menu entry.
   * Purpose: Open the managed local Prompt Workbench directly from the account dropdown.
   * === VIVENTIUM END === */
  const openPromptWorkbench = useCallback(async () => {
    if (isOpeningPromptWorkbench) {
      return;
    }

    setIsOpeningPromptWorkbench(true);
    try {
      const response = await request.post<PromptWorkbenchStartResponse>(
        `${apiBaseUrl()}/api/viventium/prompt-workbench/start`,
        {},
      );
      if (!response?.url) {
        throw new Error('missing_prompt_workbench_url');
      }
      window.open(response.url, '_blank', 'noopener,noreferrer');
    } catch (_error) {
      showToast({
        message: localize('com_ui_prompt_workbench_open_error'),
        status: NotificationSeverity.ERROR,
      });
    } finally {
      setIsOpeningPromptWorkbench(false);
    }
  }, [isOpeningPromptWorkbench, localize, showToast]);

  useEffect(() => {
    if (!connectedAccountsEnabled) {
      return;
    }

    /* === VIVENTIUM START ===
     * Feature: Connected Accounts cross-surface navigation.
     * Purpose: Let model-selector connect actions jump directly to Settings > Account.
     * === VIVENTIUM END === */
    const openConnectedAccounts = () => {
      openSettings(SettingsTabValues.ACCOUNT);
    };

    window.addEventListener(CONNECTED_ACCOUNTS_OPEN_EVENT, openConnectedAccounts);
    return () => window.removeEventListener(CONNECTED_ACCOUNTS_OPEN_EVENT, openConnectedAccounts);
  }, [connectedAccountsEnabled, openSettings]);

  return (
    <Select.SelectProvider>
      <Select.Select
        ref={accountSettingsButtonRef}
        aria-label={localize('com_nav_account_settings')}
        data-testid="nav-user"
        className="mt-text-sm flex h-auto w-full items-center gap-2 rounded-xl p-2 text-sm transition-all duration-200 ease-in-out hover:bg-surface-active-alt aria-[expanded=true]:bg-surface-active-alt"
      >
        <div className="-ml-0.9 -mt-0.8 h-8 w-8 flex-shrink-0">
          <div className="relative flex">
            <Avatar user={user} size={32} />
          </div>
        </div>
        <div
          className="mt-2 grow overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-primary"
          style={{ marginTop: '0', marginLeft: '0' }}
        >
          {user?.name ?? user?.username ?? localize('com_nav_user')}
        </div>
      </Select.Select>
      <Select.SelectPopover
        className="account-settings-popover popover-ui z-[125] w-[305px] rounded-lg md:w-[244px]"
        style={{
          transformOrigin: 'bottom',
          translate: '0 -4px',
        }}
      >
        <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
          {user?.email ?? localize('com_nav_user')}
        </div>
        <DropdownMenuSeparator />
        {startupConfig?.balance?.enabled === true && balanceQuery.data != null && (
          <>
            <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
              {localize('com_nav_balance')}:{' '}
              {new Intl.NumberFormat().format(Math.round(balanceQuery.data.tokenCredits))}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <Select.SelectItem
          value={ACCOUNT_ACTION_VALUES.files}
          onClick={() => setShowFiles(true)}
          className="select-item text-sm"
        >
          <FileText className="icon-md" aria-hidden="true" />
          {localize('com_nav_my_files')}
        </Select.SelectItem>
        {startupConfig?.helpAndFaqURL !== '/' && (
          <Select.SelectItem
            value={ACCOUNT_ACTION_VALUES.help}
            onClick={() => window.open(startupConfig?.helpAndFaqURL, '_blank')}
            className="select-item text-sm"
          >
            <LinkIcon aria-hidden="true" />
            {localize('com_nav_help_faq')}
          </Select.SelectItem>
        )}
        {connectedAccountsEnabled && (
          <Select.SelectItem
            value={ACCOUNT_ACTION_VALUES.connectedAccounts}
            onClick={() => openSettings(SettingsTabValues.ACCOUNT)}
            className="select-item text-sm"
          >
            <Plug2 className="icon-md" aria-hidden="true" />
            {localize('com_nav_connected_accounts')}
          </Select.SelectItem>
        )}
        {feelingsAvailable && (
          <Select.SelectItem
            value={ACCOUNT_ACTION_VALUES.feelings}
            onClick={() => navigate('/feelings')}
            className="select-item text-sm"
          >
            <HeartPulse className="icon-md" aria-hidden="true" />
            {localize('com_nav_feelings')}
          </Select.SelectItem>
        )}
        {promptWorkbenchLinkEnabled && (
          <Select.SelectItem
            value={ACCOUNT_ACTION_VALUES.promptWorkbench}
            onClick={() => void openPromptWorkbench()}
            className="select-item text-sm"
            aria-disabled={isOpeningPromptWorkbench}
            disabled={isOpeningPromptWorkbench}
          >
            {isOpeningPromptWorkbench ? (
              <Spinner className="icon-md" />
            ) : (
              <FlaskConical className="icon-md" aria-hidden="true" />
            )}
            {localize('com_ui_prompt_workbench')}
          </Select.SelectItem>
        )}
        <Select.SelectItem
          value={ACCOUNT_ACTION_VALUES.settings}
          onClick={() => openSettings(SettingsTabValues.GENERAL)}
          className="select-item text-sm"
        >
          <GearIcon className="icon-md" aria-hidden="true" />
          {localize('com_nav_settings')}
        </Select.SelectItem>
        <DropdownMenuSeparator />
        <Select.SelectItem
          aria-selected={true}
          onClick={() => logout()}
          value="logout"
          className="select-item text-sm"
        >
          <LogOut className="icon-md" aria-hidden="true" />
          {localize('com_nav_log_out')}
        </Select.SelectItem>
      </Select.SelectPopover>
      {showFiles && (
        <MyFilesModal
          open={showFiles}
          onOpenChange={setShowFiles}
          triggerRef={accountSettingsButtonRef}
        />
      )}
      {showSettings && (
        <Settings
          open={showSettings}
          onOpenChange={onSettingsOpenChange}
          initialTab={settingsInitialTab}
        />
      )}
    </Select.SelectProvider>
  );
}

export default memo(AccountSettings);
