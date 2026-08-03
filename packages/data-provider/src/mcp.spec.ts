import { MCPOptionsSchema, MCPServerUserInputSchema } from './mcp';

describe('MCP Viventium server-managed fields', () => {
  test('accepts trusted OAuth connection-group metadata in full MCP options', () => {
    const parsed = MCPOptionsSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      viventiumOAuthConnection: {
        providerId: 'google_workspace',
        slot: 2,
      },
    });

    expect(parsed.viventiumOAuthConnection).toEqual({
      providerId: 'google_workspace',
      slot: 2,
    });
  });

  test('omits trusted OAuth connection-group metadata from user-created MCP input', () => {
    const parsed = MCPServerUserInputSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      viventiumOAuthConnection: {
        providerId: 'google_workspace',
        slot: 2,
      },
    });

    expect('viventiumOAuthConnection' in parsed).toBe(false);
  });

  test('accepts reviewed GlassHive broker policy in full MCP options', () => {
    const parsed = MCPOptionsSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        hostAllowed: true,
        defaultToolAccess: 'read_metadata',
        contentReadPolicy: 'require_broker_grant',
        writePolicy: 'confirm',
        reexportNativeTools: true,
      },
    });

    expect(parsed.viventiumGlassHive?.permitsAutonomousWorker).toBe(true);
    expect(parsed.viventiumGlassHive?.defaultToolAccess).toBe('read_metadata');
  });

  test('omits GlassHive broker policy from user-created MCP server input', () => {
    const parsed = MCPServerUserInputSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
      },
    });

    expect('viventiumGlassHive' in parsed).toBe(false);
  });
});
