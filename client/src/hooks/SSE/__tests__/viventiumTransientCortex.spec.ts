import type { TMessage } from 'librechat-data-provider';
import { preserveTransientCortexState } from '../viventiumTransientCortex';

describe('preserveTransientCortexState', () => {
  it('carries transient cortex parts from the placeholder onto the final response', () => {
    const currentMessages = [
      {
        messageId: 'user-1',
        isCreatedByUser: true,
      },
      {
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: 'Checking now.',
        __viventiumCortexParts: [
          {
            type: 'cortex_brewing',
            cortex_id: 'google',
            status: 'brewing',
          },
        ],
      },
    ] as TMessage[];

    const result = preserveTransientCortexState({
      currentMessages,
      requestMessageId: 'user-1',
      responseMessage: {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: 'Final answer',
      } as TMessage,
    }) as TMessage & { __viventiumCortexParts?: unknown[] };

    expect(result.__viventiumCortexParts).toEqual([
      {
        type: 'cortex_brewing',
        cortex_id: 'google',
        status: 'brewing',
      },
    ]);
  });

  it('does not overwrite cortex parts already attached to the final response', () => {
    const responseMessage = {
      messageId: 'assistant-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Final answer',
      __viventiumCortexParts: [{ cortex_id: 'ms365', status: 'complete' }],
    } as TMessage & { __viventiumCortexParts?: unknown[] };

    const result = preserveTransientCortexState({
      currentMessages: [],
      requestMessageId: 'user-1',
      responseMessage,
    }) as TMessage & { __viventiumCortexParts?: unknown[] };

    expect(result.__viventiumCortexParts).toEqual([{ cortex_id: 'ms365', status: 'complete' }]);
  });

  it('returns the response unchanged when no transient cortex parts are available', () => {
    const responseMessage = {
      messageId: 'assistant-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Final answer',
    } as TMessage;

    const result = preserveTransientCortexState({
      currentMessages: [
        {
          messageId: 'user-1_',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          text: 'Checking now.',
        } as TMessage,
      ],
      requestMessageId: 'user-1',
      responseMessage,
    });

    expect(result).toBe(responseMessage);
  });
});
