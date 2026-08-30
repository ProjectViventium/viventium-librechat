import React from 'react';
import DisplayUsernameMessages from './DisplayUsernameMessages';
import DeleteAccount from './DeleteAccount';
import Avatar from './Avatar';
import EnableTwoFactorItem from './TwoFactorAuthentication';
import BackupCodesItem from './BackupCodesItem';
import ConnectedAccounts from './ConnectedAccounts';
import WhoopConnection from './WhoopConnection';
import ParallelWork from './ParallelWork';
import { SystemRoles } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks';

function Account() {
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const whoopEnabled =
    startupConfig?.viventiumHealthWhoopEnabled === true && user?.role === SystemRoles.ADMIN;
  const parallelWorkAvailable =
    (startupConfig as { viventiumParallelWorkAvailable?: boolean } | undefined)
      ?.viventiumParallelWorkAvailable === true;

  return (
    <div className="flex flex-col gap-3 p-1 text-sm text-text-primary">
      {/* === VIVENTIUM START ===
       * Feature: Account-wide Parallel work.
       * Purpose: Keep the control dark until runtime support is explicitly available.
       * === VIVENTIUM END === */}
      <div className="pb-3">
        <ParallelWork featureAvailable={parallelWorkAvailable} />
      </div>
      {/* === VIVENTIUM START ===
       * Feature: Connected Accounts.
       * Purpose: Surface OpenAI/Anthropic account connection in Settings > Account for reliable discoverability.
       * === VIVENTIUM END === */}
      <div className="pb-3">
        <ConnectedAccounts />
      </div>
      {whoopEnabled && (
        <div className="pb-3">
          <WhoopConnection />
        </div>
      )}
      <div className="pb-3">
        <DisplayUsernameMessages />
      </div>
      <div className="pb-3">
        <Avatar />
      </div>
      {user?.provider === 'local' && (
        <>
          <div className="pb-3">
            <EnableTwoFactorItem />
          </div>
          {user?.twoFactorEnabled && (
            <div className="pb-3">
              <BackupCodesItem />
            </div>
          )}
        </>
      )}
      <div className="pb-3">
        <DeleteAccount />
      </div>
    </div>
  );
}

export default React.memo(Account);
