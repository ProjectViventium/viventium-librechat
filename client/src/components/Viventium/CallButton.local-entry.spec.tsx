/** @jest-environment @happy-dom/jest-environment */
/* === VIVENTIUM START ===
 * A local navigation hint may focus Call, but must not create a call or start the microphone.
 * === VIVENTIUM END === */
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CallButton from './CallButton';

const mockFetch = jest.fn();
let mockToken = 'synthetic-owner-token';
let mockVoiceEnabled = true;
let mockAgentId = 'agent_fixture';
const launchUrl =
  'http://localhost:3300/call-bootstrap?callSessionId=call-fixture&autoConnect=1&conversationId=conversation_fixture#viventiumCallLaunch=synthetic-launch';

jest.mock('recoil', () => ({
  useRecoilValue: () => ({ agent_id: mockAgentId, conversationId: 'conversation_fixture' }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationByIndex: () => 'conversation-state' },
}));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ token: mockToken }) }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { viventiumVoiceEnabled: mockVoiceEnabled } }),
}));
jest.mock('librechat-data-provider', () => ({
  request: { refreshToken: jest.fn(), dispatchTokenUpdatedEvent: jest.fn() },
  QueryKeys: {
    messages: 'messages',
    conversation: 'conversation',
    allConversations: 'allConversations',
  },
}));
jest.mock(
  '@librechat/client',
  () => ({ TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</> }),
  { virtual: true },
);
jest.mock('~/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));

function renderCall(strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => {
    const content = (
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <CallButton />
        </BrowserRouter>
      </QueryClientProvider>
    );
    return strict ? <React.StrictMode>{content}</React.StrictMode> : content;
  };
  const result = render(tree());
  return { ...result, refresh: () => result.rerender(tree()) };
}

function successfulCall() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ callSessionId: 'call-fixture', playgroundUrl: launchUrl }),
  };
}

describe('Call on this Mac entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockToken = 'synthetic-owner-token';
    mockVoiceEnabled = true;
    mockAgentId = 'agent_fixture';
    window.location.href =
      'http://localhost:3080/c/conversation_fixture?viventiumCall=1&keep=value';
    global.fetch = mockFetch as typeof fetch;
    mockFetch.mockResolvedValue(successfulCall());
    window.open = jest.fn(() => ({
      closed: false,
      close: jest.fn(),
      focus: jest.fn(),
      location: { replace: jest.fn() },
    }));
    jest.spyOn(window.location, 'replace').mockImplementation(() => {});
  });

  afterEach(() => {
    window.location.href = 'http://localhost:3080/';
  });

  it('focuses the normal Call action without creating a call or starting audio', () => {
    renderCall();
    expect(screen.getByRole('button', { name: 'Start voice call' })).toHaveFocus();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).has('viventiumCall')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('value');
  });

  it('uses normal authorized signed call creation only after an actual user gesture', async () => {
    renderCall();
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));
    const popup = (window.open as jest.Mock).mock.results[0].value;
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(launchUrl));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/viventium/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer synthetic-owner-token',
      },
      body: JSON.stringify({ conversationId: 'conversation_fixture', agentId: 'agent_fixture' }),
    });
    expect((window.open as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockFetch.mock.invocationCallOrder[0],
    );
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('lets Enter on the focused normal Call button start the authorized call', async () => {
    renderCall();
    expect(mockFetch).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    const popup = (window.open as jest.Mock).mock.results[0].value;
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(launchUrl));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('consumes focus once through StrictMode effects and later renders without call side effects', () => {
    const view = renderCall(true);
    expect(screen.getByRole('button', { name: 'Start voice call' })).toHaveFocus();
    view.refresh();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('does not restore the consumed hint or create a call after reload', () => {
    const view = renderCall();
    view.unmount();
    renderCall();
    expect(new URLSearchParams(window.location.search).has('viventiumCall')).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('waits for normal login before focusing the action', () => {
    mockToken = '';
    const view = renderCall();
    expect(new URLSearchParams(window.location.search).get('viventiumCall')).toBe('1');
    mockToken = 'synthetic-owner-token';
    view.refresh();
    expect(screen.getByRole('button', { name: 'Start voice call' })).toHaveFocus();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('waits for the configured Voice capability and conversation agent', () => {
    mockVoiceEnabled = false;
    mockAgentId = '';
    const view = renderCall();
    expect(mockFetch).not.toHaveBeenCalled();
    mockVoiceEnabled = true;
    view.refresh();
    expect(new URLSearchParams(window.location.search).get('viventiumCall')).toBe('1');
    mockAgentId = 'agent_fixture';
    view.refresh();
    expect(screen.getByRole('button', { name: 'Start voice call' })).toHaveFocus();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '[::1]'])(
    'focuses Call on loopback %s without treating navigation as authority',
    (host) => {
      window.location.href = `http://${host}:3080/c/conversation_fixture?viventiumCall=1`;
      renderCall();
      expect(screen.getByRole('button', { name: 'Start voice call' })).toHaveFocus();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it('does not use the local navigation hint on a public origin', () => {
    window.location.href = 'https://chat.example.test/c/conversation_fixture?viventiumCall=1';
    renderCall();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start voice call' })).not.toHaveFocus();
  });

  it.each(['', '?viventiumCall=0'])(
    'does not start a call without an explicit gesture: %s',
    (search) => {
      window.location.href = `http://localhost:3080/c/conversation_fixture${search}`;
      renderCall();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it('keeps runtime failure recovery behind explicit user actions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({
        error: 'voice_runtime_not_ready',
        reason: 'playground_identity_mismatch',
      }),
    });
    const view = renderCall();
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));
    await screen.findByRole('alert');
    view.refresh();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(window.location.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry voice call' }));
    const popup = (window.open as jest.Mock).mock.results[1].value;
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(launchUrl));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(window.open).toHaveBeenCalledTimes(2);
  });
});
