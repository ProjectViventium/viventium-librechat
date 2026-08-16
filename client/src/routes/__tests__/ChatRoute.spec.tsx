/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
} from 'react-router-dom';
import ChatRoute from '../ChatRoute';

if (typeof Request === 'undefined') {
  global.Request = class Request {
    constructor(
      public url: string,
      public init?: RequestInit,
    ) {}
  } as any;
}

const TARGET_CONVERSATION_ID = 'conversation-target';

type Conversation = {
  conversationId: string;
  title?: string;
};

const mockHasSetConversation = { current: false };
const mockNewConversation = jest.fn();
const mockShowToast = jest.fn();
const mockIsNotFoundError = jest.fn(() => false);
const mockStartupConfig = { interface: {} };
const mockEndpointsData = { agents: {} };
const mockModelsData = { openAI: ['test-model'] };
const mockUser = { id: 'synthetic-user' };
const mockRoles = { USER: true };
const mockAssistantListMap = {
  assistants: new Map(),
  azureAssistants: new Map(),
};
const mockPersistedContent = [
  {
    type: 'cortex_insight',
    cortex_id: 'reality-check',
    cortex_name: 'Reality check',
    status: 'complete',
    insight: 'The degraded search response must be described honestly.',
  },
  {
    type: 'tool_call',
    agentId: 'agent-main',
    tool_call: {
      id: 'transfer-main-to-reality',
      name: 'lc_transfer_to_agent-reality',
      args: '{"task":"Verify the evidence"}',
      output: 'Transferred',
    },
  },
  {
    type: 'harness_activity',
    agentId: 'agent-reality',
    harness_activity: {
      event: 'started',
      summary: 'Reality inspected the persisted provider evidence.',
    },
  },
  {
    type: 'text',
    agentId: 'agent-reality',
    text: 'Reality: the provider returned a rate-limit failure.',
  },
  {
    type: 'tool_call',
    agentId: 'agent-reality',
    tool_call: {
      id: 'transfer-reality-to-main',
      name: 'lc_transfer_to_agent-main',
      args: '{"finding":"Report the rate limit without fallback claims"}',
      output: 'Transferred',
    },
  },
  {
    type: 'harness_activity',
    agentId: 'agent-main',
    harness_activity: {
      event: 'completed',
      summary: 'Main incorporated Reality’s finding.',
    },
  },
  {
    type: 'text',
    agentId: 'agent-main',
    text: 'Main: search is temporarily rate limited; no hidden fallback was used.',
  },
];

const mockRouteState: {
  conversation: Conversation | null;
  initialConvoQuery: {
    data?: Conversation;
    isLoading: boolean;
    isError: boolean;
    error?: unknown;
  };
} = {
  conversation: null,
  initialConvoQuery: {
    data: undefined,
    isLoading: true,
    isError: false,
  },
};

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(() => false),
  useRecoilCallback: jest.fn(() => jest.fn()),
}));

jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="loading-spinner" />,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({
    data: mockModelsData,
    isLoading: false,
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useGetEndpointsQuery: () => ({ data: mockEndpointsData, isLoading: false }),
  useGetConvoIdQuery: () => mockRouteState.initialConvoQuery,
}));

