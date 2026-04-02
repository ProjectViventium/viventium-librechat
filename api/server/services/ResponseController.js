/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Service: ResponseController
 * Purpose: Manage proactive delivery of cortex insights when user is idle
 * Added: 2026-01-03
 *
 * ARCHITECTURE:
 * The ResponseController manages the timing and delivery of cortex insights:
 * 1. Tracks when user last sent input
 * 2. Queues insights from background cortices
 * 3. Delivers insights proactively when appropriate
 *
 * INTEGRATION POINTS:
 * - AgentClient: Calls addInsight() when cortices complete
 * - Send endpoint: Calls onUserInput() to track activity
 * - SSE stream: Receives formatted insights for delivery
 */

const { logger } = require('@librechat/data-schemas');

/**
 * Default idle timeout before proactive delivery (ms)
 * User must be idle for this long before insights are delivered
 */
const DEFAULT_IDLE_TIMEOUT = 2000;

/**
 * Maximum time to wait for cortex insights before giving up (ms)
 */
const MAX_INSIGHT_WAIT = 30000;

/**
 * ResponseController manages the timing and delivery of cortex insights.
 * Each conversation can have its own instance for stateful tracking.
 */
class ResponseController {
  /**
   * @param {Object} options
   * @param {string} options.conversationId - The conversation ID
   * @param {number} [options.idleTimeout] - Idle timeout before delivery (ms)
   */
  constructor({ conversationId, idleTimeout = DEFAULT_IDLE_TIMEOUT }) {
    this.conversationId = conversationId;
    this.idleTimeout = idleTimeout;
    this.pendingInsights = [];
    this.lastUserInputTime = Date.now();
    this.isDelivering = false;
    this.deliveryPromiseResolve = null;

    logger.debug(`[ResponseController] Created for conversation ${conversationId}`);
  }

  /**
   * Called when user sends a new message.
   * Clears pending insights (user interrupted) and resets timer.
   */
  onUserInput() {
    this.lastUserInputTime = Date.now();

    if (this.pendingInsights.length > 0) {
      logger.debug(
        `[ResponseController] User input detected, clearing ${this.pendingInsights.length} pending insights`
      );
      this.pendingInsights = [];
    }
  }

  /**
   * Add a cortex insight to the pending queue.
   * Triggers proactive delivery if user is idle.
   *
   * @param {Object} insight
   * @param {string} insight.cortexId - Cortex agent ID
   * @param {string} insight.cortexName - Cortex display name
   * @param {string} insight.insight - The insight content
   * @returns {Promise<void>}
   */
  async addInsight(insight) {
    this.pendingInsights.push({
      ...insight,
      timestamp: Date.now(),
    });

    logger.debug(
      `[ResponseController] Added insight from ${insight.cortexName}, ` +
      `total pending: ${this.pendingInsights.length}`
    );

    // Check if user is idle and we should deliver
    await this.checkAndDeliver();
  }

  /**
   * Check if user is idle and deliver pending insights if appropriate.
   * @returns {Promise<void>}
   */
  async checkAndDeliver() {
    if (this.isDelivering) {
      logger.debug('[ResponseController] Delivery already in progress, skipping');
      return;
    }

    if (this.pendingInsights.length === 0) {
      return;
    }

    const idleTime = Date.now() - this.lastUserInputTime;
    if (idleTime >= this.idleTimeout) {
      await this.deliverProactively();
    } else {
      // Schedule delivery for when idle timeout is reached
      const waitTime = this.idleTimeout - idleTime;
      logger.debug(`[ResponseController] User not idle enough, waiting ${waitTime}ms`);

      setTimeout(async () => {
        // Re-check if still idle (user might have sent input)
        const currentIdleTime = Date.now() - this.lastUserInputTime;
        if (currentIdleTime >= this.idleTimeout && this.pendingInsights.length > 0) {
          await this.deliverProactively();
        }
      }, waitTime);
    }
  }

