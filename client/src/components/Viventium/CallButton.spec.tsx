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
    global.fetch = jest.fn();
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
  });

  it('shows the call action only when Voice is explicitly enabled', () => {
    renderCallButton();

    expect(screen.getByRole('button', { name: 'Start voice call' })).toBeInTheDocument();
  });

  it('renders a structured runtime failure as concise inline recovery copy', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
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
    (global.fetch as jest.Mock).mockResolvedValue({
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
    (global.fetch as jest.Mock).mockResolvedValue({
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
