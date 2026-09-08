import { act, renderHook } from '@testing-library/react';
import { Constants, ContentTypes } from 'librechat-data-provider';
import type { EventSubmission, TMessage } from 'librechat-data-provider';
import type { CanonicalConversationSubmission } from '../canonicalConversation';
import mockTranslations from '~/locales/en/translation.json';
import { queueTitleGeneration } from '~/data-provider/SSE/queries';
import useEventHandlers from '../useEventHandlers';

jest.mock('recoil', () => ({ useSetRecoilState: () => jest.fn() }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: jest.fn() }),
}));
jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'canonical' }),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/c/canonical' }),
}));
jest.mock('~/utils', () => ({
  getAllContentText: (message: TMessage) => message.text,
  removeConvoFromAllQueries: jest.fn(),
}));
jest.mock('~/data-provider/SSE/queries', () => ({ queueTitleGeneration: jest.fn() }));
jest.mock('~/hooks/SSE/useAttachmentHandler', () => () => jest.fn());
jest.mock('~/hooks/SSE/useContentHandler', () => () => ({}));
jest.mock('~/hooks/SSE/useStepHandler', () => () => ({}));
jest.mock('~/hooks/SSE/viventiumTransientCortex', () => ({
  preserveTransientCortexState: ({ responseMessage }: { responseMessage: TMessage }) =>
    responseMessage,
}));
jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => jest.fn() }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({}) }));
jest.mock('~/common', () => ({ MESSAGE_UPDATE_INTERVAL: 100 }));
const mockAnnouncePolite = jest.fn();
jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: mockAnnouncePolite }),
}));
jest.mock(
  '~/hooks/useLocalize',
  () => () => (key: keyof typeof mockTranslations) => mockTranslations[key] ?? key,
);
jest.mock('~/store', () => ({ abortScroll: 'abortScroll' }));

const question: TMessage = {
  messageId: 'question',
  conversationId: 'canonical',
  parentMessageId: String(Constants.NO_PARENT),
  text: 'Inspect the synthetic inbox.',
  isCreatedByUser: true,
};
const answer: TMessage = {
  messageId: 'answer',
  conversationId: 'canonical',
  parentMessageId: question.messageId,
  text: 'Checked the requested inbox.',
  isCreatedByUser: false,
};

describe('finalHandler canonical title queue', () => {
  it.each([
    { conversationId: 'canonical', originalConversationId: null, expectedCount: 1 },
    {
      conversationId: 'canonical',
      originalConversationId: Constants.NEW_CONVO,
      expectedCount: 1,
    },
    {
      conversationId: Constants.NEW_CONVO,
      originalConversationId: undefined,
      expectedCount: 1,
    },
    { conversationId: 'canonical', originalConversationId: undefined, expectedCount: 0 },
  ])(
    'queues $expectedCount for current $conversationId with original $originalConversationId',
    ({ conversationId, originalConversationId, expectedCount }) => {
      const requestMessage =
        expectedCount === 0 ? { ...question, parentMessageId: 'prior-answer' } : question;
      const submission: CanonicalConversationSubmission<EventSubmission> = {
        conversation: { conversationId },
        userMessage: requestMessage,
        initialResponse: { ...answer, text: '' },
        messages: [],
        endpointOption: { endpoint: null },
        isTemporary: false,
        ...(originalConversationId !== undefined
          ? { viventiumOriginalConversationId: originalConversationId }
          : {}),
      };
      const setMessages = jest.fn();
      const { result } = renderHook(() =>
        useEventHandlers({
          getMessages: () => [requestMessage, answer],
          setMessages,
          setCompleted: jest.fn(),
          setIsSubmitting: jest.fn(),
          setShowStopButton: jest.fn(),
        }),
      );

      act(() => {
        result.current.finalHandler(
          {
            conversation: { conversationId: 'canonical' },
            requestMessage,
            responseMessage: answer,
          },
          submission,
        );
      });

      expect(queueTitleGeneration).toHaveBeenCalledTimes(expectedCount);
      if (expectedCount) expect(queueTitleGeneration).toHaveBeenCalledWith('canonical');
      expect(setMessages).toHaveBeenCalledWith([requestMessage, answer]);
    },
  );

  it('queues a recovered first response without an original-new submission flag', () => {
    const { result } = renderHook(() =>
      useEventHandlers({
        getMessages: () => [question, answer],
        setMessages: jest.fn(),
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      }),
    );
    act(() => {
      result.current.finalHandler(
        {
          conversation: { conversationId: 'canonical' },
          requestMessage: question,
          responseMessage: answer,
        },
        {
          conversation: { conversationId: 'canonical' },
          userMessage: question,
          initialResponse: { ...answer, text: '' },
          messages: [],
          endpointOption: { endpoint: null },
          isTemporary: false,
        },
      );
    });
    expect(queueTitleGeneration).toHaveBeenCalledWith('canonical');
  });
});

