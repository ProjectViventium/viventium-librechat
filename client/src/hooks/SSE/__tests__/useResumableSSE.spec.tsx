import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import { Constants, request } from 'librechat-data-provider';
import { queueTitleGeneration } from '~/data-provider';
import type { ReactNode } from 'react';

const mockErrorHandler = jest.fn();
const mockSSEInstances: Array<{
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  headers: Record<string, unknown>;
  emit: (event: string, payload?: unknown) => void;
}> = [];

jest.mock('recoil', () => ({
  useSetRecoilState: () => jest.fn(),
}));

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation(() => {
    const listeners = new Map();
    const instance = {
      addEventListener: jest.fn((event, handler) => {
        listeners.set(event, handler);
      }),
      stream: jest.fn(),
      close: jest.fn(),
      headers: {},
      emit: (event, payload) => listeners.get(event)?.(payload),
    };
    mockSSEInstances.push(instance);
    return instance;
  }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    activeRunFamily: () => 'active-run',
    abortScrollFamily: () => 'abort-scroll',
    showStopButtonByIndex: () => 'show-stop',
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: false }),
}));

jest.mock('~/hooks/SSE/cortexPendingBuffer', () => ({
  createCortexPendingBuffer: () => ({
    handleCreated: jest.fn(),
    handleCortexUpdate: jest.fn(),
  }),
}));

jest.mock('~/hooks/SSE/useEventHandlers', () => ({
  __esModule: true,
  default: () => ({
    stepHandler: jest.fn(),
    finalHandler: jest.fn(),
    errorHandler: mockErrorHandler,
    clearStepMaps: jest.fn(),
    messageHandler: jest.fn(),
    contentHandler: jest.fn(),
    createdHandler: jest.fn(),
    syncStepMessage: jest.fn(),
    attachmentHandler: jest.fn(),
    resetContentHandler: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
  queueTitleGeneration: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  request: {
    post: jest.fn(),
    refreshToken: jest.fn(),
    dispatchTokenUpdatedEvent: jest.fn(),
  },
  Constants: {
    NO_PARENT: '00000000-0000-0000-0000-000000000000',
    NEW_CONVO: 'new',
  },
  QueryKeys: {
    activeJobs: 'activeJobs',
  },
  ErrorTypes: {
    CONNECTED_ACCOUNT_REQUIRED: 'connected_account_required',
  },
  ViolationTypes: {},
  apiBaseUrl: () => 'http://localhost:3180',
  createPayload: jest.fn(() => ({
    payload: { text: 'hello' },
    server: '/api/agents/chat',
  })),
  removeNullishValues: (value: unknown) => value,
}));

describe('useResumableSSE', () => {
  const chatHelpers = {
    setMessages: jest.fn(),
    getMessages: jest.fn(() => []),
    setConversation: jest.fn(),
    setIsSubmitting: jest.fn(),
    newConversation: jest.fn(),
    resetLatestMessage: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSSEInstances.length = 0;
    (request.post as jest.Mock).mockResolvedValue({ streamId: 'stream-1' });
  });

  const createSubmission = () =>
    ({
      conversation: { conversationId: Constants.NEW_CONVO },
      userMessage: {
        messageId: 'user-1',
        parentMessageId: Constants.NO_PARENT,
        conversationId: Constants.NEW_CONVO,
        text: 'hello',
        isCreatedByUser: true,
      },
      initialResponse: {
        messageId: 'response-1',
        conversationId: Constants.NEW_CONVO,
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        content: [],
      },
    }) as any;

  const createWrapper = () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

  it('does not queue title generation with a transient stream id before a real conversation exists', async () => {
    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(request.post).toHaveBeenCalledTimes(1);
    });

    expect(queueTitleGeneration).not.toHaveBeenCalled();
  });

  it('surfaces connected-account-required stream errors without queueing title generation', async () => {
    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(mockSSEInstances.length).toBeGreaterThan(0);
      expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1);
    });

    const latestStream = mockSSEInstances.at(-1);
    expect(latestStream).toBeDefined();

    act(() => {
      latestStream?.emit('error', {
        data: JSON.stringify({
          error: JSON.stringify({
            type: 'connected_account_required',
            provider: 'openai',
            message: 'Connect OpenAI first.',
          }),
        }),
      });
    });

    await waitFor(() => {
      expect(mockErrorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            text: expect.stringContaining('connected_account_required'),
          }),
        }),
      );
    });

    expect(latestStream?.close).toHaveBeenCalled();
    expect(queueTitleGeneration).not.toHaveBeenCalled();
    expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
  });
});
