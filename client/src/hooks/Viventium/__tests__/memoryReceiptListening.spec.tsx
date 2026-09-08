import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import useCortexFollowUpPoll from '../useCortexFollowUpPoll';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 3 });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  let messages = [
    {
      messageId: 'first',
      conversationId: 'memory-pause',
      text: 'Reply',
      isCreatedByUser: false,
      memoryWriteStatus: 'pending',
    },
  ] as TMessage[];
  const getMessages = () => messages;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ isSubmitting }) =>
      useCortexFollowUpPoll({
        conversationId: 'memory-pause',
        getMessages,
        isSubmitting,
      }),
    { wrapper, initialProps: { isSubmitting: false } },
  );
  return {
    ...hook,
    invalidate,
    setMessages: (next: TMessage[]) => {
      messages = next;
    },
    getMessages,
  };
}

test('a later SSE stream does not consume the existing memory receipt listening window', () => {
  const { rerender, invalidate } = setup();
  act(() => jest.advanceTimersByTime(1500));
  expect(invalidate).toHaveBeenCalledTimes(1);
  rerender({ isSubmitting: true });
  act(() => jest.advanceTimersByTime(15000));
  expect(invalidate).toHaveBeenCalledTimes(1);
  rerender({ isSubmitting: false });
  act(() => jest.advanceTimersByTime(1500));
  expect(invalidate).toHaveBeenCalledTimes(2);
});

test('completing a new save does not restart listening for an expired older save', () => {
  const { invalidate, getMessages, setMessages } = setup();
  act(() => jest.advanceTimersByTime(15000));
  expect(invalidate).toHaveBeenCalledTimes(2);
  const first = getMessages()[0];
  setMessages([first, { ...first, messageId: 'second' }]);
  act(() => jest.advanceTimersByTime(1500));
  expect(invalidate).toHaveBeenCalledTimes(3);
  setMessages([first, { ...first, messageId: 'second', memoryWriteStatus: 'completed' }]);
  act(() => jest.advanceTimersByTime(1500));
  expect(invalidate).toHaveBeenCalledTimes(3);
});

test('a slow successful message read completes during receipt listening', async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 60 });
  const queryKey = [QueryKeys.messages, 'slow-read'];
  const initial = [
    { messageId: 'first', conversationId: 'slow-read', memoryWriteStatus: 'pending' },
  ] as TMessage[];
  queryClient.setQueryData(queryKey, initial);
  const queryFn = jest.fn(
    () =>
      new Promise<TMessage[]>((resolve) =>
        setTimeout(() => resolve([{ ...initial[0], memoryWriteStatus: 'completed' }]), 2000),
      ),
  );
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: Infinity,
    refetchOnMount: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { unmount } = renderHook(
    () => useCortexFollowUpPoll({ conversationId: 'slow-read', isSubmitting: false }),
    { wrapper },
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(4000);
  });
  const status = queryClient.getQueryData<TMessage[]>(queryKey)?.[0].memoryWriteStatus;
  const fetches = queryFn.mock.calls.length;
  unmount();
  unsubscribe();
  queryClient.clear();
  expect({ status, fetches }).toEqual({ status: 'completed', fetches: 1 });
});

test('a read started before SSE cannot replace the new user turn and streaming placeholder', async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.startupConfig], { viventiumBackgroundFollowupWindowS: 60 });
  const queryKey = [QueryKeys.messages, 'stream-race'];
  const initial = [
    { messageId: 'user-1', conversationId: 'stream-race', isCreatedByUser: true },
    {
      messageId: 'answer-1',
      conversationId: 'stream-race',
      isCreatedByUser: false,
      memoryWriteStatus: 'pending',
    },
  ] as TMessage[];
  queryClient.setQueryData(queryKey, initial);
  const queryFn = () =>
    new Promise<TMessage[]>((resolve) => setTimeout(() => resolve(initial), 2000));
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: Infinity,
    refetchOnMount: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { unmount, rerender } = renderHook(
    ({ isSubmitting }) =>
      useCortexFollowUpPoll({
        conversationId: 'stream-race',
        isSubmitting,
      }),
    { wrapper, initialProps: { isSubmitting: false } },
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  const duringStream = [
    ...initial,
    { messageId: 'user-2', conversationId: 'stream-race', isCreatedByUser: true },
    {
      messageId: 'user-2_',
      conversationId: 'stream-race',
      isCreatedByUser: false,
      text: 'Streaming reply',
    },
  ];
  queryClient.setQueryData(queryKey, duringStream);
  rerender({ isSubmitting: true });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  const messageIds = queryClient
    .getQueryData<TMessage[]>(queryKey)
    ?.map((message) => message.messageId);
  unmount();
  unsubscribe();
  queryClient.clear();
  expect(messageIds).toEqual(duringStream.map((message) => message.messageId));
});
