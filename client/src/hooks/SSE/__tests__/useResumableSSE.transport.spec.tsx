// VIVENTIUM START: verify durable Viventium SSE route and cache handoff behavior.
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import { QueryKeys, request } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TMessage, TSubmission } from 'librechat-data-provider';

const mockErrorHandler = jest.fn();
let mockActiveJobIds: string[] = [];
let mockActiveStreams: Array<{ streamId: string; conversationId: string }> | undefined = [];
let mockActiveJobsDataUpdatedAt = 0;
let mockActiveJobsSuccess = true;
const mockRecoilSetters = new Map<string, jest.Mock>();
const mockRefetchActiveJobs = jest.fn(async () => ({
  data: {
    activeJobIds: mockActiveJobIds,
    ...(mockActiveStreams ? { activeStreams: mockActiveStreams } : {}),
  },
  isSuccess: true,
}));
type TestXHR = {
  status: number;
  responseText: string;
  response: string;
  fire: (event: string) => void;
};
type TestSSE = {
  xhr: TestXHR | null;
  readyState: number;
  url: string;
  headers: Record<string, string>;
};
const mockSSEInstances: TestSSE[] = [];

jest.mock('recoil', () => ({
  useSetRecoilState: (key: string) => {
    if (!mockRecoilSetters.has(key)) {
      mockRecoilSetters.set(key, jest.fn());
    }
    return mockRecoilSetters.get(key);
  },
}));

jest.mock('sse.js', () => {
  const source = jest
    .requireActual<typeof import('fs')>('fs')
    .readFileSync(require.resolve('sse.js'), 'utf8');
  const NativeSSE = new Function(
    'CustomEvent',
    'XMLHttpRequest',
    source.replace('export { SSE };', 'return SSE;'),
  )(
    CustomEvent,
    class {
      status = 200;
      readyState = 3;
      responseText = '';
      response = '';
      listeners = new Map();
      addEventListener(name, callback) {
        this.listeners.set(name, callback);
      }

      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        this.listeners.get('abort')?.({ currentTarget: this });
      }

      getAllResponseHeaders() {
        return '';
      }

      fire(name) {
        this.listeners.get(name)?.({ currentTarget: this });
      }
    },
  );
  return {
    SSE: Object.assign(
      jest.fn().mockImplementation((url, options) => {
        const instance = new NativeSSE(url, options);
        mockSSEInstances.push(instance);
        return instance;
      }),
      { CLOSED: NativeSSE.CLOSED },
    ),
  };
});

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
    isSuccess: mockActiveJobsSuccess,
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

