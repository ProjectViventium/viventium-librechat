/* === VIVENTIUM START ===
 * Test: Cortex follow-up polling does not clobber in-flight streamed messages
 *
 * Purpose:
 * - Ensure our background-cortex polling never invalidates the messages query while a response is
 *   still streaming (which would drop the client-only placeholder `${userMessageId}_` and cause
 *   the latest assistant message to disappear/reappear).
 *
 * Added: 2026-02-08
 * === VIVENTIUM END === */

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, QueryKeys, ToolCallTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import useCortexFollowUpPoll from '~/hooks/Viventium/useCortexFollowUpPoll';

describe('useCortexFollowUpPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('avoids refetch-clobber during streaming (submitting) and resumes polling post-stream', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-1';
    const messages: TMessage[] = [
      {
        messageId: 'assistant-1',
        conversationId,
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: '',
        content: [
          {
            type: ContentTypes.CORTEX_BREWING,
            cortex_id: 'c1',
            cortex_name: 'Test Cortex',
            status: 'brewing',
            confidence: 0.9,
          } as any,
        ],
      } as any,
    ];

    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook(
      ({ isSubmitting }) => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting }),
      {
        wrapper,
        initialProps: { isSubmitting: true },
      },
    );

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      rerender({ isSubmitting: false });
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);
  });

  it('keeps polling long enough to surface delayed Phase B follow-up', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-delayed-followup';
    const activeMessage = {
      messageId: 'assistant-parent',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.CORTEX_BREWING,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'brewing',
          confidence: 0.91,
        } as any,
      ],
    } as any;
    const resolvedMessage = {
      messageId: 'assistant-parent',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: 'text', text: 'Phase A response.' }] as any,
    } as any;
    const followUpMessage = {
      messageId: 'assistant-followup',
      conversationId,
      parentMessageId: 'assistant-parent',
      isCreatedByUser: false,
      text: 'Phase B continuation',
      metadata: { viventium: { type: 'cortex_followup' } },
    } as any;

    let messages: TMessage[] = [activeMessage];
    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalled();

    // Simulate stream close + cache refresh dropping transient active state.
    messages = [resolvedMessage];
    invalidateSpy.mockClear();

    // Delayed follow-up (~50s) should still be discovered.
    act(() => {
      jest.advanceTimersByTime(50_000);
    });
    expect(invalidateSpy).toHaveBeenCalled();

    // Follow-up appears in DB/query payload; polling should stop.
    messages = [resolvedMessage, followUpMessage];
    const callsBeforeFollowUpStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeFollowUpStop);
  });

  it('keeps polling through the grace window after the parent resolves before a follow-up arrives', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-resolved-parent-grace';
    const activeMessage = {
      messageId: 'assistant-parent',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.CORTEX_BREWING,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'brewing',
          confidence: 0.91,
        } as any,
      ],
    } as any;
    const resolvedParent = {
      messageId: 'assistant-parent',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      unfinished: false,
      text: 'Phase A response.',
      content: [
        { type: ContentTypes.TEXT, text: 'Phase A response.' },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.91,
          insight: 'One completed insight.',
        } as any,
      ] as any,
    } as any;
    const followUpMessage = {
      messageId: 'assistant-followup',
      conversationId,
      parentMessageId: 'assistant-parent',
      isCreatedByUser: false,
      text: 'Phase B continuation',
      metadata: { viventium: { type: 'cortex_followup' } },
    } as any;

    let messages: TMessage[] = [activeMessage];
    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalled();

    messages = [resolvedParent];
    invalidateSpy.mockClear();

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);

    messages = [resolvedParent, followUpMessage];
    const callsBeforeFollowUpStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeFollowUpStop);
  });

  it('does not treat an older follow-up as completion for the current cortex cycle', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-with-old-followup';
    const olderParent = {
      messageId: 'assistant-old-parent',
      conversationId,
      parentMessageId: 'user-old',
      isCreatedByUser: false,
      text: 'Old main response',
      content: [{ type: 'text', text: 'Old main response' }] as any,
    } as any;
    const olderFollowUp = {
      messageId: 'assistant-old-followup',
      conversationId,
      parentMessageId: 'assistant-old-parent',
      isCreatedByUser: false,
      text: 'Old follow-up',
      metadata: { viventium: { type: 'cortex_followup' } },
    } as any;
    const activeCurrent = {
      messageId: 'assistant-current-parent',
      conversationId,
      parentMessageId: 'user-current',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.CORTEX_BREWING,
          cortex_id: 'ms365',
          cortex_name: 'MS365',
          status: 'brewing',
          confidence: 0.98,
        } as any,
      ],
    } as any;
    const resolvedCurrent = {
      messageId: 'assistant-current-parent',
      conversationId,
      parentMessageId: 'user-current',
      isCreatedByUser: false,
      text: 'Checking now.',
      content: [{ type: 'text', text: 'Checking now.' }] as any,
    } as any;

    let messages: TMessage[] = [olderParent, olderFollowUp, activeCurrent];
    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalled();

    messages = [olderParent, olderFollowUp, resolvedCurrent];
    invalidateSpy.mockClear();

    act(() => {
      jest.advanceTimersByTime(45_000);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);
  });

  it('stops polling only when follow-up for the current parent appears', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-parent-scoped-followup';
    const olderParent = {
      messageId: 'assistant-old-parent',
      conversationId,
      parentMessageId: 'user-old',
      isCreatedByUser: false,
      text: 'Older main response',
      content: [{ type: 'text', text: 'Older main response' }] as any,
    } as any;
    const olderFollowUp = {
      messageId: 'assistant-old-followup',
      conversationId,
      parentMessageId: 'assistant-old-parent',
      isCreatedByUser: false,
      text: 'Older follow-up',
      metadata: { viventium: { type: 'cortex_followup' } },
    } as any;
    const activeCurrent = {
      messageId: 'assistant-current-parent',
      conversationId,
      parentMessageId: 'user-current',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.CORTEX_ACTIVATION,
          cortex_id: 'ms365',
          cortex_name: 'MS365',
          status: 'activating',
          confidence: 0.99,
        } as any,
      ],
    } as any;
    const resolvedCurrent = {
      messageId: 'assistant-current-parent',
      conversationId,
      parentMessageId: 'user-current',
      isCreatedByUser: false,
      text: 'Checking now.',
      content: [{ type: 'text', text: 'Checking now.' }] as any,
    } as any;
    const currentFollowUp = {
      messageId: 'assistant-current-followup',
      conversationId,
      parentMessageId: 'assistant-current-parent',
      isCreatedByUser: false,
      text: 'Current follow-up',
      metadata: { viventium: { type: 'cortex_followup' } },
    } as any;

    let messages: TMessage[] = [olderParent, olderFollowUp, activeCurrent];
    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });

    messages = [olderParent, olderFollowUp, resolvedCurrent];
    invalidateSpy.mockClear();

    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(invalidateSpy).toHaveBeenCalled();

    const callsBeforeStop = invalidateSpy.mock.calls.length;
    messages = [olderParent, olderFollowUp, resolvedCurrent, currentFollowUp];

    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeStop);
  });

  it('stops polling after the grace window when no follow-up arrives', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-no-followup';
    const activeMessage = {
      messageId: 'assistant-active',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.CORTEX_ACTIVATION,
          cortex_id: 'c1',
          cortex_name: 'Pattern Recognition',
          status: 'activating',
          confidence: 0.8,
        } as any,
      ],
    } as any;
    const resolvedMessage = {
      messageId: 'assistant-resolved',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: 'text', text: 'Phase A response.' }] as any,
    } as any;

    let messages: TMessage[] = [activeMessage];
    const getMessages = () => messages;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    messages = [resolvedMessage];
    invalidateSpy.mockClear();

    // Entire grace window + one extra interval.
    act(() => {
      jest.advanceTimersByTime(181_500);
    });
    const callsAtGraceEnd = invalidateSpy.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtGraceEnd);
  });

  it('arms grace polling when latest message has cortex parts but no active statuses', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-complete-only';
    const latestMessage = {
      messageId: 'assistant-complete',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.9,
          insight: 'Done.',
        } as any,
      ],
    } as any;

    const getMessages = () => [latestMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);
  });

  it('arms grace polling when the newest cache row is a user message but the latest cortex message is earlier', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-user-row-last';
    const assistantMessage = {
      messageId: 'assistant-complete',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      unfinished: false,
      text: 'Phase A response.',
      createdAt: new Date().toISOString(),
      content: [
        { type: ContentTypes.TEXT, text: 'Phase A response.' },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.9,
          insight: 'Done.',
        } as any,
      ] as any,
    } as any;
    const userMessage = {
      messageId: 'user-1',
      conversationId,
      parentMessageId: 'root',
      isCreatedByUser: true,
      text: 'what is your top advice for me to build wealth in one short line answer',
      createdAt: new Date(Date.now() + 1000).toISOString(),
      content: [{ type: ContentTypes.TEXT, text: 'question' }] as any,
    } as any;

    const getMessages = () => [assistantMessage, userMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);
  });

  it('polls after a recent tool-using response so out-of-band callbacks can appear live', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Started.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_worker_run',
            name: 'worker_run_mcp_glasshive-workers-projects',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"state":"queued"}',
          },
        },
        { type: ContentTypes.TEXT, text: 'Started.' },
      ] as any,
    } as any;

    const getMessages = () => [assistantMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);
  });

  it('does not arm GlassHive callback polling for ordinary non-GlassHive tools', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-ordinary-tool';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Found it.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_web_search',
            name: 'web_search',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"ok":true}',
          },
        },
        { type: ContentTypes.TEXT, text: 'Found it.' },
      ] as any,
    } as any;

    const getMessages = () => [assistantMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('uses startup config to bound web GlassHive callback polling', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-configured-grace';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Started.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_worker_run',
            name: 'worker_run_mcp_glasshive-workers-projects',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"state":"queued"}',
          },
        },
      ] as any,
    } as any;

    const getMessages = () => [assistantMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy.mock.calls.length).toBe(2);

    const callsAtConfiguredGraceEnd = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(4500);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtConfiguredGraceEnd);
  });

  it('keeps tool callback polling after a non-terminal callback for that assistant appears', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-started';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Started.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_worker_run',
            name: 'worker_run_mcp_glasshive-workers-projects',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"state":"queued"}',
          },
        },
      ] as any,
    } as any;
    const callbackMessage = {
      messageId: 'assistant-tool-callback',
      conversationId,
      parentMessageId: 'assistant-tool-owner',
      isCreatedByUser: false,
      text: 'Done.',
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          anchorMessageId: 'assistant-tool-owner',
          event: 'run.started',
          events: [{ event: 'run.started' }],
        },
      },
    } as any;

    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);

    messages = [assistantMessage, callbackMessage] as TMessage[];
    const callsBeforeStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsBeforeStop);
  });

  it('stops tool callback polling after a terminal callback for that assistant appears', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-terminal';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Started.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_worker_run',
            name: 'worker_run_mcp_glasshive-workers-projects',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"state":"queued"}',
          },
        },
      ] as any,
    } as any;
    const callbackMessage = {
      messageId: 'assistant-tool-callback',
      conversationId,
      parentMessageId: 'assistant-tool-owner',
      isCreatedByUser: false,
      text: 'Done.',
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          anchorMessageId: 'assistant-tool-owner',
          event: 'run.completed',
          events: [{ event: 'run.started' }, { event: 'run.completed' }],
        },
      },
    } as any;

    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);

    messages = [assistantMessage, callbackMessage] as TMessage[];
    const callsBeforeStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeStop);
  });

  it('stops tool callback polling after a checkpoint callback that needs user action', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-checkpoint';
    const assistantMessage = {
      messageId: 'assistant-tool-owner',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Started.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'toolu_worker_run',
            name: 'worker_run_mcp_glasshive-workers-projects',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"state":"queued"}',
          },
        },
      ] as any,
    } as any;
    const callbackMessage = {
      messageId: 'assistant-tool-callback',
      conversationId,
      parentMessageId: 'assistant-tool-owner',
      isCreatedByUser: false,
      text: 'I need your approval to continue.',
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          anchorMessageId: 'assistant-tool-owner',
          event: 'checkpoint.ready',
          events: [{ event: 'run.started' }, { event: 'checkpoint.ready' }],
        },
      },
    } as any;

    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId]);

    messages = [assistantMessage, callbackMessage] as TMessage[];
    const callsBeforeStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeStop);
  });
});
