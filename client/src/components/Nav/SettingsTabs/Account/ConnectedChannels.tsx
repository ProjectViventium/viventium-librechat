/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels pairing and administration.
 * Purpose: Give every user self-service pairing while keeping global channel setup admin-only.
 * === VIVENTIUM END ===
 */

import { useMemo, useState } from 'react';
import { SystemRoles } from 'librechat-data-provider';
import type {
  ConnectedChannel,
  ConnectedChannelConnectRequest,
  ConnectedChannelSummary,
} from 'librechat-data-provider';
import { Button, Spinner, useToastContext } from '@librechat/client';
import ConnectedChannelCard from './ConnectedChannelCard';
import UserChannelPairing from './ConnectedChannels/UserChannelPairing';
import {
  useConnectedChannelsQuery,
  useDisconnectConnectedChannelMutation,
  useSaveConnectedChannelMutation,
  useTestConnectedChannelMutation,
} from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useAuthContext, useLocalize } from '~/hooks';

const CHANNELS: ConnectedChannel[] = ['telegram', 'slack', 'whatsapp'];

function ConnectedChannelsContent() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const channelsQuery = useConnectedChannelsQuery();
  const saveMutation = useSaveConnectedChannelMutation();
  const testMutation = useTestConnectedChannelMutation();
  const disconnectMutation = useDisconnectConnectedChannelMutation();
  const [setupChannel, setSetupChannel] = useState<ConnectedChannel | null>(null);
  const [disconnectChannel, setDisconnectChannel] = useState<ConnectedChannel | null>(null);

  const channels = useMemo(() => {
    const byChannel = new Map(
      (channelsQuery.data?.channels ?? []).map((summary) => [summary.channel, summary]),
    );
    return CHANNELS.map<ConnectedChannelSummary>(
      (channel) => byChannel.get(channel) ?? { channel, state: 'not_configured' },
    );
  }, [channelsQuery.data]);

  if (channelsQuery.isLoading) {
    return (
      <div
        role="status"
        aria-label={localize('com_ui_connected_channels_loading')}
        className="flex items-center gap-2 py-3 text-xs text-text-secondary"
      >
        <Spinner className="icon-sm" />
        <span>{localize('com_ui_connected_channels_loading')}</span>
      </div>
    );
  }

  if (channelsQuery.isError) {
    return (
      <div role="alert" className="space-y-2 rounded-lg border border-border-light p-3">
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_load_error')}
        </p>
        <Button type="button" variant="outline" onClick={() => void channelsQuery.refetch()}>
          {localize('com_ui_connected_channels_retry')}
        </Button>
      </div>
    );
  }

  const isBusy = saveMutation.isLoading || testMutation.isLoading || disconnectMutation.isLoading;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="font-medium text-text-primary">{localize('com_ui_connected_channels')}</h2>
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_description')}
        </p>
      </div>
      <div className="space-y-2">
        {channels.map((summary) => (
          <ConnectedChannelCard
            key={summary.channel}
            summary={summary}
            isBusy={isBusy}
            isSetupOpen={setupChannel === summary.channel}
            isConfirmingDisconnect={disconnectChannel === summary.channel}
            onOpenSetup={() => {
              setDisconnectChannel(null);
              setSetupChannel(summary.channel);
            }}
            onCancelSetup={() => setSetupChannel(null)}
            onSave={(input: ConnectedChannelConnectRequest) => {
              saveMutation.mutate(input, {
                onSuccess: () => {
                  setSetupChannel(null);
                  showToast({
                    status: NotificationSeverity.SUCCESS,
                    message: localize('com_ui_connected_channels_save_success'),
                  });
                },
                onError: () =>
                  showToast({
                    status: NotificationSeverity.ERROR,
                    message: localize('com_ui_connected_channels_save_error'),
                  }),
              });
            }}
            onTest={() =>
              testMutation.mutate(summary.channel, {
                onSuccess: (response) =>
                  showToast({
                    status: response.ok ? NotificationSeverity.SUCCESS : NotificationSeverity.ERROR,
                    message: localize(
                      response.ok
                        ? 'com_ui_connected_channels_test_success'
                        : 'com_ui_connected_channels_test_error',
                    ),
                  }),
                onError: () =>
                  showToast({
                    status: NotificationSeverity.ERROR,
                    message: localize('com_ui_connected_channels_test_error'),
                  }),
              })
            }
            onRequestDisconnect={() => {
              setSetupChannel(null);
              setDisconnectChannel(summary.channel);
            }}
            onCancelDisconnect={() => setDisconnectChannel(null)}
            onConfirmDisconnect={() =>
              disconnectMutation.mutate(summary.channel, {
                onSuccess: () => {
                  setDisconnectChannel(null);
                  showToast({
                    status: NotificationSeverity.SUCCESS,
                    message: localize('com_ui_connected_channels_disconnect_success'),
                  });
                },
                onError: () =>
                  showToast({
                    status: NotificationSeverity.ERROR,
                    message: localize('com_ui_connected_channels_disconnect_error'),
                  }),
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

export default function ConnectedChannels() {
  const { user } = useAuthContext();
  if (!user) {
    return null;
  }
  return (
    <div className="space-y-4">
      <UserChannelPairing />
      {user.role === SystemRoles.ADMIN && <ConnectedChannelsContent />}
    </div>
  );
}
