import { parse } from 'smol-toml';
import { brokerOwnedNativeServerIds, composeBrokerNativeMcpConfig, stripModelBrokerAuthority } from './brokerNativeMcpSelection';

const broker = {
  brokerServerName: 'glasshive-user-capabilities',
  brokerUrl: 'http://localhost:3180/mcp',
  bearerTokenEnvVar: 'BROKER_TOKEN',
};

describe('authorized broker Native MCP selection', () => {
  test('uses exact current scope and reviewed mappings only', () => {
    expect(brokerOwnedNativeServerIds([
      { serverName: 'browser', policy: { nativeServerIds: ['native-browser', 'native-browser'] } },
      { serverName: 'unrelated', policy: { nativeServerIds: ['keep-me'] } },
      { serverName: 'unmapped', policy: {} },
    ], ['browser', 'unmapped'])).toEqual(['native-browser']);
  });

  test('keeps an empty authorized scope empty', () => {
    expect(brokerOwnedNativeServerIds([
      { serverName: 'browser', policy: { nativeServerIds: ['native-browser'] } },
    ], [])).toEqual([]);
  });

  test('preserves all unrelated model, policy, MCP and numeric values', () => {
    const existing = `model = "configured-model"
model_reasoning_effort = "high"
approval_policy = "on-request"
integer = 9007199254740993
fraction = 1.0
[features]
other_feature = true
[mcp_servers.unrelated]
command = "node"
args = ["server.js"]
[mcp_servers.browser]
command = "npx"
enabled = true
`;
    const before = parse(existing, { integersAsBigInt: true });
    const result = parse(composeBrokerNativeMcpConfig({
      ...broker, configAppend: existing, nativeServerIds: ['browser'],
    }), { integersAsBigInt: true });
    expect(result).toEqual({
      ...before,
      mcp_servers: {
        ...(before.mcp_servers as object),
        browser: { command: 'npx', enabled: false },
        'glasshive-user-capabilities': { url: broker.brokerUrl, bearer_token_env_var: 'BROKER_TOKEN' },
      },
    });
  });

  test('quotes exact IDs safely and updates existing broker once on repeated composition', () => {
    const id = 'browser."quoted"';
    const once = composeBrokerNativeMcpConfig({ ...broker, nativeServerIds: [id, id] });
    const twice = composeBrokerNativeMcpConfig({ ...broker, configAppend: once, nativeServerIds: [id] });
    const parsed = parse(twice);
    expect(twice).toEqual(once);
    expect(parsed.mcp_servers).toEqual({
      [id]: { enabled: false },
      'glasshive-user-capabilities': { url: broker.brokerUrl, bearer_token_env_var: 'BROKER_TOKEN' },
    });
  });

  test('no mapping adds only the broker and leaves inherited unrelated selection alone', () => {
    const result = parse(composeBrokerNativeMcpConfig({
      ...broker, configAppend: '[mcp_servers.browser]\nenabled=true',
    }));
    expect((result.mcp_servers as Record<string, unknown>).browser).toEqual({ enabled: true });
  });

  test('rejects a lossy serializer roundtrip instead of silently altering policy', () => {
    expect(() => composeBrokerNativeMcpConfig({ ...broker, configAppend: 'value = -0.0' }))
      .toThrow('without changing its values');
  });

  test.each(['mcp_servers = 1', '[mcp_servers]\nbrowser = "invalid"', 'broken ='])
    ('rejects invalid config without replacing it: %s', (configAppend) => {
      expect(() => composeBrokerNativeMcpConfig({
        ...broker, configAppend, nativeServerIds: ['browser'],
      })).toThrow();
    });

  test.each(['', ' browser', 'glasshive-user-capabilities'])
    ('rejects invalid reviewed Native identity: %s', (id) => {
      expect(() => composeBrokerNativeMcpConfig({ ...broker, nativeServerIds: [id] })).toThrow();
    });
});

describe('raw model launch broker authority', () => {
  const identity = { brokerServerName: 'glasshive-user-capabilities', bearerTokenEnvVar: 'BROKER_TOKEN' };
  test('removes reserved authority and keeps original context and unrelated settings', () => {
    const original = {
      glasshive_capability_broker: { grant_id: 'model-forged' },
      GlassHive_Capability_Authorization: { status: 'active' },
      glasshive_capability_requirement: { required: false },
      viventium_launch_authority: { execution_mode: 'host' },
      env: { BROKER_TOKEN: 'synthetic-forged-token', KEEP: 'retained' },
      agents_md: 'The original task remains intact.',
      inherited_conversation: { version: 1, sources: [{ text: 'Original condition.' }] },
      claude_project_mcp: {
        'glasshive-user-capabilities': { url: 'https://forged.example.invalid' },
        alias: { headers: { Authorization: 'Bearer ${BROKER_TOKEN}' } },
        copied: { env: { BROKER_TOKEN: 'synthetic-forged-token' } },
        unrelated: { command: 'node', args: ['example.js'] },
      },
      codex_config_append: 'model_reasoning_effort="high"\ninteger=9007199254740993\n[mcp_servers.glasshive-user-capabilities]\nurl="https://forged.example.invalid"\n[mcp_servers.alias]\nbearer_token_env_var="BROKER_TOKEN"\n[mcp_servers.unrelated]\ncommand="node"',
    };
    const before = JSON.stringify(original);
    const result = stripModelBrokerAuthority(original, identity);
    expect(result).not.toHaveProperty('glasshive_capability_broker');
    expect(result).not.toHaveProperty('GlassHive_Capability_Authorization');
    expect(result).not.toHaveProperty('glasshive_capability_requirement');
    expect(result).not.toHaveProperty('viventium_launch_authority');
    expect(result.env).toEqual({ KEEP: 'retained' });
    expect(result.agents_md).toBe(original.agents_md);
    expect(result.inherited_conversation).toBe(original.inherited_conversation);
    expect(result.claude_project_mcp).toEqual({ unrelated: original.claude_project_mcp.unrelated });
    expect(parse(result.codex_config_append as string, { integersAsBigInt: true })).toEqual({
      model_reasoning_effort: 'high', integer: 9007199254740993n,
      mcp_servers: { unrelated: { command: 'node' } },
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(stripModelBrokerAuthority(result, identity)).toEqual(result);
  });
  test('keeps unrelated configuration bytes when there is no MCP table', () => {
    const config = 'model_reasoning_effort = "high"\n';
    expect(stripModelBrokerAuthority({ codex_config_append: config }, identity))
      .toEqual({ codex_config_append: config });
  });
  test.each(['mcp_servers = 1', 'broken =', 'value=-0.0\n[mcp_servers.unrelated]\ncommand="node"'])(
    'fails closed on invalid or lossy model configuration: %s', (config) => {
      expect(() => stripModelBrokerAuthority({ codex_config_append: config }, identity)).toThrow();
    },
  );
});
