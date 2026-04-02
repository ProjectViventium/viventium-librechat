/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Purpose: Viventium integration module (background cortex/voice/telegram).
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-viventium-additions
 * === VIVENTIUM NOTE === */

const { ContentTypes } = require('librechat-data-provider');

jest.mock('~/models', () => ({
  getMessage: jest.fn(),
  getMessages: jest.fn(),
}));

const { getMessage, getMessages } = require('~/models');
const {
  extractCompletedCortexInsights,
  getCompletedCortexInsightsForMessage,
} = require('~/server/services/viventium/VoiceCortexInsightsService');

describe('VoiceCortexInsightsService', () => {
  describe('extractCompletedCortexInsights', () => {
    test('returns only completed cortex insights with non-empty insight text', () => {
      const content = [
        { type: ContentTypes.CORTEX_BREWING, cortex_id: 'c1', status: 'brewing' },
        { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'c1', cortex_name: 'Subconscious', status: 'complete', insight: ' Secret code: 27. ' },
        { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'c2', cortex_name: 'Other', status: 'complete', insight: '   ' },
        { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'c3', cortex_name: 'Other', status: 'error', insight: 'nope' },
        { type: 'text', text: 'hello' },
      ];

      expect(extractCompletedCortexInsights(content)).toEqual([
        { cortex_id: 'c1', cortex_name: 'Subconscious', insight: 'Secret code: 27.' },
      ]);
    });
  });

  describe('getCompletedCortexInsightsForMessage', () => {
    test('returns null when message not found', async () => {
      getMessage.mockResolvedValueOnce(null);
      getMessages.mockResolvedValueOnce([]);
      const res = await getCompletedCortexInsightsForMessage({
        userId: 'u1',
        messageId: 'm1',
        conversationId: 'c1',
      });
      expect(res).toBeNull();
    });

    test('returns null when conversationId does not match', async () => {
      getMessage.mockResolvedValueOnce({
        messageId: 'm1',
        conversationId: 'c-other',
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            status: 'complete',
            insight: 'hi',
          },
        ],
      });
      const res = await getCompletedCortexInsightsForMessage({
        userId: 'u1',
        messageId: 'm1',
        conversationId: 'c1',
      });
      expect(res).toBeNull();
    });

    test('returns insights when message exists and matches conversationId', async () => {
      getMessage.mockResolvedValueOnce({
        messageId: 'm1',
        conversationId: 'c1',
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'cortex-1',
            cortex_name: 'Background Analysis',
            status: 'complete',
            insight: 'Secret code: 27.',
          },
        ],
      });
      getMessages.mockResolvedValueOnce([]);

      const res = await getCompletedCortexInsightsForMessage({
        userId: 'u1',
        messageId: 'm1',
        conversationId: 'c1',
      });

      expect(res).toEqual({
        messageId: 'm1',
        conversationId: 'c1',
        insights: [
          { cortex_id: 'cortex-1', cortex_name: 'Background Analysis', insight: 'Secret code: 27.' },
        ],
        followUp: null,
      });
    });
  });
});
