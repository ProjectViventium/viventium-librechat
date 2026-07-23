import React, { type PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import {
  useCreateChannelPairingCodeMutation,
  useSaveConnectedChannelMutation,
  useTestConnectedChannelMutation,
} from './queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      connectChannel: jest.fn(),
      createChannelPairingCode: jest.fn(),
      testChannel: jest.fn(),
    },
  };
});

const connectChannelMock = dataService.connectChannel as jest.MockedFunction<
  typeof dataService.connectChannel
>;
const createChannelPairingCodeMock = dataService.createChannelPairingCode as jest.MockedFunction<
  typeof dataService.createChannelPairingCode
>;
const testChannelMock = dataService.testChannel as jest.MockedFunction<
  typeof dataService.testChannel
>;

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('Connected Channels mutation privacy', () => {
  afterEach(() => jest.clearAllMocks());

  it('removes submitted provider secrets from the mutation cache after success', async () => {
    connectChannelMock.mockResolvedValue({
      channel: { channel: 'telegram', state: 'connected' },
    });
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useSaveConnectedChannelMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        channel: 'telegram',
        botToken: 'synthetic-secret-that-must-not-remain',
        dmPolicy: 'PAIRING',
      });
    });

    await waitFor(() =>
      expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(
        'synthetic-secret-that-must-not-remain',
      ),
    );
  });

  it('removes submitted provider secrets from the mutation cache after failure', async () => {
    connectChannelMock.mockRejectedValue(new Error('synthetic failure'));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useSaveConnectedChannelMutation(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          channel: 'slack',
          appToken: 'xapp-secret-that-must-not-remain',
          botToken: 'xoxb-secret-that-must-not-remain',
        }),
      ).rejects.toThrow('synthetic failure');
    });

    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(
      'secret-that-must-not-remain',
    );
  });

  it('does not retain a generated pairing code in the mutation cache', async () => {
    createChannelPairingCodeMock.mockResolvedValue({
      pairingCode: 'ONE-USE-CODE',
      expiresAt: '2026-07-22T18:00:00.000Z',
    });
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useCreateChannelPairingCodeMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('telegram');
    });

    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain('ONE-USE-CODE');
  });

  it('keeps a pending WhatsApp replacement visible in the channel cache', async () => {
    connectChannelMock.mockResolvedValue({
      channel: {
        channel: 'whatsapp',
        state: 'needs_vendor_step',
        issueCode: 'replacement_webhook_verification_required',
        callbackUrl: 'https://example.invalid/api/viventium/channels/whatsapp/pending',
      },
    });
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData([QueryKeys.connectedChannels], {
      channels: [{ channel: 'whatsapp', state: 'connected', displayName: 'Active number' }],
    });
    const { result } = renderHook(() => useSaveConnectedChannelMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        channel: 'whatsapp',
        phoneNumberId: 'pending-phone',
        businessAccountId: 'pending-business',
        accessToken: 'pending-access-secret',
        appSecret: 'pending-app-secret',
        verifyToken: 'pending-verify-secret',
      });
    });

    expect(queryClient.getQueryData([QueryKeys.connectedChannels])).toEqual({
      channels: [
        {
          channel: 'whatsapp',
          state: 'needs_vendor_step',
          issueCode: 'replacement_webhook_verification_required',
          callbackUrl: 'https://example.invalid/api/viventium/channels/whatsapp/pending',
        },
      ],
    });
  });

  it('keeps a pending WhatsApp replacement visible after Test Connection', async () => {
    testChannelMock.mockResolvedValue({
      ok: true,
      message: 'Active connection verified.',
      channel: {
        channel: 'whatsapp',
        state: 'needs_vendor_step',
        issueCode: 'replacement_webhook_verification_required',
        callbackUrl: 'https://example.invalid/api/viventium/channels/whatsapp/pending',
      },
    });
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData([QueryKeys.connectedChannels], {
      channels: [{ channel: 'whatsapp', state: 'connected', displayName: 'Active number' }],
    });
    const { result } = renderHook(() => useTestConnectedChannelMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('whatsapp');
    });

    expect(queryClient.getQueryData([QueryKeys.connectedChannels])).toEqual({
      channels: [
        {
          channel: 'whatsapp',
          state: 'needs_vendor_step',
          issueCode: 'replacement_webhook_verification_required',
          callbackUrl: 'https://example.invalid/api/viventium/channels/whatsapp/pending',
        },
      ],
    });
  });
});