describe('actual installed SSE transport with current resumable hook', () => {
  const helpers = {
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
    mockActiveJobIds = ['conversation-native'];
    mockActiveStreams = undefined; // Actual current host exposes only this legacy registry shape.
    mockActiveJobsDataUpdatedAt = 1;
    mockActiveJobsSuccess = true;
  });
  afterEach(() => jest.useRealTimers());
  async function mount(mode: 'fresh' | 'resume' = 'resume') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const submission = {
      conversation: { conversationId: mode === 'fresh' ? 'new' : 'conversation-native' },
      userMessage: {
        messageId: 'user-native',
        conversationId: 'conversation-native',
        text: 'Synthetic request',
        isCreatedByUser: true,
      },
      initialResponse: {
        messageId: 'response-native',
        parentMessageId: 'user-native',
        text: '',
        content: [],
        isCreatedByUser: false,
      },
      endpointOption: {},
      messages: [],
      ...(mode === 'resume' ? { resumeStreamId: 'stream-native' } : {}),
    } as TSubmission;
    if (mode === 'fresh') {
      (request.post as jest.Mock).mockResolvedValueOnce({
        streamId: 'stream-native',
        conversationId: 'conversation-native',
      });
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
    const hook = renderHook(() => useResumableSSE(submission, helpers), { wrapper });
    await waitFor(() => expect(mockSSEInstances).toHaveLength(1));
    const sse = mockSSEInstances[0];
    act(() => sse.xhr!.fire('readystatechange'));
    queryClient.setQueryData(
      [QueryKeys.messages, 'conversation-native'],
      [submission.userMessage, submission.initialResponse],
    );
    return { ...hook, sse, queryClient, submission };
  }
  it.each(['fresh', 'resume'] as const)(
    'settles a canonical error FINAL on the %s transport without losing the prompt',
    async (mode) => {
      const { sse, queryClient, submission } = await mount(mode);
      const requestMessage = { ...submission.userMessage, conversationId: 'conversation-native' };
      const responseMessage = {
        ...submission.initialResponse,
        conversationId: 'conversation-native',
        error: true,
        unfinished: false,
        finish_reason: 'incomplete',
        content: [{ type: 'error', error: 'The response could not be completed.' }],
      };
      const xhr = sse.xhr!;
      act(() => {
        xhr.responseText = `data: ${JSON.stringify({
          final: true,
          conversation: { conversationId: 'conversation-native' },
          requestMessage,
          responseMessage,
        })}\n\n`;
        xhr.fire('load');
      });
      expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false);
      expect(mockRecoilSetters.get('show-stop')).toHaveBeenLastCalledWith(false);
      expect(sse.xhr).toBeNull();
      expect(mockErrorHandler).not.toHaveBeenCalled();
      expect(queryClient.getQueryData([QueryKeys.messages, 'conversation-native'])).toEqual([
        requestMessage,
        responseMessage,
      ]);
      expect(requestMessage.text).toBe('Synthetic request');
      expect(request.post).toHaveBeenCalledTimes(mode === 'fresh' ? 1 : 0);
    },
  );
  it('reconnects after successful HTTP EOF without a terminal frame', async () => {
    const { sse } = await mount();
    jest.useFakeTimers();
    act(() => sse.xhr!.fire('load'));
    expect(sse.readyState).toBe(2);
    act(() => jest.advanceTimersByTime(35_000));
    expect(mockSSEInstances.length).toBeGreaterThan(1);
    expect(mockErrorHandler).not.toHaveBeenCalled();
  });
  it('treats an XHR network failure with buffered SSE bytes as transport loss', async () => {
    const { sse } = await mount();
    jest.useFakeTimers();
    const xhr = sse.xhr!;
    xhr.status = 0;
    xhr.response = 'data: {"sync":true,"resumeState":{"aggregatedContent":[]}}\n\n';
    act(() => xhr.fire('error'));
    act(() => jest.advanceTimersByTime(1000));
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSSEInstances).toHaveLength(2);
  });
  it('keeps the accepted pair after retry exhaustion and resumes on a fresh exact registry result', async () => {
    mockActiveStreams = [{ streamId: 'stream-native', conversationId: 'conversation-native' }];
    const { rerender, queryClient } = await mount();
    jest.useFakeTimers();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 0]) {
      const current = mockSSEInstances.at(-1)!;
      current.xhr!.status = 0;
      act(() => current.xhr!.fire('error'));
      act(() => jest.advanceTimersByTime(delay));
    }
    expect(mockSSEInstances).toHaveLength(6);
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(
      (queryClient.getQueryData([QueryKeys.messages, 'conversation-native']) as TMessage[]).map(
        (m) => m.messageId,
      ),
    ).toEqual(['user-native', 'response-native']);
    rerender();
    expect(mockSSEInstances).toHaveLength(6); // Stale successful cache cannot restart exhausted retries.
    mockActiveJobsDataUpdatedAt = Date.now() + 1;
    rerender();
    expect(mockSSEInstances).toHaveLength(7);
    const resumed = mockSSEInstances.at(-1)!;
    expect(resumed.url).toContain('?resume=true');
    act(() => {
      resumed.xhr!.responseText =
        'data: {"final":true,"requestMessage":{"messageId":"user-native","text":"Synthetic request","isCreatedByUser":true},"responseMessage":{"messageId":"response-native","parentMessageId":"user-native","text":"Accepted answer"}}\n\n';
      resumed.xhr!.fire('load');
    });
    expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false);
    const messages = queryClient.getQueryData([
      QueryKeys.messages,
      'conversation-native',
    ]) as TMessage[];
    expect(messages.map((m) => m.messageId)).toEqual(['user-native', 'response-native']);
    expect(messages[1].text).toBe('Accepted answer');
    expect(request.post).not.toHaveBeenCalled();
  });
  it('waits through registry failure and reconciles only a successful exact empty result', async () => {
    mockActiveStreams = [{ streamId: 'stream-native', conversationId: 'conversation-native' }];
    const { rerender, queryClient } = await mount();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    mockActiveStreams = [];
    mockActiveJobsSuccess = false;
    rerender();
    expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(true);
    expect(invalidate).not.toHaveBeenCalled();
    mockActiveJobsSuccess = true;
    mockActiveJobsDataUpdatedAt = Date.now() + 1;
    rerender();
    expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, 'conversation-native'],
      exact: true,
    });
    expect(request.post).not.toHaveBeenCalled();
  });
  it('refreshes a 401 once without scheduling a parallel transport reconnect', async () => {
    const { sse } = await mount();
    jest.useFakeTimers();
    (request.refreshToken as jest.Mock).mockResolvedValueOnce({ token: 'refreshed-token' });
    sse.xhr!.status = 401;
    await act(async () => sse.xhr!.fire('error'));
    act(() => jest.advanceTimersByTime(35000));
    expect(request.refreshToken).toHaveBeenCalledTimes(1);
    expect(mockSSEInstances).toHaveLength(1);
    expect(sse.headers.Authorization).toBe('Bearer refreshed-token');
  });
  it('does not reopen a navigated stream when token refresh resolves late', async () => {
    const { sse, unmount } = await mount();
    let resolveRefresh!: (value: { token: string }) => void;
    (request.refreshToken as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    sse.xhr!.status = 401;
    act(() => sse.xhr!.fire('error'));
    unmount();
    await act(async () => resolveRefresh({ token: 'refreshed-token' }));
    expect(sse.xhr).toBeNull();
  });
  it('does not reconnect after intentional navigation close', async () => {
    const { unmount } = await mount();
    jest.useFakeTimers();
    unmount();
    act(() => jest.advanceTimersByTime(35000));
    expect(mockSSEInstances).toHaveLength(1);
  });
  it('preserves a real server-sent error as terminal error', async () => {
    const { sse } = await mount();
    jest.useFakeTimers();
    sse.xhr!.responseText = 'event: error\ndata: {"error":"synthetic-request-rejected"}\n\n';
    act(() => sse.xhr!.fire('load'));
    expect(mockErrorHandler).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(35000));
    expect(mockSSEInstances).toHaveLength(1);
  });
  it('does not reconnect after an authoritative FINAL', async () => {
    const { sse } = await mount();
    jest.useFakeTimers();
    const xhr = sse.xhr!;
    xhr.responseText =
      'data: {"final":true,"responseMessage":{"messageId":"response-native","text":"Accepted answer"}}\n\n';
    act(() => xhr.fire('load'));
    act(() => jest.advanceTimersByTime(35000));
    expect(mockSSEInstances).toHaveLength(1);
    expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false);
  });
});
