const { logger } = require('@librechat/data-schemas');
/* === VIVENTIUM START ===
 * Feature: Support ephemeral agent IDs in voice calls (derive model/provider)
 * Purpose: Import parsing helpers so voice calls can use ephemeral agent IDs while still selecting the correct endpoint/model.
 * Added: 2026-01-11
 */
const {
  isAgentsEndpoint,
  isEphemeralAgentId,
  parseEphemeralAgentId,
  removeNullishValues,
  stripAgentIdSuffix,
  Constants,
} = require('librechat-data-provider');
/* === VIVENTIUM END === */
const { loadAgent } = require('~/models/Agent');

const buildOptions = async (req, endpoint, parsedBody, endpointType) => {
  const { spec, iconURL: parsedIconURL, agent_id, ...model_parameters } = parsedBody;
  /* === VIVENTIUM START ===
   * Feature: Support ephemeral agent IDs in voice calls (derive model/provider)
   * Purpose: When voice gateway sends an ephemeral agent_id, derive endpoint/model/modelLabel so the correct provider is used.
   * Added: 2026-01-11
   */
  let agentEndpoint = endpoint;
  if (isAgentsEndpoint(endpoint) && isEphemeralAgentId(agent_id)) {
    const parsed = parseEphemeralAgentId(stripAgentIdSuffix(agent_id));
    if (parsed?.endpoint) {
      agentEndpoint = parsed.endpoint;
      if (!model_parameters.model && parsed.model) {
        model_parameters.model = parsed.model;
      }
      if (!model_parameters.modelLabel && parsed.sender) {
        model_parameters.modelLabel = parsed.sender;
      }
    } else {
      logger.warn('[VIVENTIUM][agents/build] Failed to parse ephemeral agent_id', {
        agent_id,
        endpoint,
      });
    }
  }

  const agentPromise = loadAgent({
    req,
    spec,
    agent_id: isAgentsEndpoint(endpoint) ? agent_id : Constants.EPHEMERAL_AGENT_ID,
    endpoint: agentEndpoint,
    model_parameters,
  }).catch((error) => {
    logger.error(`[/agents/:${agent_id}] Error retrieving agent during build options step`, error);
    return undefined;
  });
  /* === VIVENTIUM END === */

  const agent = await agentPromise;

  /* === VIVENTIUM START ===
   * Feature: Agent avatar source of truth for persisted icon URLs.
   * Purpose: Derive `iconURL` from the resolved agent avatar whenever available so
   * agent chat icons do not depend on stale modelSpec-hosted absolute URLs.
   * Added: 2026-03-05
   */
  let avatarFilepath = '';
  if (typeof agent?.avatar === 'string') {
    avatarFilepath = agent.avatar;
  } else if (typeof agent?.avatar?.filepath === 'string') {
    avatarFilepath = agent.avatar.filepath;
  }
  const resolvedIconURL = avatarFilepath || parsedIconURL;
  /* === VIVENTIUM END === */

  /** @type {import('librechat-data-provider').TConversation | undefined} */
  const addedConvo = req.body?.addedConvo;

  return removeNullishValues({
    spec,
    iconURL: resolvedIconURL,
    endpoint,
    agent_id,
    endpointType,
    model_parameters,
    agent: Promise.resolve(agent),
    addedConvo,
  });
};

module.exports = { buildOptions };
