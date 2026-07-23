/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels API contract.
 * Purpose: Lock admin channel requests to the agreed routes without persisting or logging secrets.
 * === VIVENTIUM END ===
 */

import request from './request';
import {
  connectChannel,
  createChannelPairingCode,
  disconnectChannel,
  getConnectedChannelAvailability,
  getConnectedChannels,
  getSlackChannelManifest,
  testChannel,
} from './data-service';

jest.mock('./request', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockGet = request.get as jest.MockedFunction<typeof request.get>;
const mockPost = request.post as jest.MockedFunction<typeof request.post>;

describe('Connected Channels data service', () => {
  it('uses the admin list and server-owned Slack manifest routes', async () => {
    mockGet.mockResolvedValueOnce({ channels: [] });
    mockGet.mockResolvedValueOnce({ manifest: {} });

    await getConnectedChannels();
    await getSlackChannelManifest();

    expect(mockGet).toHaveBeenNthCalledWith(1, '/api/viventium/channels');
    expect(mockGet).toHaveBeenNthCalledWith(2, '/api/viventium/channels/slack/manifest');
  });

  it('loads secret-free channel availability for the signed-in user', async () => {
    mockGet.mockResolvedValueOnce({
      channels: [{ channel: 'telegram', available: true }],
    });

    await getConnectedChannelAvailability();

    expect(mockGet).toHaveBeenCalledWith('/api/viventium/channels/availability');
  });

  it('routes provider-specific connect, test, and disconnect actions', async () => {
    mockPost.mockResolvedValue({
      channel: { channel: 'telegram', state: 'connected' },
    });
    const input = {
      channel: 'telegram' as const,
      botToken: 'synthetic-test-token',
      dmPolicy: 'PAIRING' as const,
    };

    await connectChannel(input);
    await testChannel('telegram');
    await disconnectChannel('telegram');

    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/viventium/channels/telegram/connect', input);
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/viventium/channels/telegram/test');
    expect(mockPost).toHaveBeenNthCalledWith(3, '/api/viventium/channels/telegram/disconnect');
  });

  it('submits WhatsApp credentials without a client-supplied public URL', async () => {
    mockPost.mockResolvedValue({
      channel: { channel: 'whatsapp', state: 'connected' },
    });
    const input = {
      channel: 'whatsapp' as const,
      phoneNumberId: 'synthetic-phone-id',
      businessAccountId: 'synthetic-business-id',
      accessToken: 'synthetic-access-token',
      appSecret: 'synthetic-app-secret',
      verifyToken: 'synthetic-verify-token',
    };

    await connectChannel(input);

    expect(mockPost).toHaveBeenCalledWith('/api/viventium/channels/whatsapp/connect', input);
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('webhookUrl');
  });

  it('creates a one-use pairing code without putting it in a URL or request body', async () => {
    mockPost.mockResolvedValue({
      pairingCode: 'ABCD-EFGH',
      expiresAt: '2026-07-22T18:00:00.000Z',
    });

    await createChannelPairingCode('telegram');

    expect(mockPost).toHaveBeenCalledWith('/api/viventium/channels/telegram/pairing-code');
  });
});
