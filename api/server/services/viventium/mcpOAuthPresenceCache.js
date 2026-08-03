/* === VIVENTIUM START ===
 * Feature: Shared OAuth credential-presence cache invalidation.
 * Purpose: Supported account disconnect/reconnect flows must invalidate the same short-lived
 * cache used by persistent MCP warm-up, preventing a removed credential from being re-warmed.
 * === VIVENTIUM END === */

const oauthTokenPresenceCache = new Map();

function cacheKey(userId, serverName) {
  return `${userId}:${serverName}`;
}

function getOAuthTokenPresence(userId, serverName) {
  return oauthTokenPresenceCache.get(cacheKey(userId, serverName));
}

function setOAuthTokenPresence(userId, serverName, value) {
  oauthTokenPresenceCache.set(cacheKey(userId, serverName), value);
}

function invalidateOAuthTokenPresence(userId, serverName) {
  oauthTokenPresenceCache.delete(cacheKey(userId, serverName));
}

function resetOAuthTokenPresenceForTests() {
  oauthTokenPresenceCache.clear();
}

module.exports = {
  getOAuthTokenPresence,
  invalidateOAuthTokenPresence,
  resetOAuthTokenPresenceForTests,
  setOAuthTokenPresence,
};
