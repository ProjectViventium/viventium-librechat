/**
 * === VIVENTIUM START ===
 * Feature: Voice readiness and privacy guard.
 * Purpose: Voice-disabled installs must not expose a working-looking call action.
 * === VIVENTIUM END ===
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CallButton from './CallButton';

const mockUseGetStartupConfig = jest.fn();
const mockFetch = jest.fn();

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => (key === 'com_ui_voice_settings' ? 'Voice settings' : key),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => ({ agent_id: 'agent_fixture', conversationId: 'conversation_fixture' }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationByIndex: () => 'conversation-state' },
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'browser-token-fixture' }),
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
  () => ({
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  }),
  { virtual: true },
);

jest.mock('~/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

function renderCallButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CallButton />
    </QueryClientProvider>,
  );
}

describe('CallButton voice readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGetStartupConfig.mockReturnValue({ data: { viventiumVoiceEnabled: true } });
    global.fetch = mockFetch as unknown as typeof fetch;
    window.open = jest.fn(
      () =>
        ({
          closed: false,
          close: jest.fn(),
          focus: jest.fn(),
          location: { replace: jest.fn() },
        }) as unknown as Window,
    );
  });

  it.each([
    ['missing startup metadata', {}],
    ['explicitly disabled Voice', { viventiumVoiceEnabled: false }],
  ])('hides the call action for %s', (_label, startupConfig) => {
    mockUseGetStartupConfig.mockReturnValue({ data: startupConfig });

    renderCallButton();

    expect(screen.queryByRole('button', { name: 'Start voice call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Voice settings' })).not.toBeInTheDocument();
  });

  it('shows the call action only when Voice is explicitly enabled', () => {
    renderCallButton();

    expect(screen.getByRole('button', { name: 'Start voice call' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Voice settings' })).toBeInTheDocument();
  });

  it('opens the authorized call setup before manual start and preserves the signed launch', async () => {
    const launchUrl =
      'https://calls.example.com/call-bootstrap?callSessionId=call-fixture&autoConnect=1&conversationId=conversation-fixture#viventiumCallLaunch=synthetic-launch';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ callSessionId: 'call-fixture', playgroundUrl: launchUrl }),
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }));

    const popup = (window.open as jest.Mock).mock.results[0].value;
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
    const openedUrl = new URL(popup.location.replace.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('autoConnect')).toBe('0');
    expect(openedUrl.searchParams.get('callSessionId')).toBe('call-fixture');
    expect(openedUrl.searchParams.get('conversationId')).toBe('conversation-fixture');
    expect(openedUrl.hash).toBe('#viventiumCallLaunch=synthetic-launch');
    expect(screen.getByRole('button', { name: 'Close voice settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End voice call' })).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith('/api/viventium/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-token-fixture',
      },
      body: JSON.stringify({ conversationId: 'conversation_fixture', agentId: 'agent_fixture' }),
    });
    expect((window.open as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockFetch.mock.invocationCallOrder[0],
    );
    expect(screen.queryByRole('button', { name: 'Voice settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close voice settings' })).toBeInTheDocument();

    mockFetch.mockResolvedValue({ ok: false, status: 410 });
    fireEvent.click(screen.getByRole('button', { name: 'Close voice settings' }));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/viventium/calls/call-fixture/end',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer browser-token-fixture' },
          keepalive: true,
        }),
      ),
    );
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Voice settings' })).toBeInTheDocument();
  });

  it('saves call choices as defaults only after the user requests it', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ callSessionId: 'call-fixture', playgroundUrl: 'https://calls.example.com/?callSessionId=call-fixture' }) });
    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }));
    const save = await screen.findByRole('button', { name: 'Save these voice choices as my default' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      savedVoiceRoute: { stt: { provider: 'assemblyai', variant: 'u3-rt-pro' },
        tts: { provider: 'xai', variant: 'Eve' } },
    }) });
    fireEvent.click(save);
    await screen.findByText('Voice defaults saved. Listening: assemblyai · u3-rt-pro. Speaking: xai · Eve.');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/viventium/calls/call-fixture/voice-defaults', {
      method: 'POST', headers: { Authorization: 'Bearer browser-token-fixture' },
    });
  });

  it('keeps the normal call start automatic', async () => {
    const launchUrl =
      'https://calls.example.com/call-bootstrap?callSessionId=call-fixture&autoConnect=1#viventiumCallLaunch=synthetic-launch';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ callSessionId: 'call-fixture', playgroundUrl: launchUrl }),
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));

    const popup = (window.open as jest.Mock).mock.results[0].value;
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(launchUrl));
  });

  it('uses the existing inline failure recovery for a settings launch', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ error: 'voice_runtime_not_ready', message: 'private fixture detail' }),
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Voice is still starting. Wait a moment, then try again.');
    expect(error).not.toHaveTextContent('private fixture detail');
    expect(screen.getByRole('button', { name: 'Voice settings' })).toHaveAttribute(
      'aria-describedby',
      error.id,
    );
    expect(screen.getByRole('button', { name: 'Retry voice call' })).toBeInTheDocument();
  });

  it('renders a structured runtime failure as concise inline recovery copy', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({
        error: 'voice_runtime_not_ready',
        reason: 'playground_identity_mismatch',
        message: '{"private":"raw server detail"}',
      }),
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(
      'Voice needs attention. Open Viventium from the menu bar, check Status, then try again.',
    );
    expect(error).not.toHaveTextContent('private');
    expect(screen.getByRole('button', { name: 'Retry voice call' })).toHaveAttribute(
      'aria-describedby',
      error.id,
    );
  });

  it('maps the structured missing-assistant error to actionable inline copy', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({
        error: 'voice_agent_required',
        message: 'raw implementation detail',
      }),
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Choose an assistant before starting Voice.');
    expect(error).not.toHaveTextContent('raw implementation detail');
  });

  it('falls back to safe recovery copy when the server does not return JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ 'Content-Type': 'text/html' }),
      json: async () => {
        throw new Error('not JSON');
      },
    });

    renderCallButton();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice call' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Voice could not start. Try again. If it keeps happening, check Viventium Status.',
      );
    });
  });
});
