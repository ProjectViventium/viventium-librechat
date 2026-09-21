const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo } = require('~/models');
const buildFallbackTitle = require('~/server/utils/buildFallbackTitle');
const { getTrustedInteractionContext } = require('~/server/services/viventium/interactionContext');
const {
  recordVoiceOrchestrationTraceBestEffort,
} = require('~/server/services/viventium/VoiceOrchestrationTraceService');

/**
 * Add title to conversation in a way that avoids memory retention
 */
const addTitle = async (req, { text, response, client }) => {
  const { TITLE_CONVO = true } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return;
  }

  if (client.options.titleConvo === false) {
    return;
  }

  // Skip title generation for temporary conversations
  if (req?.body?.isTemporary) {
    return;
  }

  if (typeof client?.titleConvo !== 'function') return;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${response.conversationId}`;
  /** @type {NodeJS.Timeout} */
  let timeoutId;
  const fallbackTitle = buildFallbackTitle(text);
  const abortController = new AbortController();
  let title = fallbackTitle;
  let modelGeneratedTitle = false;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Title generation timeout')), 45000);
    });

    const generated = await Promise.race([
      client.titleConvo({ text, abortController }),
      timeoutPromise,
    ]);
    if (generated) {
      title = generated;
      modelGeneratedTitle = true;
    } else {
      logger.debug(`[${key}] No title generated, using fallback title`);
    }
  } catch (error) {
    logger.warn('Error generating title, using fallback title:', error);
  } finally {
    if (!abortController.signal.aborted) abortController.abort();
    if (timeoutId) clearTimeout(timeoutId);
  }

  const interaction = getTrustedInteractionContext(req);
  if (
    modelGeneratedTitle &&
    req?.body?.voiceMode === true &&
    req?.body?.viventiumCallSessionId &&
    interaction?.surface === 'voice' &&
    interaction?.logical_turn_id &&
    response?.conversationId
  ) {
    await recordVoiceOrchestrationTraceBestEffort({
      ownerId: req.user?.id,
      callSessionId: req.body.viventiumCallSessionId,
      turnId: interaction.logical_turn_id,
      eventRef: response.conversationId,
      stage: 'title_model.completed',
      facts: { effectCount: 1 },
    });
  }

  const saved = await saveConvo(
    req,
    { conversationId: response.conversationId, title },
    {
      context: 'api/server/services/Endpoints/agents/title.js',
      titleOnly: true,
      noUpsert: true,
    },
  );
  if (saved) {
    await titleCache.set(key, saved.title, 120000);
  }
};

module.exports = addTitle;
