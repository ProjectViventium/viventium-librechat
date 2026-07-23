/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels data hooks.
 * Purpose: Keep global admin state and user-visible availability server-owned and current.
 * === VIVENTIUM END ===
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  ConnectedChannel,
  ConnectedChannelAvailabilityResponse,
  ConnectedChannelConnectRequest,
  ConnectedChannelResponse,
  ConnectedChannelsResponse,
  ConnectedChannelTestResponse,
  ChannelPairingCodeResponse,
  SlackManifestResponse,
} from 'librechat-data-provider';

const connectedChannelsKey = [QueryKeys.connectedChannels];

const removeSensitiveMutations = (
  queryClient: ReturnType<typeof useQueryClient>,
  mutationKey: MutationKeys,
) => {
  const mutationCache = queryClient.getMutationCache();
  mutationCache
    .findAll({ mutationKey: [mutationKey], exact: true })
    .forEach((mutation) => mutationCache.remove(mutation));
};

export const useConnectedChannelsQuery = () =>
  useQuery<ConnectedChannelsResponse>(
    connectedChannelsKey,
    () => dataService.getConnectedChannels(),
    {
      retry: false,
      refetchOnMount: true,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  );

export const useConnectedChannelAvailabilityQuery = () =>
  useQuery<ConnectedChannelAvailabilityResponse>(
    [QueryKeys.connectedChannelAvailability],
    () => dataService.getConnectedChannelAvailability(),
    {
      retry: false,
      refetchOnMount: true,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  );

export const useSlackManifestQuery = () =>
  useQuery<SlackManifestResponse>(
    [QueryKeys.slackChannelManifest],
    () => dataService.getSlackChannelManifest(),
    {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  );

const updateCachedChannel = (
  queryClient: ReturnType<typeof useQueryClient>,
  response: ConnectedChannelResponse,
) => {
  queryClient.setQueryData<ConnectedChannelsResponse>(connectedChannelsKey, (current) => {
    if (!current) {
      return { channels: [response.channel] };
    }
    let didReplace = false;
    const channels = current.channels.map((channel) => {
      if (channel.channel !== response.channel.channel) {
        return channel;
      }
      didReplace = true;
      return response.channel;
    });
    return {
      channels: didReplace ? channels : [...channels, response.channel],
    };
  });
};

export const useSaveConnectedChannelMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<ConnectedChannelResponse, Error, ConnectedChannelConnectRequest>(
    [MutationKeys.connectChannel],
    dataService.connectChannel,
    {
      cacheTime: 0,
      onSuccess: (response) => updateCachedChannel(queryClient, response),
      onError: () => queryClient.invalidateQueries(connectedChannelsKey),
      onSettled: () => removeSensitiveMutations(queryClient, MutationKeys.connectChannel),
    },
  );
};

export const useCreateChannelPairingCodeMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<ChannelPairingCodeResponse, Error, ConnectedChannel>(
    [MutationKeys.createChannelPairingCode],
    dataService.createChannelPairingCode,
    {
      cacheTime: 0,
      onSettled: () => removeSensitiveMutations(queryClient, MutationKeys.createChannelPairingCode),
    },
  );
};

export const useTestConnectedChannelMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<ConnectedChannelTestResponse, Error, ConnectedChannel>(
    [MutationKeys.testChannel],
    dataService.testChannel,
    {
      onSuccess: (response) => updateCachedChannel(queryClient, response),
      onError: () => queryClient.invalidateQueries(connectedChannelsKey),
    },
  );
};

export const useDisconnectConnectedChannelMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<ConnectedChannelResponse, Error, ConnectedChannel>(
    [MutationKeys.disconnectChannel],
    dataService.disconnectChannel,
    {
      onSuccess: (response) => updateCachedChannel(queryClient, response),
      onError: () => queryClient.invalidateQueries(connectedChannelsKey),
    },
  );
};
