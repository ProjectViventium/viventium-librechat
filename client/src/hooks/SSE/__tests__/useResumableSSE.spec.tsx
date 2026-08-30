// VIVENTIUM START: verify durable Viventium SSE route and cache handoff behavior.
import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import { buildSubmissionFromResumeState } from '~/hooks/SSE/useResumeOnLoad';
import { Constants, ContentTypes, QueryKeys, request } from 'librechat-data-provider';
import { queueTitleGeneration } from '~/data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Agents, EventSubmission, TConversation, TMessage } from 'librechat-data-provider';

const mockErrorHandler = jest.fn();
let mockActiveJobIds: string[] = [];
let mockActiveStreams: Array<{ streamId: string; conversationId: string }> | undefined = [];
let mockActiveJobsDataUpdatedAt = 0;
const mockRecoilSetters = new Map<string, jest.Mock>();
const mockRefetchActiveJobs = jest.fn(async () => ({
  data: {
    activeJobIds: mockActiveJobIds,
    ...(mockActiveStreams ? { activeStreams: mockActiveStreams } : {}),
  },
  isSuccess: true,
}));
let observedEventSubmission: EventSubmission | undefined;
const mockSSEInstances: Array<{
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  headers: Record<string, unknown>;
  options: Record<string, unknown>;
  emit: (event: string, payload?: unknown) => void;
}> = [];