jest.mock('~/hooks', () => ({
  useAppStartup: jest.fn(),
  useAssistantListMap: () => mockAssistantListMap,
  useIdChangeEffect: jest.fn(),
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));

jest.mock('~/utils', () => ({
  getDefaultModelSpec: jest.fn(() => ({})),
  getModelSpecPreset: jest.fn(),
  processValidSettings: jest.fn(() => ({})),
  logger: { log: jest.fn() },
  isNotFoundError: (error: unknown) => mockIsNotFoundError(error),
  mapAttachments: jest.fn(() => ({})),
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

jest.mock('~/Providers', () => {
  const React = jest.requireActual('react');
  return {
    MessageContext: React.createContext({}),
    SearchContext: React.createContext({}),
    ToolCallsMapProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

jest.mock('~/components/Chat/Messages/Content/Part', () => ({
  __esModule: true,
  default: ({ part }: { part: Record<string, any> }) => {
    const type = part.type ?? 'unknown';
    const detail =
      part.text ??
      part.cortex_name ??
      part.harness_activity?.summary ??
      part.tool_call?.name ??
      type;
    if (type === 'harness_activity') {
      const HarnessActivity = jest.requireActual(
        '~/components/Chat/Messages/Content/HarnessActivity',
      ).default;
      return (
        <div data-part-type={type} data-agent-id={part.agentId ?? ''}>
          <HarnessActivity
            event={part.harness_activity.event}
            summary={part.harness_activity.summary}
            isSubmitting={false}
          />
        </div>
      );
    }
    if (type === 'tool_call' || type === 'cortex_insight') {
      return (
        <details data-part-type={type} data-agent-id={part.agentId ?? ''}>
          <summary>{detail}</summary>
          <div>{detail}</div>
        </details>
      );
    }
    return (
      <div data-part-type={type} data-agent-id={part.agentId ?? ''}>
        {detail}
      </div>
    );
  },
}));

jest.mock('~/components/Chat/Messages/Content/MemoryArtifacts', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Web/Sources', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Chat/ChatView', () => ({
  __esModule: true,
  default: () => {
    const React = jest.requireActual('react');
    const ContentParts = jest.requireActual(
      '~/components/Chat/Messages/Content/ContentParts',
    ).default;
    return React.createElement(
      'div',
      { 'data-testid': 'chat-view' },
      React.createElement(ContentParts, {
        content: mockPersistedContent,
        messageId: 'assistant-terminal',
        messageAgentId: 'agent-main',
        conversationId: TARGET_CONVERSATION_ID,
        isCreatedByUser: false,
        isLast: true,
        isSubmitting: false,
        isLatestMessage: true,
      }),
    );
  },
}));

jest.mock('../useAuthRedirect', () => ({
  __esModule: true,
  default: () => ({
    isAuthenticated: true,
    user: mockUser,
    roles: mockRoles,
  }),
}));

jest.mock('~/store/temporary', () => ({
  __esModule: true,
  default: {
    defaultTemporaryChat: {},
    isTemporary: {},
  },
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    useCreateConversationAtom: () => ({
      hasSetConversation: mockHasSetConversation,
      conversation: mockRouteState.conversation,
    }),
  },
}));

function renderConversationRoute(conversationId = TARGET_CONVERSATION_ID) {
  return render(
    <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
      <Routes>
        <Route path="/c/:conversationId" element={<ChatRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute exact persisted-conversation settlement', () => {
  beforeEach(() => {
    mockNewConversation.mockReset();
    mockShowToast.mockReset();
    mockIsNotFoundError.mockReset();
    mockIsNotFoundError.mockReturnValue(false);
    mockHasSetConversation.current = false;
    mockRouteState.conversation = null;
    mockRouteState.initialConvoQuery = {
      data: undefined,
      isLoading: true,
      isError: false,
    };
  });

  it('waits for the exact-route query instead of initializing from ready assistant maps', async () => {
    const view = renderConversationRoute();

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockHasSetConversation.current).toBe(false);
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();

    mockRouteState.initialConvoQuery = {
      data: {
        conversationId: 'conversation-from-stale-query',
        title: 'Stale persisted conversation',
      },
      isLoading: false,
      isError: false,
    };

    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={[`/c/${TARGET_CONVERSATION_ID}`]}>
          <Routes>
            <Route path="/c/:conversationId" element={<ChatRoute />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockHasSetConversation.current).toBe(false);

    const persistedConversation = {
      conversationId: TARGET_CONVERSATION_ID,
      title: 'Persisted terminal Agents conversation',
    };
    mockRouteState.initialConvoQuery = {
      data: persistedConversation,
      isLoading: false,
      isError: false,
    };

    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={[`/c/${TARGET_CONVERSATION_ID}`]}>
          <Routes>
            <Route path="/c/:conversationId" element={<ChatRoute />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        template: persistedConversation,
        preset: persistedConversation,
        keepLatestMessage: true,
      }),
    );
    expect(mockHasSetConversation.current).toBe(true);
  });

  it('does not render a stale non-null conversation under a different route', () => {
    mockHasSetConversation.current = true;
    mockRouteState.conversation = { conversationId: 'conversation-stale' };
    mockRouteState.initialConvoQuery = {
      data: undefined,
      isLoading: false,
      isError: false,
    };

    renderConversationRoute();

    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('renders a terminal mixed-part Agents answer on direct route, detail expansion, and refresh', () => {
    const persistedConversation = {
      conversationId: TARGET_CONVERSATION_ID,
      title: 'Persisted terminal Agents conversation',
    };
    mockNewConversation.mockImplementation(({ template }: { template?: Conversation }) => {
      if (template?.conversationId === TARGET_CONVERSATION_ID) {
        mockRouteState.conversation = template;
      }
    });

    const firstView = renderConversationRoute();
    expect(screen.queryByText(/^Main: search is temporarily rate limited/)).toBeNull();

    mockRouteState.initialConvoQuery = {
      data: persistedConversation,
      isLoading: false,
      isError: false,
    };

    firstView.rerender(
      <MemoryRouter initialEntries={[`/c/${TARGET_CONVERSATION_ID}`]}>
        <Routes>
          <Route path="/c/:conversationId" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    firstView.rerender(
      <MemoryRouter initialEntries={[`/c/${TARGET_CONVERSATION_ID}`]}>
        <Routes>
          <Route path="/c/:conversationId" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    const expectedPartOrder = [
      'cortex_insight',
      'tool_call',
      'harness_activity',
      'text',
      'tool_call',
      'harness_activity',
      'text',
    ];
    expect(
      Array.from(document.querySelectorAll('[data-part-type]')).map((element) =>
        element.getAttribute('data-part-type'),
      ),
    ).toEqual(expectedPartOrder);
    expect(screen.getByText(/^Main: search is temporarily rate limited/)).toHaveAttribute(
      'data-agent-id',
      'agent-main',
    );

    const harnessDetail = screen
      .getByText('Main incorporated Reality’s finding.', { selector: 'li' })
      .closest('details');
    expect(harnessDetail).not.toBeNull();
    fireEvent.click(harnessDetail!.querySelector('summary')!);
    expect(harnessDetail).toHaveAttribute('open');

    firstView.unmount();
    mockHasSetConversation.current = false;
    mockRouteState.conversation = null;
    mockRouteState.initialConvoQuery = {
      data: persistedConversation,
      isLoading: false,
      isError: false,
    };
    const refreshedView = renderConversationRoute();
    expect(screen.queryByText(/^Main: search is temporarily rate limited/)).toBeNull();

    refreshedView.rerender(
      <MemoryRouter initialEntries={[`/c/${TARGET_CONVERSATION_ID}`]}>
        <Routes>
          <Route path="/c/:conversationId" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/^Main: search is temporarily rate limited/)).toHaveAttribute(
      'data-agent-id',
      'agent-main',
    );
  });

  it('applies an already resolved exact query during a real A-to-B route transition', async () => {
    const firstConversation = { conversationId: 'conversation-a' };
    const nextConversation = {
      conversationId: TARGET_CONVERSATION_ID,
      title: 'Resolved conversation B',
    };
    mockHasSetConversation.current = true;
    mockRouteState.conversation = firstConversation;
    mockRouteState.initialConvoQuery = {
      data: nextConversation,
      isLoading: false,
      isError: false,
    };
    mockNewConversation.mockImplementation(({ template }: { template?: Conversation }) => {
      if (template?.conversationId === TARGET_CONVERSATION_ID) {
        mockRouteState.conversation = template;
      }
    });

    const router = createMemoryRouter(
      [{ path: '/c/:conversationId', element: <ChatRoute /> }],
      { initialEntries: ['/c/conversation-a'] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();

    mockHasSetConversation.current = false;
    await act(async () => {
      await router.navigate(`/c/${TARGET_CONVERSATION_ID}`);
    });

    expect(mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ template: nextConversation }),
    );
    expect(mockHasSetConversation.current).toBe(true);
    await act(async () => {
      await router.navigate(`/c/${TARGET_CONVERSATION_ID}?settled=true`, { replace: true });
    });
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  });

  it('preserves new-conversation initialization at /c/new', () => {
    mockNewConversation.mockImplementation(() => {
      mockRouteState.conversation = { conversationId: 'new' };
    });

    const view = renderConversationRoute('new');
    view.rerender(
      <MemoryRouter initialEntries={['/c/new']}>
        <Routes>
          <Route path="/c/:conversationId" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ template: undefined }),
    );
    expect(mockHasSetConversation.current).toBe(true);
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  });

  it('preserves the explicit not-found recovery branch', () => {
    const notFoundError = { response: { status: 404 } };
    mockRouteState.initialConvoQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: notFoundError,
    };
    mockIsNotFoundError.mockImplementation((error) => error === notFoundError);

    const router = createMemoryRouter(
      [{ path: '/c/:conversationId', element: <ChatRoute /> }],
      { initialEntries: [`/c/${TARGET_CONVERSATION_ID}`] },
    );
    mockNewConversation.mockImplementation(() => {
      mockRouteState.conversation = { conversationId: 'new' };
      void router.navigate('/c/new');
    });
    const view = render(<RouterProvider router={router} />);
    view.rerender(<RouterProvider router={router} />);

    expect(mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ modelsData: mockModelsData }),
    );
    expect(mockHasSetConversation.current).toBe(true);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_conversation_not_found' }),
    );
    expect(router.state.location.pathname).toBe('/c/new');
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  });
});
