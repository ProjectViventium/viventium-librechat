/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels self-service pairing.
 * Purpose: Let every signed-in user connect their own messaging identity without exposing admin controls.
 * === VIVENTIUM END ===
 */

import type { ConnectedChannel } from 'librechat-data-provider';
import { Button, Spinner } from '@librechat/client';
import PairingCode from './PairingCode';
import { useConnectedChannelAvailabilityQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks';

const CHANNELS: ConnectedChannel[] = ['telegram', 'slack', 'whatsapp'];

const PROVIDER_KEYS: Record<ConnectedChannel, TranslationKeys> = {
  telegram: 'com_ui_connected_channels_telegram',
  slack: 'com_ui_connected_channels_slack',
  whatsapp: 'com_ui_connected_channels_whatsapp',
};

export default function UserChannelPairing() {
  const localize = useLocalize();
  const availabilityQuery = useConnectedChannelAvailabilityQuery();

  const availability = new Map(
    (availabilityQuery.data?.channels ?? []).map((entry) => [entry.channel, entry.available]),
  );

  return (
    <section
      className="space-y-3 rounded-xl border border-border-light bg-surface-primary p-3"
      aria-labelledby="viventium-user-channel-pairing-heading"
    >
      <div className="space-y-1">
        <h2 id="viventium-user-channel-pairing-heading" className="font-medium text-text-primary">
          {localize('com_ui_connected_channels_pairing_heading')}
        </h2>
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_pairing_description')}
        </p>
      </div>
      {availabilityQuery.isLoading && (
        <div
          role="status"
          aria-label={localize('com_ui_connected_channels_pairing_loading')}
          className="flex items-center gap-2 text-xs text-text-secondary"
        >
          <Spinner className="icon-sm" />
          <span>{localize('com_ui_connected_channels_pairing_loading')}</span>
        </div>
      )}
      {availabilityQuery.isError && (
        <div role="alert" className="space-y-2 text-xs text-text-secondary">
          <p>{localize('com_ui_connected_channels_pairing_load_error')}</p>
          <Button type="button" variant="outline" onClick={() => void availabilityQuery.refetch()}>
            {localize('com_ui_connected_channels_retry')}
          </Button>
        </div>
      )}
      {!availabilityQuery.isLoading && !availabilityQuery.isError && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2">
            {CHANNELS.map((channel) => {
              const providerLabel = localize(PROVIDER_KEYS[channel]);
              const isAvailable = availability.get(channel) === true;
              return (
                <div
                  key={channel}
                  role="group"
                  aria-label={localize('com_ui_connected_channels_pairing_group', {
                    provider: providerLabel,
                  })}
                  className="rounded-lg border border-border-light bg-surface-secondary p-3"
                >
                  <h3 className="text-sm font-medium text-text-primary">{providerLabel}</h3>
                  {isAvailable ? (
                    <PairingCode channel={channel} providerLabel={providerLabel} disabled={false} />
                  ) : (
                    <p className="mt-2 text-xs text-text-secondary">
                      {localize('com_ui_connected_channels_pairing_unavailable', {
                        provider: providerLabel,
                      })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            aria-busy={availabilityQuery.isFetching}
            disabled={availabilityQuery.isFetching}
            onClick={() => void availabilityQuery.refetch()}
          >
            {availabilityQuery.isFetching && <Spinner className="icon-sm mr-2" />}
            {localize('com_ui_connected_channels_pairing_refresh')}
          </Button>
        </>
      )}
    </section>
  );
}
