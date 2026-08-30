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

  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${response.conversationId}`;
  /** @type {NodeJS.Timeout} */
  let timeoutId;
  const fallbackTitle = buildFallbackTitle(text);
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Title generation timeout')), 45000);
    });

    let titlePromise;
    const abortController = new AbortController();
    if (client && typeof client.titleConvo === 'function') {
      titlePromise = Promise.race([
        client.titleConvo({
          text,
          abortController,
        }),
        timeoutPromise,
      ]);
    } else {
      return;
    }

    let title = await titlePromise;
    const modelGeneratedTitle = Boolean(title);
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!title) {
      logger.debug(`[${key}] No title generated, using fallback title`);
      title = fallbackTitle;
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

    await titleCache.set(key, title, 120000);
    await saveConvo(
      req,
      {
        conversationId: response.conversationId,
        title,
      },
      { context: 'api/server/services/Endpoints/agents/title.js', noUpsert: true },
    );
  } catch (error) {
    logger.warn('Error generating title, using fallback title:', error);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    await titleCache.set(key, fallbackTitle, 120000);
    await saveConvo(
      req,
      {
        conversationId: response.conversationId,
        title: fallbackTitle,
      },
      { context: 'api/server/services/Endpoints/agents/title.js' },
    );
  }
};

module.exports = addTitle;
