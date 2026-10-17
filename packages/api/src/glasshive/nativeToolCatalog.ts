/* === VIVENTIUM START === Bounded factual metadata from the current broker catalog. === */
import { Constants } from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const NATIVE_TOOL_CATALOG_MAX_BYTES = 65_536;
export const NATIVE_TOOL_CATALOG_MAX_TOOLS = 64;

export interface NativeToolCatalog {
  version: 1;
  grant_id: string;
  expires_at: number;
  server_name: string;
  broker_url: string;
  tools: Pick<Tool, 'name' | 'description' | 'inputSchema'>[];
}

export function createNativeToolCatalog({
  grantId,
  expiresAt,
  serverName,
  brokerUrl,
  tools,
}: {
  grantId: string;
  expiresAt: number;
  serverName: string;
  brokerUrl: string;
  tools: Tool[];
}): NativeToolCatalog | null {
  if (
    !grantId ||
    !serverName ||
    !brokerUrl ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    !Array.isArray(tools) ||
    tools.length === 0 ||
    tools.length > NATIVE_TOOL_CATALOG_MAX_TOOLS
  ) {
    return null;
  }
  const names = new Set<string>();
  const projected: NativeToolCatalog['tools'] = [];
  for (const tool of tools) {
    if (
      !tool ||
      typeof tool.name !== 'string' ||
      !tool.name ||
      tool.name.trim() !== tool.name ||
      names.has(tool.name) ||
      (tool.description != null && typeof tool.description !== 'string') ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== 'object' ||
      Array.isArray(tool.inputSchema) ||
      tool.inputSchema.type !== 'object'
    ) {
      return null;
    }
    names.add(tool.name);
    projected.push({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema,
    });
  }
  const catalog: NativeToolCatalog = {
    version: 1,
    grant_id: grantId,
    expires_at: expiresAt,
    server_name: serverName,
    broker_url: brokerUrl,
    tools: projected.sort((a, b) => a.name.localeCompare(b.name)),
  };
  return Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= NATIVE_TOOL_CATALOG_MAX_BYTES
    ? catalog
    : null;
}
/** Use only the existing owner/server cache, with policy that preserves canonical mutation schemas. */
export function nativeToolDefinitionsFromCache({
  serverName,
  cachedTools,
  toolPolicies,
}: {
  serverName: string;
  cachedTools: unknown;
  toolPolicies: Record<string, { access?: string }>;
}): Tool[] | null {
  if (!cachedTools || typeof cachedTools !== 'object' || Array.isArray(cachedTools)) return null;
  const suffix = `${Constants.mcp_delimiter}${serverName}`;
  const definitions: Tool[] = [];
  for (const [key, value] of Object.entries(cachedTools)) {
    const fn = value?.function;
    if (value?.type !== 'function' || !fn || fn.name !== key || !key.endsWith(suffix)) return null;
    const name = key.slice(0, -suffix.length);
    // Cached functions omit upstream annotations; explicit policy makes the write schema equivalent.
    if (
      !name ||
      !toolPolicies?.[name]?.access ||
      !fn.parameters ||
      typeof fn.parameters !== 'object' ||
      Array.isArray(fn.parameters) ||
      fn.parameters.type !== 'object' ||
      (fn.description != null && typeof fn.description !== 'string')
    )
      return null;
    definitions.push({ name, description: fn.description || '', inputSchema: fn.parameters });
  }
  return definitions.length > 0 ? definitions : null;
}

/** Optional metadata must fit the existing complete native bootstrap carrier. */
export function nativeToolCatalogFitsBootstrap(
  bundle: Record<string, unknown>,
  catalog: NativeToolCatalog,
): boolean {
  const broker = bundle.glasshive_capability_broker;
  if (!broker || typeof broker !== 'object' || Array.isArray(broker)) return false;
  const candidate = {
    ...bundle,
    glasshive_capability_broker: { ...broker, tool_catalog: catalog },
  };
  return (
    Buffer.byteLength(Buffer.from(JSON.stringify(candidate), 'utf8').toString('base64')) <=
    128 * 1024
  );
}
/* === VIVENTIUM END === */
