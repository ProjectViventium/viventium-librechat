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
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ContentTypes, QueryKeys, ToolCallTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type {
  ActiveWorkSnapshot,
  WorkSummary,
} from '~/data-provider/ViventiumOrchestration/queries';
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
  });

  it('keeps polling long enough to surface delayed Phase B follow-up', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 60,
    });
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
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 30,
    });
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });

    messages = [resolvedParent, followUpMessage];
    const callsBeforeFollowUpStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeFollowUpStop);
  });

  it('does not treat an older follow-up as completion for the current cortex cycle', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 60,
    });
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
  });

  it('stops polling only when follow-up for the current parent appears', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 30,
    });
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

  it('receives a real late cortex completion after the short Phase B grace expires', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 30 });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'late-result';
    let messages = [
      {
        messageId: 'parent',
        conversationId,
        isCreatedByUser: false,
        createdAt: new Date().toISOString(),
        text: 'Main has answered.',
        content: [
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'specialist', status: 'brewing' },
        ],
      },
    ] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => {
      jest.advanceTimersByTime(4 * 60 * 1000);
    });
    invalidateSpy.mockClear();
    act(() => {
      jest.advanceTimersByTime(12_000);
    });
    expect(invalidateSpy).toHaveBeenCalled();
    expect(invalidateSpy.mock.calls.length).toBeLessThanOrEqual(2);
    messages = [
      {
        ...messages[0],
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'specialist',
            cortex_name: 'Specialist',
            status: 'complete',
            insight: 'New source evidence.',
          },
        ],
        metadata: { viventium: { cortexFollowUpDecision: { result: 'suppressed' } } },
      },
    ] as TMessage[];
    invalidateSpy.mockClear();
    act(() => {
      jest.advanceTimersByTime(45_000);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('stops polling after the grace window when no follow-up arrives', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 3,
    });
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

    // Entire configured listening window + one extra interval.
    act(() => {
      jest.advanceTimersByTime(4500);
    });
    const callsAtGraceEnd = invalidateSpy.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtGraceEnd);
  });

  it('uses the configured background follow-up window instead of a client-only 180-second grace', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-configured-background-window';
    const activeMessage = {
      messageId: 'assistant-active',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Phase A response.',
      content: [
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.8,
        } as any,
      ],
    } as any;

    const getMessages = () => [activeMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    const callsAtConfiguredWindowEnd = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtConfiguredWindowEnd);
  });

  it('does not rearm an expired target during a later unrelated submission', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-expired-target-does-not-rearm';
    const oldActiveMessage = {
      messageId: 'assistant-old',
      conversationId,
      parentMessageId: 'user-old',
      isCreatedByUser: false,
      text: 'Earlier response.',
      content: [
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.8,
        } as any,
      ],
    } as any;

    const getMessages = () => [oldActiveMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook(
      ({ isSubmitting }) => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting }),
      {
        wrapper,
        initialProps: { isSubmitting: false },
      },
    );

    act(() => {
      jest.advanceTimersByTime(4500);
    });
    const callsAtWindowEnd = invalidateSpy.mock.calls.length;

    act(() => {
      rerender({ isSubmitting: true });
    });
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    act(() => {
      rerender({ isSubmitting: false });
    });
    act(() => {
      jest.advanceTimersByTime(6000);
    });

    expect(invalidateSpy.mock.calls.length).toBe(callsAtWindowEnd);
  });

  it('performs only one catch-up poll when background follow-up startup config is unavailable', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-missing-background-window';
    const activeMessage = {
      messageId: 'assistant-active',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Phase A response.',
      content: [
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.8,
        } as any,
      ],
    } as any;

    const getMessages = () => [activeMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit zero background follow-up window without a catch-up poll', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 0,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-disabled-background-window';
    const activeMessage = {
      messageId: 'assistant-active',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Phase A response.',
      content: [
        {
          type: ContentTypes.CORTEX_BREWING,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'brewing',
          confidence: 0.8,
        } as any,
      ],
    } as any;

    const getMessages = () => [activeMessage] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it.each(['suppressed', 'empty', 'skipped'])(
    'stops polling on a durable %s Phase B decision',
    (result) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData([QueryKeys.startupConfig], {
        viventiumBackgroundFollowupWindowS: 30,
      });
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const conversationId = `conv-terminal-${result}`;
      const activeMessage = {
        messageId: 'assistant-parent',
        conversationId,
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: 'Phase A response.',
        content: [
          {
            type: ContentTypes.CORTEX_BREWING,
            cortex_id: 'c1',
            cortex_name: 'Strategic Planning',
            status: 'brewing',
            confidence: 0.8,
          } as any,
        ],
      } as any;
      const resolvedMessage = {
        ...activeMessage,
        content: [
          { type: ContentTypes.TEXT, text: 'Phase A response.' },
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'c1',
            cortex_name: 'Strategic Planning',
            status: 'complete',
            confidence: 0.8,
            insight: '',
          } as any,
        ],
        metadata: {
          viventium: {
            cortexFollowUpDecision: { result },
          },
        },
      } as any;

      let messages = [activeMessage] as TMessage[];
      const getMessages = () => messages;
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );

      renderHook(
        () => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }),
        { wrapper },
      );

      act(() => {
        jest.advanceTimersByTime(1500);
      });
      expect(invalidateSpy).toHaveBeenCalledTimes(1);

      messages = [resolvedMessage] as TMessage[];
      const callsBeforeTerminalDecision = invalidateSpy.mock.calls.length;
      act(() => {
        jest.advanceTimersByTime(15_000);
      });
      expect(invalidateSpy.mock.calls.length).toBe(callsBeforeTerminalDecision);
    },
  );

  it('keeps polling after a persisted decision until its visible follow-up arrives', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 30,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-persisted-decision-race';
    const activeMessage = {
      messageId: 'assistant-parent',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Phase A response.',
      content: [
        {
          type: ContentTypes.CORTEX_BREWING,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'brewing',
          confidence: 0.8,
        } as any,
      ],
    } as any;
    const resolvedMessage = {
      ...activeMessage,
      content: [
        { type: ContentTypes.TEXT, text: 'Phase A response.' },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.8,
          insight: 'New useful evidence.',
        } as any,
      ],
      metadata: {
        viventium: {
          cortexFollowUpDecision: { result: 'persisted' },
        },
      },
    } as any;
    const followUpMessage = {
      messageId: 'assistant-followup',
      conversationId,
      parentMessageId: 'assistant-parent',
      isCreatedByUser: false,
      text: 'A visible follow-up.',
      metadata: {
        viventium: {
          type: 'cortex_followup',
          parentMessageId: 'assistant-parent',
        },
      },
    } as any;

    let messages = [activeMessage] as TMessage[];
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
    messages = [resolvedMessage] as TMessage[];
    const callsBeforePersistedDecision = invalidateSpy.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsBeforePersistedDecision);

    messages = [resolvedMessage, followUpMessage] as TMessage[];
    const callsBeforeVisibleFollowUp = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeVisibleFollowUp);
  });

  it('stops polling when Phase B was promoted onto the empty parent', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumBackgroundFollowupWindowS: 30,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-promoted-parent';
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
          confidence: 0.8,
        } as any,
      ],
    } as any;
    const promotedMessage = {
      ...activeMessage,
      text: 'Recovered visible answer.',
      content: [
        { type: ContentTypes.TEXT, text: 'Recovered visible answer.' },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'c1',
          cortex_name: 'Strategic Planning',
          status: 'complete',
          confidence: 0.8,
          insight: 'Recovered evidence.',
        } as any,
      ],
      metadata: {
        viventium: {
          type: 'cortex_followup',
          promotedToEmptyParent: true,
          cortexFollowUpDecision: { result: 'persisted' },
        },
      },
    } as any;

    let messages = [activeMessage] as TMessage[];
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
    messages = [promotedMessage] as TMessage[];
    const callsBeforePromotion = invalidateSpy.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforePromotion);
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
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

  it('does not arm polling for a completed connected tool without the deferred-callback anchor', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-ordinary-connected-tool';
    const assistantMessage = {
      messageId: 'assistant-harness-ordinary',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Checked.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'tool',
            summary: 'Connected tool completed: feelings get state.',
            tool: 'connected_tool',
            task: 'feelings get state',
            status: 'completed',
          },
        },
        { type: ContentTypes.TEXT, text: 'Checked.' },
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

  it('arms polling for a completed connected tool that carries the typed deferred-callback anchor', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-deferred-connected-tool';
    const assistantMessage = {
      messageId: 'assistant-harness-deferred',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Delegated.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'tool',
            summary: 'Connected tool completed: worker delegate once.',
            tool: 'connected_tool',
            task: 'worker delegate once',
            status: 'completed',
            expects_deferred_callback: true,
          },
        },
        { type: ContentTypes.TEXT, text: 'Delegated.' },
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
  });

  it('arms polling for an anchored connected tool that reports no status (claude harness shape)', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-anchor-no-status';
    const assistantMessage = {
      messageId: 'assistant-anchor-no-status',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'Delegated.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'tool',
            summary: 'The harness used a connected tool.',
            tool: 'connected_tool',
            expects_deferred_callback: true,
          },
        },
        { type: ContentTypes.TEXT, text: 'Delegated.' },
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
  });

  it('does not arm polling for an anchored connected tool the harness already reported failed', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-anchor-failed';
    const assistantMessage = {
      messageId: 'assistant-anchor-failed',
      conversationId,
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'That failed.',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'tool',
            summary: 'Connected tool failed: worker delegate once.',
            tool: 'connected_tool',
            task: 'worker delegate once',
            status: 'failed',
            expects_deferred_callback: true,
          },
        },
        { type: ContentTypes.TEXT, text: 'That failed.' },
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

  it('uses startup config to bound the fast web GlassHive callback polling window', () => {
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(invalidateSpy.mock.calls.length).toBe(2);

    const callsAtConfiguredGraceEnd = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(4500);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtConfiguredGraceEnd);

    // The anchor is still live (no callback persisted yet), so listening does not go dark after
    // the configured window; it continues at the slower cadence (next refetch at t=13.5s).
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAtConfiguredGraceEnd + 1);
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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });

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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });

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
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });

    messages = [assistantMessage, callbackMessage] as TMessage[];
    const callsBeforeStop = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeStop);
  });

  function glassHiveToolCallMessage(conversationId: string) {
    return {
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
  }

  function glassHiveCallbackMessage(
    conversationId: string,
    { event, state }: { event: string; state: string },
  ) {
    return {
      messageId: 'assistant-tool-callback',
      conversationId,
      parentMessageId: 'assistant-tool-owner',
      isCreatedByUser: false,
      text: 'Mission status.',
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          anchorMessageId: 'assistant-tool-owner',
          event,
          events: [{ event }],
          status: { kind: 'mission_status', state, attention: null },
        },
      },
    } as any;
  }

  it('keeps polling past the grace window while the latest callback state is still running', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-long-running';
    const messages = [
      glassHiveToolCallMessage(conversationId),
      glassHiveCallbackMessage(conversationId, { event: 'run.started', state: 'running' }),
    ] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(4500);
    });
    const callsAtGraceEnd = invalidateSpy.mock.calls.length;
    expect(callsAtGraceEnd).toBe(2);

    // Previously the target expired here and the delivered result never refetched.
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAtGraceEnd);
    expect(invalidateSpy).toHaveBeenLastCalledWith(
      [QueryKeys.messages, conversationId],
      undefined,
      { cancelRefetch: false },
    );
  });

  it('polls at a slower cadence after the grace window while no terminal callback exists', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-slow-cadence';
    // No callback persisted at all yet: the Worker may still be queued behind capacity.
    const messages = [glassHiveToolCallMessage(conversationId)] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    // Fast cadence inside the 3s window: ticks at 1.5s and 3.0s both refetch.
    act(() => {
      jest.advanceTimersByTime(4500);
    });
    expect(invalidateSpy.mock.calls.length).toBe(2);

    // Slow cadence afterwards: one refetch per >=10s (ticks at 13.5s, 24s, 34.5s), not per 1.5s.
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(5);
  });

  it('stops slow polling once a terminal callback for that assistant is persisted', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const conversationId = 'conv-tool-callback-slow-terminal';
    const assistantMessage = glassHiveToolCallMessage(conversationId);
    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    const callsBeforeTerminal = invalidateSpy.mock.calls.length;
    expect(callsBeforeTerminal).toBe(3);

    messages = [
      assistantMessage,
      glassHiveCallbackMessage(conversationId, { event: 'run.completed', state: 'completed' }),
    ] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsBeforeTerminal);
  });
  it('keeps slow polling after terminal callbacks until the Phase B follow-up for that turn appears', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
      viventiumBackgroundFollowupWindowS: 120,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'conv-tool-callback-terminal-followup';
    const assistantMessage = glassHiveToolCallMessage(conversationId);
    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    messages = [
      assistantMessage,
      glassHiveCallbackMessage(conversationId, { event: 'run.completed', state: 'completed' }),
    ] as TMessage[];
    const callsAtTerminal = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    // The Worker result is terminal, but Main's follow-up text is still being authored: keep
    // refreshing at the slow cadence so it can appear live.
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAtTerminal);
    messages = [
      ...messages,
      {
        messageId: 'phase-b-followup',
        conversationId,
        parentMessageId: 'assistant-tool-callback',
        isCreatedByUser: false,
        text: 'Worker finished: the card is ready.',
        metadata: {
          viventium: {
            type: 'cortex_followup',
            parentMessageId: assistantMessage.messageId,
          },
        },
      } as any,
    ] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    const callsAfterFollowUp = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterFollowUp);
  });

  it('stops slow polling after terminal callbacks once the background follow-up window elapses', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
      viventiumBackgroundFollowupWindowS: 60,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'conv-tool-callback-terminal-window';
    const assistantMessage = glassHiveToolCallMessage(conversationId);
    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    messages = [
      assistantMessage,
      glassHiveCallbackMessage(conversationId, { event: 'run.failed', state: 'failed' }),
    ] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(75_000);
    });
    const callsAfterWindow = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterWindow);
  });
  it('keeps listening while sibling Workers still run after one sibling is terminal', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], {
      viventiumGlassHiveFollowupTimeoutS: 3,
      viventiumBackgroundFollowupWindowS: 60,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'conv-tool-callback-siblings';
    const assistantMessage = glassHiveToolCallMessage(conversationId);
    const siblingCallback = (messageId: string, event: string, state: string) => ({
      ...glassHiveCallbackMessage(conversationId, { event, state }),
      messageId,
    });
    let messages = [assistantMessage] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    // The fast sibling finishes first; the callbacks seen so far are all terminal.
    messages = [
      assistantMessage,
      siblingCallback('callback-a', 'run.completed', 'completed'),
    ] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(50_000);
    });
    // A slower sibling reports in as still running: listening continues past the first window.
    messages = [...messages, siblingCallback('callback-b', 'run.started', 'running')] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    const callsAfterSibling = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(40_000);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAfterSibling);
    // The slower sibling finishes: the bounded window restarts from this change, so its result
    // and Main's follow-up can still arrive live before listening ends.
    messages = [
      assistantMessage,
      siblingCallback('callback-a', 'run.completed', 'completed'),
      siblingCallback('callback-b', 'run.completed', 'completed'),
    ] as TMessage[];
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    const callsAfterAllTerminal = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAfterAllTerminal);
    act(() => {
      jest.advanceTimersByTime(80_000);
    });
    const callsAfterWindow = invalidateSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterWindow);
  });

  it.each(['completed', 'failed'] as const)(
    'refreshes an ordinary pending memory write until %s without requiring cortex activity',
    async (terminal) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData([QueryKeys.startupConfig], {
        viventiumBackgroundFollowupWindowS: 60,
      });
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      const conversationId = 'memory-receipt';
      let messages = [
        {
          messageId: 'answer',
          conversationId,
          text: 'Your reply',
          isCreatedByUser: false,
          memoryWriteStatus: 'pending',
        },
      ] as TMessage[];
      const getMessages = () => messages;
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
      const { rerender } = renderHook(
        ({ isSubmitting }) => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting }),
        { wrapper, initialProps: { isSubmitting: true } },
      );
      act(() => jest.advanceTimersByTime(15000));
      expect(invalidate).not.toHaveBeenCalled();
      rerender({ isSubmitting: false });
      act(() => jest.advanceTimersByTime(1500));
      expect(invalidate).toHaveBeenCalledTimes(1);
      messages = [{ ...messages[0], memoryWriteStatus: 'running' }];
      act(() => jest.advanceTimersByTime(1500));
      expect(invalidate).toHaveBeenCalledTimes(2);
      messages = [{ ...messages[0], memoryWriteStatus: terminal }];
      await act(async () => jest.advanceTimersByTime(30000));
      expect(invalidate).toHaveBeenCalledTimes(3);
      expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.memories]);
    },
  );

  it('refreshes the open memory view once when a delayed write completes', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.memories], { value: 'Previous preference' });
    const fetchMemories = jest.fn().mockResolvedValue({ value: 'Saved preference' });
    const conversationId = 'late-memory';
    let messages = [
      {
        messageId: 'answer',
        conversationId,
        isCreatedByUser: false,
        memoryWriteStatus: 'running',
      },
    ] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        useCortexFollowUpPoll({ conversationId, getMessages: () => messages, isSubmitting: false });
        return useQuery([QueryKeys.memories], fetchMemories, { refetchOnMount: false });
      },
      { wrapper },
    );
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(fetchMemories).not.toHaveBeenCalled();
    messages = [{ ...messages[0], memoryWriteStatus: 'completed' }];
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.data).toEqual({ value: 'Saved preference' });
    expect(fetchMemories).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(fetchMemories).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'reconciles the committed memory despite an older read (cached: %s)',
    async (cached) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData([QueryKeys.startupConfig], {
        viventiumBackgroundFollowupWindowS: 60,
      });
      if (cached) queryClient.setQueryData([QueryKeys.memories], { value: 'Previous preference' });
      let releaseOlder!: (data: { value: string }) => void;
      const olderRead = new Promise<{ value: string }>((resolve) => {
        releaseOlder = resolve;
      });
      const fetchMemories = jest
        .fn()
        .mockImplementationOnce(() => olderRead)
        .mockResolvedValue({ value: 'Current committed preference' });
      const conversationId = 'synthetic-memory-race';
      let messages = [
        {
          messageId: 'answer',
          conversationId,
          isCreatedByUser: false,
          memoryWriteStatus: 'running',
        },
      ] as TMessage[];
      const getMessages = () => messages;
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(
        () => {
          useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false });
          return useQuery([QueryKeys.memories], fetchMemories);
        },
        { wrapper },
      );
      expect(fetchMemories).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      messages = [{ ...messages[0], memoryWriteStatus: 'completed' }];
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      await act(async () => {
        releaseOlder({ value: 'Previous preference' });
      });
      await act(async () => {
        jest.advanceTimersByTime(30000);
      });
      expect(result.current.data?.value).toBe('Current committed preference');
      expect(fetchMemories).toHaveBeenCalledTimes(2);
    },
  );

  it('does not refresh memories for historical receipts or a removed pending message', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'memory-history';
    let messages = [
      {
        messageId: 'old-answer',
        conversationId,
        memoryWriteStatus: 'completed',
      },
    ] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages: () => messages }), {
      wrapper,
    });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).not.toHaveBeenCalled();
    messages = [
      ...messages,
      { ...messages[0], messageId: 'pending-answer', memoryWriteStatus: 'pending' },
    ];
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(1);
    messages = [messages[0]];
    act(() => jest.advanceTimersByTime(30000));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('bounds memory receipt listening and admits a later turn without restarting old work', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 3 });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'memory-window';
    let messages = [
      {
        messageId: 'first',
        conversationId,
        text: 'Reply',
        isCreatedByUser: false,
        memoryWriteStatus: 'pending',
      },
    ] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => jest.advanceTimersByTime(15000));
    expect(invalidate).toHaveBeenCalledTimes(2);
    messages = [...messages, { ...messages[0], messageId: 'second' }];
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('shares one refresh when memory and cortex are pending together', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 60 });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'combined-pending';
    const messages = [
      {
        messageId: 'answer',
        conversationId,
        memoryWriteStatus: 'running',
        content: [
          { type: ContentTypes.CORTEX_BREWING, status: 'brewing', cortex_id: 'deep-memory' },
        ],
      },
    ] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCortexFollowUpPoll({ conversationId, getMessages, isSubmitting: false }), {
      wrapper,
    });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('durable work result refresh', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const work = (
    workRef: string,
    state: WorkSummary['state'] = 'running',
    delivery: WorkSummary['delivery']['state'] = 'pending',
  ): WorkSummary => ({
    workRef,
    title: 'Read-only review',
    state,
    provider: 'codex',
    actions: [],
    updatedAt: state === 'running' ? '2026-01-01T10:00:00Z' : '2026-01-01T10:01:00Z',
    delivery: { state: delivery, unreadTerminal: delivery === 'pending' },
  });

  it('shows successive sibling results without native activity anchors or duplicate refreshes', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'durable-readonly';
    const messages = [
      {
        messageId: 'steering-ack',
        conversationId,
        isCreatedByUser: false,
        text: 'Guidance updated.',
        content: [{ type: ContentTypes.HARNESS_ACTIVITY }],
      },
    ] as TMessage[];
    const getMessages = () => messages;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { rerender } = renderHook(
      ({ rows }) =>
        useCortexFollowUpPoll({
          conversationId,
          getMessages,
          isSubmitting: false,
          activeWork: { snapshot: 'fresh', work: rows, overflowCount: 0 },
        }),
      { wrapper, initialProps: { rows: [] as WorkSummary[] } },
    );
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).not.toHaveBeenCalled();
    rerender({ rows: [work('first'), work('second')] });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(1);
    rerender({ rows: [work('second'), work('first')] });
    act(() => jest.advanceTimersByTime(15000));
    expect(invalidate).toHaveBeenCalledTimes(1);
    rerender({ rows: [work('first', 'completed'), work('second')] });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(2);
    rerender({ rows: [work('first', 'completed', 'delivered'), work('second')] });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(3);
    rerender({
      rows: [work('first', 'completed', 'delivered'), work('second', 'completed', 'delivered')],
    });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(4);
    act(() => jest.advanceTimersByTime(60000));
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.messages, conversationId], undefined, {
      cancelRefetch: false,
    });
  });

  it('holds work changes during streaming and catches up after reconnect with fresh state', () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const conversationId = 'durable-streaming';
    const getMessages = () =>
      [{ messageId: 'answer', conversationId, text: 'Existing answer' }] as TMessage[];
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { rerender } = renderHook(
      ({ isSubmitting, snapshot }) =>
        useCortexFollowUpPoll({
          conversationId,
          getMessages,
          isSubmitting,
          activeWork: {
            snapshot,
            work: [work('task', 'completed', 'delivered')],
            overflowCount: 0,
          },
        }),
      {
        wrapper,
        initialProps: { isSubmitting: true, snapshot: 'fresh' as ActiveWorkSnapshot['snapshot'] },
      },
    );
    act(() => jest.advanceTimersByTime(15000));
    expect(invalidate).not.toHaveBeenCalled();
    rerender({ isSubmitting: false, snapshot: 'unavailable' });
    act(() => jest.advanceTimersByTime(15000));
    expect(invalidate).not.toHaveBeenCalled();
    rerender({ isSubmitting: false, snapshot: 'fresh' });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(1);
    rerender({ isSubmitting: true, snapshot: 'fresh' });
    act(() => jest.advanceTimersByTime(15000));
    expect(invalidate).toHaveBeenCalledTimes(1);
    rerender({ isSubmitting: false, snapshot: 'fresh' });
    act(() => jest.advanceTimersByTime(1500));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
