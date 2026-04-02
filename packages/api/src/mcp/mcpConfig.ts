import { math, isEnabled } from '~/utils';

/**
 * Centralized configuration for MCP-related environment variables.
 * Provides typed access to MCP settings with default values.
 */
export const mcpConfig = {
  OAUTH_ON_AUTH_ERROR: isEnabled(process.env.MCP_OAUTH_ON_AUTH_ERROR ?? true),
  OAUTH_DETECTION_TIMEOUT: math(process.env.MCP_OAUTH_DETECTION_TIMEOUT ?? 5000),
  CONNECTION_CHECK_TTL: math(process.env.MCP_CONNECTION_CHECK_TTL ?? 60000),
  /** Idle timeout (ms) after which user connections are disconnected. Default: 15 minutes */
  USER_CONNECTION_IDLE_TIMEOUT: math(
    process.env.MCP_USER_CONNECTION_IDLE_TIMEOUT ?? 15 * 60 * 1000,
  ),
  /* === VIVENTIUM START ===
   * Feature: Keep selected MCP servers warm across user idle cleanup.
   * Purpose: Prevent high-value persistent tools (e.g., scheduling-cortex) from
   * repeatedly dropping to disconnected state between user interactions.
   */
  PERSISTENT_CONNECTION_SERVERS: new Set(
    (process.env.MCP_PERSISTENT_CONNECTION_SERVERS ?? 'scheduling-cortex')
      .split(',')
      .map((serverName) => serverName.trim())
      .filter(Boolean),
  ),
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Proactively reconnect OAuth MCP connections before tokens expire.
   * Purpose: Prevent stale access tokens from breaking scheduled/background tool calls.
   */
  OAUTH_TOKEN_EXPIRE_GRACE_MS: math(
    process.env.MCP_OAUTH_TOKEN_EXPIRE_GRACE_MS ?? 2 * 60 * 1000,
  ),
  /* === VIVENTIUM END === */
};
