import { useState, memo, useRef, useCallback, useEffect } from 'react';
import * as Select from '@ariakit/react/select';
import { FileText, LogOut, Plug2 } from 'lucide-react';
import { SettingsTabValues } from 'librechat-data-provider';
import { LinkIcon, GearIcon, DropdownMenuSeparator, Avatar } from '@librechat/client';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import { CONNECTED_ACCOUNTS_OPEN_EVENT } from '~/common/connectedAccounts';
import Settings from './Settings';

function AccountSettings() {
  const localize = useLocalize();
  const { user, isAuthenticated, logout } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const connectedAccountsEnabled =
    (startupConfig as { viventiumConnectedAccountsEnabled?: boolean } | undefined)
      ?.viventiumConnectedAccountsEnabled === true;
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
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
          value=""
          onClick={() => setShowFiles(true)}
          className="select-item text-sm"
        >
          <FileText className="icon-md" aria-hidden="true" />
          {localize('com_nav_my_files')}
        </Select.SelectItem>
        {startupConfig?.helpAndFaqURL !== '/' && (
          <Select.SelectItem
            value=""
            onClick={() => window.open(startupConfig?.helpAndFaqURL, '_blank')}
            className="select-item text-sm"
          >
            <LinkIcon aria-hidden="true" />
            {localize('com_nav_help_faq')}
          </Select.SelectItem>
        )}
        {connectedAccountsEnabled && (
          <Select.SelectItem
            value=""
            onClick={() => openSettings(SettingsTabValues.ACCOUNT)}
            className="select-item text-sm"
          >
            <Plug2 className="icon-md" aria-hidden="true" />
            {localize('com_nav_connected_accounts')}
          </Select.SelectItem>
        )}
        <Select.SelectItem
          value=""
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
          onOpenChange={setShowSettings}
          initialTab={settingsInitialTab}
        />
      )}
    </Select.SelectProvider>
  );
}

export default memo(AccountSettings);
