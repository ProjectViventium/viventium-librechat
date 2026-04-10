/* === VIVENTIUM START ===
 * Feature: Conversation recall prompt injection (config-driven).
 *
 * Purpose:
 * - Keep the decision to use conversation recall with the model instead of runtime query
 *   classifiers.
 * - Inject a single YAML-backed instruction block into agent system prompts when
 *   conversation recall is enabled globally or for the selected agent.
 *
 * Config (librechat.yaml):
 * - viventium.conversation_recall.prompt: string (supports YAML multiline blocks)
 *
 * Added: 2026-04-09
 * === VIVENTIUM END === */

const { getConversationRecallRuntimeScope } = require('@librechat/api');

function resolveConversationRecallPromptText(req) {
  const fromConfig = req?.config?.viventium?.conversation_recall?.prompt;
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  return '';
}

function buildConversationRecallInstructions({ req, agent, user }) {
  const scope = getConversationRecallRuntimeScope({
    user: user ?? req?.user ?? null,
    agent: agent ?? null,
  });
  if (scope === 'none') {
    return '';
  }
  return resolveConversationRecallPromptText(req);
}

module.exports = {
  buildConversationRecallInstructions,
  resolveConversationRecallPromptText,
};
