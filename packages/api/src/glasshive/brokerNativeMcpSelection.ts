/* === VIVENTIUM START === One authorized Core MCP owner per Native server. === */
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import type { TomlTable, TomlValue } from 'smol-toml';

export interface BrokerNativeMcpEntry {
  serverName: string;
  policy: { nativeServerIds?: readonly string[] };
}

/** Call with reviewed entries and the actual prepared/signed broker scope, never raw inventory. */
export function brokerOwnedNativeServerIds(
  entries: readonly BrokerNativeMcpEntry[],
  allowedServers: readonly string[],
): string[] {
  const allowed = new Set(allowedServers);
  return [...new Set(entries.flatMap(({ serverName, policy }) =>
    allowed.has(serverName) ? policy.nativeServerIds ?? [] : [],
  ))].sort();
}

function table(value: TomlValue | undefined): TomlTable {
  if (value == null) return Object.create(null) as TomlTable;
  const prototype = typeof value === 'object' && !Array.isArray(value)
    ? Object.getPrototypeOf(value) : undefined;
  if (value && typeof value === 'object' && (prototype === null || prototype === Object.prototype)) {
    return value as TomlTable;
  }
  throw new Error('Native MCP configuration table is invalid');
}

/** Only the raw model-authored launch boundary uses this shape. Trusted Core bundles do not. */
export interface ModelLaunchBootstrapBundle {
  [field: string]: unknown;
}

const BROKER_CONTROL_FIELDS = new Set([
  'glasshivecapabilitybroker',
  'glasshivecapabilityauthorization',
  'glasshivecapabilityintent',
  'glasshivecapabilityrequirement',
  'glasshivecapabilitybrokerstatus',
  'viventiumlaunchauthority',
  'viventiumfeelingsprojection',
]);
const controlKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const isObject = (value: unknown): value is ModelLaunchBootstrapBundle =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function referencesBearer(value: unknown, bearerTokenEnvVar: string): boolean {
  if (typeof value === 'string') return value.includes(bearerTokenEnvVar);
  if (Array.isArray(value)) return value.some((item) => referencesBearer(item, bearerTokenEnvVar));
  return isObject(value) && Object.entries(value).some(([key, item]) =>
    key.includes(bearerTokenEnvVar) || referencesBearer(item, bearerTokenEnvVar),
  );
}

/** Preserve context and unrelated settings; Core alone reconstructs its grant authority. */
export function stripModelBrokerAuthority(
  input: ModelLaunchBootstrapBundle,
  { brokerServerName, bearerTokenEnvVar }: { brokerServerName: string; bearerTokenEnvVar: string },
): ModelLaunchBootstrapBundle {
  if (!brokerServerName || !bearerTokenEnvVar) throw new Error('Broker authority identity is required');
  const ownedServer = controlKey(brokerServerName);
  const bundle = Object.fromEntries(
    Object.entries(input).filter(([name]) => !BROKER_CONTROL_FIELDS.has(controlKey(name))),
  );
  if (isObject(bundle.env)) {
    bundle.env = Object.fromEntries(
      Object.entries(bundle.env).filter(([name]) => name.toUpperCase() !== bearerTokenEnvVar.toUpperCase()),
    );
  }
  if (isObject(bundle.claude_project_mcp)) {
    bundle.claude_project_mcp = Object.fromEntries(
      Object.entries(bundle.claude_project_mcp).filter(([name, config]) =>
        controlKey(name) !== ownedServer && !referencesBearer(config, bearerTokenEnvVar),
      ),
    );
  }
  if (typeof bundle.codex_config_append === 'string') {
    const options = { integersAsBigInt: true, useLegacyDate: false, unsafeKeyBehaviour: 'throw' } as const;
    const config = parse(bundle.codex_config_append, options);
    if (config.mcp_servers !== undefined) {
      const servers = table(config.mcp_servers);
      for (const [name, server] of Object.entries(servers)) {
        if (controlKey(name) === ownedServer || referencesBearer(server, bearerTokenEnvVar)) delete servers[name];
      }
      config.mcp_servers = servers;
      const result = stringify(config, { numbersAsFloat: true });
      if (!isDeepStrictEqual(config, parse(result, options))) {
        throw new Error('Native MCP configuration cannot be recomposed without changing its values');
      }
      bundle.codex_config_append = result;
    }
  }
  return bundle;
}

/** Compose a per-invocation overlay. Global Native configuration is never changed. */
export function composeBrokerNativeMcpConfig({
  configAppend = '',
  brokerServerName,
  brokerUrl,
  bearerTokenEnvVar,
  nativeServerIds = [],
}: {
  configAppend?: string;
  brokerServerName: string;
  brokerUrl: string;
  bearerTokenEnvVar: string;
  nativeServerIds?: readonly string[];
}): string {
  // Preserve integer/float kinds and full datetime precision. On runtimes without Temporal,
  // a datetime fails closed instead of silently losing precision through JavaScript Date.
  const parseOptions = { integersAsBigInt: true, useLegacyDate: false, unsafeKeyBehaviour: 'throw' } as const;
  const config = parse(configAppend, parseOptions);
  const servers = table(config.mcp_servers);
  for (const serverId of new Set(nativeServerIds)) {
    if (!serverId || serverId.trim() !== serverId || serverId === brokerServerName) {
      throw new Error('Reviewed Native MCP server identity is invalid');
    }
    servers[serverId] = Object.assign(table(servers[serverId]), { enabled: false });
  }
  servers[brokerServerName] = Object.assign(table(servers[brokerServerName]), {
    url: brokerUrl,
    bearer_token_env_var: bearerTokenEnvVar,
  });
  config.mcp_servers = servers;
  const result = stringify(config, { numbersAsFloat: true });
  // Parsed tables retain the parser's own prototype; compare the same representation.
  if (!isDeepStrictEqual(config, parse(result, parseOptions))) {
    throw new Error('Native MCP configuration cannot be recomposed without changing its values');
  }
  return result;
}
/* === VIVENTIUM END === */
