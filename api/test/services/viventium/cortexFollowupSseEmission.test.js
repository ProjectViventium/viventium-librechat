/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Purpose: Verify that suppressed follow-ups (NTA) do NOT emit on_cortex_followup SSE events.
 * Context: client.js Phase B .then() chain emits on_cortex_followup only when
 *          followUpMessage?.text is truthy AND req._resumableStreamId is set.
 *          Replace-parent follow-ups must preserve the original parent lineage instead of
 *          self-parenting the canonical assistant message.
 * === VIVENTIUM NOTE === */

const mockEmitChunk = jest.fn();

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    emitChunk: mockEmitChunk,
  },
}));

const { GenerationJobManager } = require('@librechat/api');

/**
 * Extracted from client.js Phase B .then() chain (lines 2117-2129).
 * Tests the exact emission decision logic without needing the full chatCompletion pipeline.
 */
function emitFollowUpEventIfNeeded({ followUpMessage, req, responseMessageId, mergedInsightsData }) {
  if (followUpMessage?.text && req?._resumableStreamId) {
    const emittedParentMessageId =
      followUpMessage.messageId === responseMessageId
        ? followUpMessage.parentMessageId
        : responseMessageId;
    const followUpEvent = {
      event: 'on_cortex_followup',
      data: {
        runId: responseMessageId,
        messageId: followUpMessage.messageId,
        parentMessageId: emittedParentMessageId,
        conversationId: followUpMessage.conversationId,
        text: followUpMessage.text,
        cortexCount: mergedInsightsData?.cortexCount ?? undefined,
      },
    };
    GenerationJobManager.emitChunk(req._resumableStreamId, followUpEvent);
  }
}

describe('cortex follow-up SSE emission contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does NOT emit on_cortex_followup when followUpMessage is null (NTA suppressed)', () => {
    emitFollowUpEventIfNeeded({
      followUpMessage: null,
      req: { _resumableStreamId: 'stream-abc' },
      responseMessageId: 'resp-123',
      mergedInsightsData: { cortexCount: 1 },
    });

    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('does NOT emit on_cortex_followup when followUpMessage.text is empty', () => {
    emitFollowUpEventIfNeeded({
      followUpMessage: { messageId: 'm-1', text: '' },
      req: { _resumableStreamId: 'stream-abc' },
      responseMessageId: 'resp-123',
      mergedInsightsData: { cortexCount: 1 },
    });

    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('does NOT emit on_cortex_followup when req has no _resumableStreamId', () => {
    emitFollowUpEventIfNeeded({
      followUpMessage: { messageId: 'm-1', text: 'Follow-up text' },
      req: {},
      responseMessageId: 'resp-123',
      mergedInsightsData: { cortexCount: 1 },
    });

    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('DOES emit on_cortex_followup when followUpMessage has text and req has streamId', () => {
    emitFollowUpEventIfNeeded({
      followUpMessage: {
        messageId: 'm-1',
        parentMessageId: 'resp-123',
        conversationId: 'conv-1',
        text: 'Here is a new insight.',
      },
      req: { _resumableStreamId: 'stream-abc' },
      responseMessageId: 'resp-123',
      mergedInsightsData: { cortexCount: 2 },
    });

    expect(mockEmitChunk).toHaveBeenCalledTimes(1);
    expect(mockEmitChunk).toHaveBeenCalledWith('stream-abc', {
      event: 'on_cortex_followup',
      data: {
        runId: 'resp-123',
        messageId: 'm-1',
        parentMessageId: 'resp-123',
        conversationId: 'conv-1',
        text: 'Here is a new insight.',
        cortexCount: 2,
      },
    });
  });

  test('emits the original parent lineage for replace-parent follow-up updates', () => {
    emitFollowUpEventIfNeeded({
      followUpMessage: {
        messageId: 'resp-123',
        parentMessageId: 'user-1',
        conversationId: 'conv-1',
        text: 'Final resolved answer',
      },
      req: { _resumableStreamId: 'stream-abc' },
      responseMessageId: 'resp-123',
      mergedInsightsData: { cortexCount: 1 },
    });

    expect(mockEmitChunk).toHaveBeenCalledWith('stream-abc', {
      event: 'on_cortex_followup',
      data: {
        runId: 'resp-123',
        messageId: 'resp-123',
        parentMessageId: 'user-1',
        conversationId: 'conv-1',
        text: 'Final resolved answer',
        cortexCount: 1,
      },
    });
  });
});