describe('finalHandler saved incomplete announcement', () => {
  it.each([
    { finish_reason: 'incomplete', text: '', expected: 'Stopped before completion' },
    {
      finish_reason: 'incomplete',
      text: 'A saved partial.',
      expected: 'Stopped before completion',
    },
    { finish_reason: 'stop', text: 'A complete reply.', expected: 'end' },
    { finish_reason: 'length', text: 'A limited reply.', expected: 'end' },
    { finish_reason: 'content_filter', text: '', expected: 'end' },
  ])('announces $finish_reason for saved text $text', ({ finish_reason, text, expected }) => {
    const responseMessage: TMessage = {
      ...answer,
      text,
      finish_reason,
      content: text ? [{ type: ContentTypes.TEXT, text }] : [],
      unfinished: finish_reason === 'incomplete',
    };
    const setMessages = jest.fn();
    const { result } = renderHook(() =>
      useEventHandlers({
        getMessages: () => [question, responseMessage],
        setMessages,
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      }),
    );
    act(() => {
      result.current.finalHandler(
        {
          conversation: { conversationId: 'canonical' },
          requestMessage: question,
          responseMessage,
        },
        {
          conversation: { conversationId: 'canonical' },
          userMessage: question,
          initialResponse: { ...answer, text: '' },
          messages: [],
          endpointOption: { endpoint: null },
          isTemporary: false,
        },
      );
    });
    expect(mockAnnouncePolite).toHaveBeenCalledWith({ message: expected, isStatus: true });
    expect(mockAnnouncePolite).toHaveBeenCalledWith({ message: text });
    expect(setMessages).toHaveBeenCalledWith([question, responseMessage]);
  });
});

describe('finalHandler terminal error title guard', () => {
  it.each([Constants.NEW_CONVO, 'canonical'])(
    'preserves the failed pair without queuing a title from %s',
    (conversationId) => {
      const responseMessage: TMessage = {
        ...answer,
        text: '',
        error: true,
        unfinished: false,
        finish_reason: 'incomplete',
        content: [{ type: ContentTypes.ERROR, error: 'The response could not be completed.' }],
      };
      const setMessages = jest.fn();
      const { result } = renderHook(() =>
        useEventHandlers({
          getMessages: () => [question, responseMessage],
          setMessages,
          setCompleted: jest.fn(),
          setIsSubmitting: jest.fn(),
          setShowStopButton: jest.fn(),
        }),
      );
      act(() => {
        result.current.finalHandler(
          {
            conversation: { conversationId: 'canonical' },
            requestMessage: question,
            responseMessage,
          },
          {
            conversation: { conversationId },
            userMessage: question,
            initialResponse: { ...answer, text: '' },
            messages: [],
            endpointOption: { endpoint: null },
            isTemporary: false,
          },
        );
      });
      expect(queueTitleGeneration).not.toHaveBeenCalled();
      expect(setMessages).toHaveBeenCalledWith([question, responseMessage]);
      expect(question.text).toBe('Inspect the synthetic inbox.');
    },
  );

  it('still queues a title for an ordinary completed first response', () => {
    const { result } = renderHook(() =>
      useEventHandlers({
        getMessages: () => [question, answer],
        setMessages: jest.fn(),
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      }),
    );
    act(() => {
      result.current.finalHandler(
        {
          conversation: { conversationId: 'canonical' },
          requestMessage: question,
          responseMessage: answer,
        },
        {
          conversation: { conversationId: Constants.NEW_CONVO },
          userMessage: question,
          initialResponse: { ...answer, text: '' },
          messages: [],
          endpointOption: { endpoint: null },
          isTemporary: false,
        },
      );
    });
    expect(queueTitleGeneration).toHaveBeenCalledWith('canonical');
  });
});
