/* === VIVENTIUM START ===
 * Feature: Gateway Conversation Defaults (Telegram/Scheduler/Voice)
 *
 * Purpose:
 * - Keep non-UI entrypoints aligned with LibreChat web UI conversation metadata:
 *   1) New conversations must use `Constants.NO_PARENT` so title generation runs
 *      (AgentController only generates titles when `parentMessageId === Constants.NO_PARENT`).
 *   2) Gateways must set `spec` (model spec) to match web UI behavior so the server
 *      derives the correct `iconURL` from model spec configuration.
 *
 * Why iconURL must be derived from `spec`:
 * - `parseCompactConvo()` strips `iconURL` from incoming requests (client must not supply it).
 * - `buildEndpointOption` only sets iconURL server-side from modelSpecs when `spec` is present.
 * - Without `spec`, `endpointOption.iconURL` is undefined, so `BaseClient.saveMessageToDatabase`
 *   will unset `conversation.iconURL` on subsequent messages (sidebar falls back to default icon).
 *
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');

function normalizeGatewayParentMessageId({ conversationId, parentMessageId }) {
  // LibreChat web UI always uses Constants.NO_PARENT for brand new conversations.
  // Our gateway routes often send `conversationId: 'new'` and were leaving parentMessageId null,
  // which prevented title generation in `AgentController`.
  if (!conversationId || conversationId === 'new') {
    return Constants.NO_PARENT;
  }
  return parentMessageId ?? null;
}

function _resolveAgentModelSpecName({ req, agentId }) {
  const list = req?.config?.modelSpecs?.list;
  if (!Array.isArray(list) || !agentId) {
    return '';
  }

  // 1) Try exact match: modelSpec preset selects this agent.
  for (const spec of list) {
    const preset = spec?.preset;
    if (!preset || preset?.endpoint !== 'agents') {
      continue;
    }
    if (!preset?.agent_id || preset.agent_id !== agentId) {
      continue;
    }
    if (typeof spec?.name === 'string' && spec.name.trim()) {
      return spec.name.trim();
    }
  }

  // 2) Fall back to the default Agents modelSpec (matches web UI default behavior).
  for (const spec of list) {
    const preset = spec?.preset;
    if (!preset || preset?.endpoint !== 'agents') {
      continue;
    }
    if (spec?.default !== true) {
      continue;
    }
    if (typeof spec?.name === 'string' && spec.name.trim()) {
      return spec.name.trim();
    }
  }

  // 3) Last resort: first Agents modelSpec found.
  for (const spec of list) {
    const preset = spec?.preset;
    if (!preset || preset?.endpoint !== 'agents') {
      continue;
    }
    if (typeof spec?.name === 'string' && spec.name.trim()) {
      return spec.name.trim();
    }
  }

  return '';
}

function ensureGatewaySpec({ req, existingSpec, agentId }) {
  if (typeof existingSpec === 'string' && existingSpec.trim()) {
    return existingSpec.trim();
  }
  return _resolveAgentModelSpecName({ req, agentId });
}

module.exports = {
  ensureGatewaySpec,
  normalizeGatewayParentMessageId,
};