  /**
   * Deliver pending insights to the user.
   * This is the core proactive delivery mechanism.
   *
   * @returns {Promise<Array>} The delivered insights
   */
  async deliverProactively() {
    if (this.isDelivering || this.pendingInsights.length === 0) {
      return [];
    }

    this.isDelivering = true;

    try {
      const insightsToDeliver = [...this.pendingInsights];
      this.pendingInsights = [];

      logger.info(
        `[ResponseController] Delivering ${insightsToDeliver.length} cortex insights proactively`
      );

      // Resolve any waiting promise (for sync delivery patterns)
      if (this.deliveryPromiseResolve) {
        this.deliveryPromiseResolve(insightsToDeliver);
        this.deliveryPromiseResolve = null;
      }

      return insightsToDeliver;
    } finally {
      this.isDelivering = false;
    }
  }

  /**
   * Wait for insights to be ready for delivery.
   * Used when you want to block until insights are available.
   *
   * @param {number} [timeout] - Maximum time to wait (ms)
   * @returns {Promise<Array>} The insights when ready
   */
  async waitForInsights(timeout = MAX_INSIGHT_WAIT) {
    if (this.pendingInsights.length > 0) {
      return this.deliverProactively();
    }

    return new Promise((resolve) => {
      this.deliveryPromiseResolve = resolve;

      // Timeout safety
      setTimeout(() => {
        if (this.deliveryPromiseResolve === resolve) {
          this.deliveryPromiseResolve = null;
          resolve([]);
        }
      }, timeout);
    });
  }

  /**
   * Format insights for injection into a message or system prompt.
   * @param {Array} insights - Array of insight objects
   * @returns {string} Formatted insights text
   */
  static formatInsightsForMessage(insights) {
    if (!insights || insights.length === 0) {
      return '';
    }

    const formattedInsights = insights
      .map(({ cortexName, insight }) => `### ${cortexName}\n${insight}`)
      .join('\n\n');

    return `
## Background Analysis Results
The following insights were generated by specialized analysis:

${formattedInsights}
`;
  }

  /**
   * Get the number of pending insights.
   * @returns {number}
   */
  get pendingCount() {
    return this.pendingInsights.length;
  }

  /**
   * Check if there are any pending insights.
   * @returns {boolean}
   */
  get hasPending() {
    return this.pendingInsights.length > 0;
  }

  /**
   * Clear all pending insights without delivering.
   */
  clear() {
    const count = this.pendingInsights.length;
    this.pendingInsights = [];
    logger.debug(`[ResponseController] Cleared ${count} pending insights`);
  }
}

/**
 * Map of conversation ID to ResponseController instance.
 * Provides conversation-scoped state management.
 */
const controllers = new Map();

/**
 * Get or create a ResponseController for a conversation.
 * @param {string} conversationId
 * @param {Object} [options] - Options for new controller
 * @returns {ResponseController}
 */
function getController(conversationId, options = {}) {
  if (!controllers.has(conversationId)) {
    controllers.set(conversationId, new ResponseController({
      conversationId,
      ...options,
    }));
  }
  return controllers.get(conversationId);
}

/**
 * Remove a ResponseController for a conversation.
 * Call when conversation ends or user disconnects.
 * @param {string} conversationId
 */
function removeController(conversationId) {
  const controller = controllers.get(conversationId);
  if (controller) {
    controller.clear();
    controllers.delete(conversationId);
    logger.debug(`[ResponseController] Removed controller for ${conversationId}`);
  }
}

/**
 * Get all active controllers (for debugging/monitoring).
 * @returns {Map<string, ResponseController>}
 */
function getActiveControllers() {
  return controllers;
}

module.exports = {
  ResponseController,
  getController,
  removeController,
  getActiveControllers,
  DEFAULT_IDLE_TIMEOUT,
  MAX_INSIGHT_WAIT,
  formatInsightsForMessage: ResponseController.formatInsightsForMessage,
};

/* === VIVENTIUM NOTE === */
