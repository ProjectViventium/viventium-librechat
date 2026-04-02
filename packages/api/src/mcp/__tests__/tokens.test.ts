import { Types } from 'mongoose';
import { decryptV2 } from '@librechat/data-schemas';
import type { TokenMethods, IToken } from '@librechat/data-schemas';
import { MCPTokenStorage } from '~/mcp/oauth/tokens';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  decryptV2: jest.fn(),
}));

const mockDecryptV2 = decryptV2 as jest.MockedFunction<typeof decryptV2>;

describe('MCPTokenStorage', () => {
  afterAll(() => {
    jest.clearAllMocks();
  });

  /* === VIVENTIUM START ===
   * Purpose: Ensure we can force-refresh MCP OAuth tokens after an auth error
   * even when our stored access-token expiry says it is still valid.
   * (Prevents repeated full OAuth re-auth flows.)
   */
  describe('getTokens', () => {
    const userId = '000000001111111122222222';
    const serverName = 'test-server';
    const identifier = `mcp:${serverName}`;

    let mockFindToken: jest.MockedFunction<TokenMethods['findToken']>;
    let mockCreateToken: jest.MockedFunction<TokenMethods['createToken']>;
    let mockUpdateToken: jest.MockedFunction<TokenMethods['updateToken']>;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFindToken = jest.fn();
      mockCreateToken = jest.fn().mockResolvedValue(undefined);
      mockUpdateToken = jest.fn().mockResolvedValue(undefined);
    });

    it('should force refresh tokens even when access token is not expired', async () => {
      const accessTokenData = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth',
        identifier,
        token: 'enc-access',
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60 * 60_000), // 1 hour from now
      } as unknown as IToken;

      const refreshTokenData = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth_refresh',
        identifier: `${identifier}:refresh`,
        token: 'enc-refresh',
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
      } as unknown as IToken;

      const clientInfoData = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'enc-client',
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
      } as unknown as IToken;

      mockFindToken.mockImplementation(async ({ type, identifier: id }) => {
        if (type === 'mcp_oauth' && id === identifier) {
          return accessTokenData;
        }
        if (type === 'mcp_oauth_refresh' && id === `${identifier}:refresh`) {
          return refreshTokenData;
        }
        if (type === 'mcp_oauth_client' && id === `${identifier}:client`) {
          return clientInfoData;
        }
        return null;
      });

      mockDecryptV2.mockImplementation(async (ciphertext) => {
        if (ciphertext === 'enc-refresh') {
          return 'refresh-token';
        }
        if (ciphertext === 'enc-client') {
          return JSON.stringify({ client_id: 'client-123', client_secret: 'secret-123' });
        }
        if (ciphertext === 'enc-access') {
          return 'access-token';
        }
        return '';
      });

      const refreshTokens = jest.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 60 * 60_000,
      });

      // Avoid exercising encryption logic inside storeTokens for this unit test.
      const storeTokensSpy = jest
        .spyOn(MCPTokenStorage, 'storeTokens')
        .mockResolvedValue(undefined);

      const result = await MCPTokenStorage.getTokens({
        userId,
        serverName,
        findToken: mockFindToken,
        createToken: mockCreateToken,
        updateToken: mockUpdateToken,
        refreshTokens,
        forceRefresh: true,
      });

      expect(refreshTokens).toHaveBeenCalledWith(
        'refresh-token',
        expect.objectContaining({
          userId,
          serverName,
          identifier,
          clientInfo: expect.objectContaining({
            client_id: 'client-123',
          }),
        }),
      );
      expect(storeTokensSpy).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        }),
      );

      storeTokensSpy.mockRestore();
    });
  });
  /* === VIVENTIUM END === */

  describe('deleteUserTokens', () => {
    const userId = '000000001111111122222222';
    const serverName = 'test-server';
    let mockDeleteToken: jest.MockedFunction<
      (filter: { userId: string; type: string; identifier: string }) => Promise<void>
    >;

    beforeEach(() => {
      jest.clearAllMocks();
      mockDeleteToken = jest.fn().mockResolvedValue(undefined);
    });

    it('should delete all OAuth-related tokens for a user and server', async () => {
      await MCPTokenStorage.deleteUserTokens({
        userId,
        serverName,
        deleteToken: mockDeleteToken,
      });

      // Verify all three token types were deleted with correct identifiers
      expect(mockDeleteToken).toHaveBeenCalledTimes(3);
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_client',
        identifier: `mcp:${serverName}:client`,
      });
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth',
        identifier: `mcp:${serverName}`,
      });
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: `mcp:${serverName}:refresh`,
      });
    });

    it('should handle deletion errors gracefully', async () => {
      mockDeleteToken.mockRejectedValueOnce(new Error('Deletion failed'));

      await expect(
        MCPTokenStorage.deleteUserTokens({
          userId,
          serverName,
          deleteToken: mockDeleteToken,
        }),
      ).rejects.toThrow('Deletion failed');

      expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('getClientInfoAndMetadata', () => {
    const userId = '000000001111111122222222';
    const serverName = 'test-server';
    const identifier = `mcp:${serverName}`;
    let mockFindToken: jest.MockedFunction<TokenMethods['findToken']>;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFindToken = jest.fn();
    });

    it('should return null when no client info token exists', async () => {
      mockFindToken.mockResolvedValue(null);

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).toBeNull();
      expect(mockFindToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
      });
    });

    it('should return client info and metadata when token exists', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
        client_secret: 'test-secret',
      };

      const metadata = new Map([
        ['serverUrl', 'https://test.example.com'],
        ['state', 'test-state'],
      ]);

      const mockToken: IToken = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
        metadata,
      } as IToken;

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual({
        serverUrl: 'https://test.example.com',
        state: 'test-state',
      });
      expect(mockDecryptV2).toHaveBeenCalledWith('encrypted-token');
    });

    it('should handle empty metadata', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
      };

      const mockToken: IToken = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
      } as IToken;

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual({});
    });

    it('should handle metadata as plain object', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
      };

      const metadata = {
        serverUrl: 'https://test.example.com',
        state: 'test-state',
      };

      const mockToken: IToken = {
        userId: new Types.ObjectId(userId),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
        metadata: metadata as unknown, // runtime check
      } as IToken;

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual(metadata);
    });
  });
});
