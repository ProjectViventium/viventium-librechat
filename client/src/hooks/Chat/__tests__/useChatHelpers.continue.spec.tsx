/* === VIVENTIUM START === Continue uses the normal new-turn submission boundary. === */
import { act, renderHook } from '@testing-library/react';
import useChatHelpers from '../useChatHelpers';
const mockAsk = jest.fn(),
  mockRegenerate = jest.fn(),
  mockSet = jest.fn();
const mockConversation = { conversationId: 'conversation', endpoint: 'agents' };
let mockLatest = {
  messageId: 'saved-answer',
  parentMessageId: 'original-user',
  conversationId: 'conversation',
  isCreatedByUser: false,
  unfinished: true,
};
const mockOriginal = {
  messageId: 'original-user',
  isCreatedByUser: true,
  text: 'Original request.',
};
jest.mock('../useChatFunctions', () => () => ({ ask: mockAsk, regenerate: mockRegenerate }));
jest.mock('~/hooks/useNewConvo', () => () => ({ newConversation: jest.fn() }));
jest.mock(
  '~/hooks/useLocalize',
  () => () => (key: string) => (key === 'com_ui_continue' ? 'Continue' : key),
);
jest.mock('~/data-provider', () => ({
  useAbortStreamMutation: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: () => [mockOriginal, mockLatest],
    setQueryData: jest.fn(),
  }),
}));
jest.mock('recoil', () => ({
  useRecoilState: (key: string) => [key === 'latest' ? mockLatest : undefined, mockSet],
  useResetRecoilState: () => mockSet,
  useSetRecoilState: () => mockSet,
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    useClearSubmissionState: () => jest.fn(),
    useCreateConversationAtom: () => ({ conversation: mockConversation, setConversation: mockSet }),
    latestMessageFamily: () => 'latest',
    filesByIndex: jest.fn(),
    isSubmittingFamily: jest.fn(),
    messagesSiblingIdxFamily: jest.fn(),
    submissionByIndex: jest.fn(),
    presetByIndex: jest.fn(),
    showPopoverFamily: jest.fn(),
    abortScrollFamily: jest.fn(),
    optionSettingsFamily: jest.fn(),
  },
}));
test.each([true, false])(
  'Continue submits a new request after the saved assistant (unfinished=%s)',
  (unfinished) => {
    mockLatest = { ...mockLatest, unfinished };
    const before = { ...mockLatest };
    const { result } = renderHook(() => useChatHelpers());
    act(() => result.current.handleContinue({ preventDefault: jest.fn() } as never));
    expect(mockAsk).toHaveBeenCalledWith({
      text: 'Continue',
      conversationId: 'conversation',
      parentMessageId: 'saved-answer',
    });
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockLatest).toEqual(before);
    expect(mockOriginal.text).toBe('Original request.');
  },
);