jest.mock('recoil', () => ({
  useSetRecoilState: (key: string) => {
    if (!mockRecoilSetters.has(key)) {
      mockRecoilSetters.set(key, jest.fn());
    }
    return mockRecoilSetters.get(key);
  },
}));

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation((_url, options) => {
    const listeners = new Map();
    const instance = {
      addEventListener: jest.fn((event, handler) => {
        listeners.set(event, handler);
      }),
      stream: jest.fn(),
      close: jest.fn(),
      headers: {},
      options,
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
  default: ({ setMessages, getMessages }) => ({
    stepHandler: jest.fn(),
    finalHandler: jest.fn((data, submission) => {
      if (data?.requestMessage && data?.responseMessage) {
        setMessages([...submission.messages, data.requestMessage, data.responseMessage]);
      } else if (data?.responseMessage) {
        setMessages([...(getMessages() ?? []), data.responseMessage]);
      }
    }),
    errorHandler: mockErrorHandler,
    clearStepMaps: jest.fn(),
    messageHandler: jest.fn(),
    contentHandler: jest.fn(({ data }) => {
      const messages = getMessages() ?? [];
      const responseIndex = messages.findIndex((message) => message.messageId === data.messageId);
      if (responseIndex < 0) {
        return;
      }
      const updated = [...messages];
      updated[responseIndex] = {
        ...updated[responseIndex],
        conversationId: data.conversationId,
        text: data.text,
        content: [{ type: data.type, [data.type]: data.text }],
      };
      setMessages(updated);
    }),
    createdHandler: jest.fn((_data, submission) => {
      observedEventSubmission = submission;
      const initialResponse = {
        ...submission.initialResponse,
        conversationId: submission.userMessage.conversationId,
        parentMessageId: submission.userMessage.messageId,
        messageId: `${submission.userMessage.messageId}_`,
      };
      setMessages([...(getMessages() ?? []), submission.userMessage, initialResponse]);
    }),
    syncStepMessage: jest.fn(),
    attachmentHandler: jest.fn(),
    resetContentHandler: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
  useActiveJobs: () => ({
    data: {
      activeJobIds: mockActiveJobIds,
      ...(mockActiveStreams ? { activeStreams: mockActiveStreams } : {}),
    },
    dataUpdatedAt: mockActiveJobsDataUpdatedAt,
    isSuccess: true,
    isFetching: false,
    refetch: mockRefetchActiveJobs,
  }),
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
  ContentTypes: { TEXT: 'text' },
  LocalStorageKeys: {
    TEXT_DRAFT: 'textDraft-',
    FILES_DRAFT: 'filesDraft-',
  },
  QueryKeys: {
    activeJobs: 'activeJobs',
    messages: 'messages',
  },
  ErrorTypes: {
    CONNECTED_ACCOUNT_REQUIRED: 'connected_account_required',
  },
  tMessageSchema: { parse: (value: unknown) => value },
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
    getMessages: jest.fn<TMessage[] | undefined, []>(() => []),
    setConversation: jest.fn(),
    setIsSubmitting: jest.fn(),
    newConversation: jest.fn(),
    resetLatestMessage: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveJobIds = [];
    mockActiveStreams = [];
    mockActiveJobsDataUpdatedAt = 0;
    observedEventSubmission = undefined;
    mockSSEInstances.length = 0;
    (request.post as jest.Mock).mockResolvedValue({ streamId: 'stream-1' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createSubmission = (): EventSubmission => ({
    conversation: { conversationId: String(Constants.NEW_CONVO) },
    userMessage: {
      messageId: 'user-1',
      parentMessageId: String(Constants.NO_PARENT),
      conversationId: String(Constants.NEW_CONVO),
      text: 'hello',
      isCreatedByUser: true,
    },
    initialResponse: {
      messageId: 'response-1',
      conversationId: String(Constants.NEW_CONVO),
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [],
    },
    endpointOption: { endpoint: null },
    isTemporary: false,
    messages: [],
  });

  const createWrapper = () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    return ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  };

  it('keeps the stream mounted when a new chat claims its canonical route', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-canonical',
      conversationId: 'conversation-canonical',
      logical_turn_id: 'turn-1',
      revision: 1,
    });
    mockRefetchActiveJobs.mockImplementationOnce(async () => {
      mockActiveJobIds = ['conversation-canonical'];
      mockActiveStreams = [
        { streamId: 'stream-canonical', conversationId: 'conversation-canonical' },
      ];
      return {
        data: { activeJobIds: mockActiveJobIds, activeStreams: mockActiveStreams },
        isSuccess: true,
      };
    });
    const submission = createSubmission();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    const StreamMount = ({
      setConversation,
    }: {
      setConversation: Dispatch<SetStateAction<TConversation | null>>;
    }) => {
      useResumableSSE(submission, {
        ...chatHelpers,
        setConversation,
      });
      return <div data-testid="stream-mounted" />;
    };

    const RouteBoundChat = () => {
      const { conversationId = '' } = useParams();
      const [conversation, setConversation] = useState<TConversation | null>({
        conversationId: String(Constants.NEW_CONVO),
      } as TConversation);
      const routeMatchesConversation = conversation?.conversationId === conversationId;

      return (
        <>
          <div data-testid="route-id">{conversationId}</div>
          {routeMatchesConversation ? (
            <StreamMount setConversation={setConversation} />
          ) : (
            <div data-testid="route-mismatch" />
          )}
        </>
      );
    };

    render(
      <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/c/:conversationId" element={<RouteBoundChat />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('route-id')).toHaveTextContent('conversation-canonical');
    });

    expect(screen.getByTestId('stream-mounted')).toBeInTheDocument();
    expect(screen.queryByTestId('route-mismatch')).not.toBeInTheDocument();
    expect(mockSSEInstances.at(-1)?.close).not.toHaveBeenCalled();
  });

  it('does not reclaim the canonical route after the user leaves during generation start', async () => {
    let resolveStart: ((receipt: { streamId: string; conversationId: string }) => void) | undefined;
    (request.post as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const submission = createSubmission();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    const PendingStart = () => {
      const navigate = useNavigate();
      useResumableSSE(submission, chatHelpers);
      return <button type="button" data-testid="leave-chat" onClick={() => navigate('/other')} />;
    };

    render(
      <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/c/:conversationId" element={<PendingStart />} />
            <Route path="/other" element={<div data-testid="other-route" />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId('leave-chat'));
    expect(screen.getByTestId('other-route')).toBeInTheDocument();

    await act(async () => {
      resolveStart?.({
        streamId: 'stream-after-leave',
        conversationId: 'conversation-after-leave',
      });
    });

    expect(screen.getByTestId('other-route')).toBeInTheDocument();
    expect(mockSSEInstances).toHaveLength(0);
  });

  it('does not queue title generation with a transient stream id before a real conversation exists', async () => {
    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(request.post).toHaveBeenCalledTimes(1);
    });

    expect(queueTitleGeneration).not.toHaveBeenCalled();
    expect(request.post).toHaveBeenCalledWith(
      '/api/agents/chat',
      expect.objectContaining({
        responseMessageId: expect.any(String),
        viventiumClientResponseMessageId: 'response-1',
      }),
    );
  });

  it('reuses one client-minted response id when the generation start POST is retried', async () => {
    jest.useFakeTimers();
    const networkError = Object.assign(new Error('network unavailable'), { code: 'ERR_NETWORK' });
    (request.post as jest.Mock)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ streamId: 'stream-after-retry' });

    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: createWrapper(),
    });

    expect(request.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    const generationCalls = (request.post as jest.Mock).mock.calls.filter(
      ([url]) => url === '/api/agents/chat',
    );
    expect(generationCalls.length).toBeGreaterThanOrEqual(2);

    const firstPayload = generationCalls[0][1];
    const secondPayload = generationCalls[1][1];
    expect(firstPayload.responseMessageId).toEqual(expect.any(String));
    expect(secondPayload.responseMessageId).toBe(firstPayload.responseMessageId);
  });

  it('binds the server-authored conversation before subscribing to a new stream', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-canonical',
      conversationId: 'conversation-canonical',
      logical_turn_id: 'turn-1',
      revision: 1,
    });

    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1);
      expect(chatHelpers.setConversation).toHaveBeenCalledTimes(1);
    });

    const updateConversation = chatHelpers.setConversation.mock.calls[0][0];
    expect(updateConversation({ conversationId: Constants.NEW_CONVO, title: 'New chat' })).toEqual({
      conversationId: 'conversation-canonical',
      title: 'New chat',
    });
  });

  it('preserves that a canonicalized submission started as a new chat', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-title-origin',
      conversationId: 'conversation-title-origin',
      logical_turn_id: 'turn-title-origin',
      revision: 1,
    });

    const submission = createSubmission();
    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mockSSEInstances.at(-1)?.emit('message', {
        data: JSON.stringify({
          created: true,
          message: {
            conversationId: 'conversation-title-origin',
            messageId: 'response-title-origin',
          },
        }),
      });
    });

    expect(observedEventSubmission).toEqual(
      expect.objectContaining({
        viventiumOriginalConversationId: Constants.NEW_CONVO,
        conversation: expect.objectContaining({
          conversationId: 'conversation-title-origin',
        }),
      }),
    );
  });

  it('renders CREATED and content events from the canonical message cache after new-chat settlement', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-canonical-cache',
      conversationId: 'conversation-canonical-cache',
      logical_turn_id: 'turn-canonical-cache',
      revision: 1,
    });
    const submission = createSubmission();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);

    // These helpers intentionally retain the route key that existed when the stream started.
    // The resumable stream must stop using them after the server settles the canonical route.
    const staleNewRouteHelpers = {
      ...chatHelpers,
      getMessages: () =>
        queryClient.getQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO]),
      setMessages: (messages: TMessage[]) =>
        queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], messages),
    };

    const CanonicalCacheView = () => {
      const { conversationId = '' } = useParams();
      const { data: messages = [] } = useQuery<TMessage[]>({
        queryKey: [QueryKeys.messages, conversationId],
        queryFn: async () => [],
        initialData: () =>
          queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]) ?? [],
      });
      const response = messages.find((message) => message.isCreatedByUser !== true);
      return (
        <>
          <div data-testid="canonical-cache-route">{conversationId}</div>
          <div data-testid="canonical-visible-response">{response?.text ?? ''}</div>
        </>
      );
    };

    const CanonicalStream = () => {
      useResumableSSE(submission, staleNewRouteHelpers);
      return <CanonicalCacheView />;
    };

    render(
      <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/c/:conversationId" element={<CanonicalStream />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('canonical-cache-route')).toHaveTextContent(
        'conversation-canonical-cache',
      );
      expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1);
    });

    const stream = mockSSEInstances.at(-1);
    act(() => {
      stream?.emit('message', {
        data: JSON.stringify({
          created: true,
          message: {
            ...submission.userMessage,
            messageId: 'canonical-user-message',
            conversationId: 'conversation-canonical-cache',
          },
        }),
      });
      stream?.emit('message', {
        data: JSON.stringify({
          type: 'text',
          text: 'Visible canonical stream content',
          index: 0,
          messageId: 'canonical-user-message_',
          conversationId: 'conversation-canonical-cache',
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('canonical-visible-response')).toHaveTextContent(
        'Visible canonical stream content',
      );
    });
    expect(
      queryClient.getQueryData<TMessage[]>([QueryKeys.messages, 'conversation-canonical-cache']),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: 'canonical-user-message_',
          text: 'Visible canonical stream content',
        }),
      ]),
    );
    expect(queryClient.getQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO])).toEqual(
      [],
    );
  });

  it('keeps a lost-response retry on the original canonical route and stream', async () => {
    jest.useFakeTimers();
    const networkError = Object.assign(new Error('network unavailable'), { code: 'ERR_NETWORK' });
    (request.post as jest.Mock).mockRejectedValueOnce(networkError).mockResolvedValueOnce({
      streamId: 'original-stream-before-lost-response',
      conversationId: 'original-canonical-conversation',
      status: 'duplicate',
      duplicate: true,
    });

    const RouteReceipt = () => {
      const { conversationId = '' } = useParams();
      useResumableSSE(createSubmission(), chatHelpers);
      return <div data-testid="lost-response-route">{conversationId}</div>;
    };

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/c/:conversationId" element={<RouteReceipt />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(request.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    const generationCalls = (request.post as jest.Mock).mock.calls.filter(
      ([url]) => url === '/api/agents/chat',
    );
    expect(generationCalls.length).toBeGreaterThanOrEqual(2);

    const firstPayload = generationCalls[0][1];
    const secondPayload = generationCalls[1][1];
    expect(firstPayload.responseMessageId).toEqual(expect.any(String));
    expect(secondPayload.responseMessageId).toBe(firstPayload.responseMessageId);
    expect(screen.getByTestId('lost-response-route')).toHaveTextContent(
      'original-canonical-conversation',
    );
    expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1);
    expect(mockSSEInstances.at(-1)?.close).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('surfaces connected-account-required stream errors without queueing title generation', async () => {
    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: createWrapper(),
    });

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
    expect(mockRecoilSetters.get('show-stop')).toHaveBeenCalledWith(false);
  });

  it('repairs canonical messages when a reconnect learns the completed stream was deleted', async () => {
    mockActiveJobIds = ['conversation-canonical'];
    mockActiveStreams = [
      { streamId: 'stream-completed', conversationId: 'conversation-canonical' },
    ];
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-completed',
      conversationId: 'conversation-canonical',
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </MemoryRouter>
      ),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    const completedStream = mockSSEInstances[0];
    completedStream?.close.mockClear();
    invalidateQueries.mockClear();

    await act(async () => {
      completedStream?.emit('error', { responseCode: 404 });
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, 'conversation-canonical'],
        exact: true,
      });
    });
    expect(invalidateQueries.mock.invocationCallOrder[0]).toBeLessThan(
      completedStream?.close.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(mockRecoilSetters.get('show-stop')).toHaveBeenCalledWith(false);
  });

  it('removes only the unfinished assistant draft when a revision is superseded', async () => {
    const user = createSubmission().userMessage;
    const draft = createSubmission().initialResponse;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], [user, draft]);
    renderHook(() => useResumableSSE(createSubmission(), chatHelpers), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </MemoryRouter>
      ),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    const latestStream = mockSSEInstances.at(-1);
    act(() => {
      latestStream?.emit('message', {
        data: JSON.stringify({ final: true, superseded: true, revision: 1 }),
      });
    });

    expect(queryClient.getQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO])).toEqual(
      [user],
    );
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(latestStream?.close).toHaveBeenCalled();
  });

  it('owns terminal UI cleanup when the final frame is received', async () => {
    mockActiveJobIds = ['stream-1'];
    mockActiveStreams = [{ streamId: 'stream-1', conversationId: 'stream-1' }];
    const submission = createSubmission();
    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    act(() => {
      mockSSEInstances.at(-1)?.emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: Constants.NEW_CONVO },
          requestMessage: createSubmission().userMessage,
          responseMessage: createSubmission().initialResponse,
        }),
      });
    });

    expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
  });

  it('projects one authoritative branch through reconnect SYNC and FINAL', async () => {
    const priorUser = {
      messageId: 'prior-user',
      parentMessageId: String(Constants.NO_PARENT),
      conversationId: 'conversation-resume',
      text: 'prior',
      isCreatedByUser: true,
    } as TMessage;
    const priorResponse = {
      messageId: 'prior-response',
      parentMessageId: 'prior-user',
      conversationId: 'conversation-resume',
      text: 'prior answer',
      isCreatedByUser: false,
    } as TMessage;
    const optimisticUser = {
      messageId: 'client-user',
      parentMessageId: 'prior-response',
      conversationId: 'conversation-resume',
      text: 'synthetic prompt',
      isCreatedByUser: true,
    } as TMessage;
    const optimisticResponse = {
      messageId: 'client-user_',
      parentMessageId: 'client-user',
      conversationId: 'conversation-resume',
      text: '',
      content: [],
      isCreatedByUser: false,
    } as TMessage;
    const authoritativeUser = {
      messageId: 'server-user',
      parentMessageId: 'prior-response',
      conversationId: 'conversation-resume',
      text: 'synthetic prompt',
      isCreatedByUser: true,
    } as TMessage;
    const authoritativeResponse = {
      messageId: 'server-response',
      parentMessageId: 'server-user',
      conversationId: 'conversation-resume',
      text: 'authoritative answer',
      content: [{ type: 'text', text: 'authoritative answer' }],
      isCreatedByUser: false,
    } as TMessage;
    const state: Agents.ResumeState = {
      runSteps: [],
      aggregatedContent: [{ type: ContentTypes.TEXT, text: 'authoritative partial' }],
      userMessage: {
        messageId: 'server-user',
        parentMessageId: 'prior-response',
        conversationId: 'conversation-resume',
        text: 'synthetic prompt',
      },
      responseMessageId: 'server-response',
      clientPresentation: {
        mode: 'append',
        userMessageId: 'client-user',
        responseMessageId: 'client-user_',
        targetUserMessageId: 'client-user',
      },
      conversationId: 'conversation-resume',
    } as Agents.ResumeState;
    const resumeSubmission = buildSubmissionFromResumeState(
      state,
      'stream-resume',
      [priorUser, priorResponse, optimisticUser, optimisticResponse],
      'conversation-resume',
    );
    let currentMessages = [priorUser, priorResponse, optimisticUser, optimisticResponse];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, 'conversation-resume'],
      currentMessages,
    );
    const resumeHelpers = {
      ...chatHelpers,
      getMessages: () => currentMessages,
      setMessages: (messages: TMessage[]) => {
        currentMessages = messages;
      },
    };

    renderHook(() => useResumableSSE(resumeSubmission, resumeHelpers), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/c/conversation-resume']}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </MemoryRouter>
      ),
    });
    await waitFor(() => expect(mockSSEInstances.at(-1)?.stream).toHaveBeenCalledTimes(1));

    // Model a canonical message refetch winning the race before SYNC arrives.
    currentMessages = [priorUser, priorResponse, authoritativeUser, authoritativeResponse];
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, 'conversation-resume'],
      currentMessages,
    );

    act(() => {
      mockSSEInstances.at(-1)?.emit('message', {
        data: JSON.stringify({ sync: true, resumeState: state }),
      });
    });
    expect(
      queryClient
        .getQueryData<TMessage[]>([QueryKeys.messages, 'conversation-resume'])
        ?.map((item) => item.messageId),
    ).toEqual(['prior-user', 'prior-response', 'server-user', 'server-response']);

    act(() => {
      mockSSEInstances.at(-1)?.emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: 'conversation-resume' },
          requestMessage: authoritativeUser,
          responseMessage: authoritativeResponse,
        }),
      });
    });
    expect(
      queryClient
        .getQueryData<TMessage[]>([QueryKeys.messages, 'conversation-resume'])
        ?.map((item) => item.messageId),
    ).toEqual(['prior-user', 'prior-response', 'server-user', 'server-response']);
  });

  it('attaches terminal handlers before starting the SSE transport', async () => {
    const submission = createSubmission();
    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));

    const stream = mockSSEInstances.at(-1);
    expect(stream?.options).toMatchObject({ start: false });
    expect(stream?.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(stream?.stream).toHaveBeenCalledTimes(1);
    expect(stream?.addEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      stream?.stream.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('clears a lost-final Stop state when the claimed job leaves the active registry', async () => {
    mockActiveJobIds = ['conversation-canonical'];
    mockActiveStreams = [
      { streamId: 'stream-1', conversationId: 'conversation-canonical' },
      { streamId: 'stream-2', conversationId: 'conversation-canonical' },
    ];
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-1',
      conversationId: 'conversation-canonical',
    });
    const submission = createSubmission();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`/c/${Constants.NEW_CONVO}`]}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </MemoryRouter>
      ),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRefetchActiveJobs).toHaveBeenCalled());
    chatHelpers.setIsSubmitting.mockClear();

    mockActiveJobIds = ['conversation-canonical'];
    mockActiveStreams = [{ streamId: 'stream-2', conversationId: 'conversation-canonical' }];
    rerender();

    await waitFor(() => {
      expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
    });
    expect(mockRecoilSetters.get('show-stop')).toHaveBeenCalledWith(false);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, 'conversation-canonical'],
      exact: true,
    });
  });

  it('does not settle a verified stream when exact active-stream authority disappears', async () => {
    mockActiveJobIds = ['conversation-canonical'];
    mockActiveStreams = [{ streamId: 'stream-1', conversationId: 'conversation-canonical' }];
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-1',
      conversationId: 'conversation-canonical',
    });
    const submission = createSubmission();
    const { rerender } = renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRefetchActiveJobs).toHaveBeenCalled());
    chatHelpers.setIsSubmitting.mockClear();

    mockActiveStreams = undefined;
    rerender();

    await act(async () => {
      await Promise.resolve();
    });
    expect(chatHelpers.setIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(mockRecoilSetters.get('show-stop')).not.toHaveBeenCalledWith(false);
  });

  it('does not settle a new stream from an initially empty active-jobs response', async () => {
    mockActiveJobIds = [];
    mockActiveStreams = [];
    mockRefetchActiveJobs.mockImplementationOnce(async () => {
      mockActiveJobIds = ['stream-1'];
      mockActiveStreams = [{ streamId: 'stream-1', conversationId: 'stream-1' }];
      return {
        data: { activeJobIds: mockActiveJobIds, activeStreams: mockActiveStreams },
        isSuccess: true,
      };
    });
    const submission = createSubmission();
    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockSSEInstances.length).toBeGreaterThan(0));
    chatHelpers.setIsSubmitting.mockClear();

    await act(async () => {
      await Promise.resolve();
    });

    expect(chatHelpers.setIsSubmitting).not.toHaveBeenCalledWith(false);
  });

  it('does not treat a failed active-registry refresh as terminal proof', async () => {
    mockRefetchActiveJobs.mockResolvedValueOnce({
      data: { activeJobIds: [], activeStreams: [] },
      isSuccess: false,
    });
    const submission = createSubmission();
    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockRefetchActiveJobs).toHaveBeenCalled());
    chatHelpers.setIsSubmitting.mockClear();

    await act(async () => {
      await Promise.resolve();
    });

    expect(chatHelpers.setIsSubmitting).not.toHaveBeenCalledWith(false);
  });

  it('recovers after a failed registry probe and later authoritative poll', async () => {
    mockRefetchActiveJobs.mockResolvedValueOnce({
      data: { activeJobIds: [], activeStreams: [] },
      isSuccess: false,
    });
    (request.post as jest.Mock).mockResolvedValueOnce({
      streamId: 'stream-1',
      conversationId: 'conversation-canonical',
    });
    const submission = createSubmission();
    const { rerender } = renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(mockRefetchActiveJobs).toHaveBeenCalled());
    chatHelpers.setIsSubmitting.mockClear();

    mockActiveJobIds = ['conversation-canonical'];
    mockActiveStreams = [{ streamId: 'stream-1', conversationId: 'conversation-canonical' }];
    mockActiveJobsDataUpdatedAt = 1;
    rerender();
    expect(chatHelpers.setIsSubmitting).not.toHaveBeenCalledWith(false);

    mockActiveJobIds = [];
    mockActiveStreams = [];
    mockActiveJobsDataUpdatedAt = 2;
    rerender();

    await waitFor(() => {
      expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
    });
    expect(mockRecoilSetters.get('show-stop')).toHaveBeenCalledWith(false);
  });
});
// VIVENTIUM END
