import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { useUpdateConversationMutation } from '../mutations';
import { genTitleQueryKey, queueTitleGeneration, useTitleGeneration } from '../SSE/queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getActiveJobs: jest.fn(async () => ({ activeJobIds: [] })),
      genTitle: jest.fn(),
      updateConversation: jest.fn(),
    },
  };
});
jest.mock('~/utils', () => ({
  updateConvoInAllQueries: jest.requireActual('~/utils/convos').updateConvoInAllQueries,
}));
jest.mock('~/hooks/Conversations/useUpdateTagsInConvo', () => () => ({}));
jest.mock('~/utils/conversationTags', () => ({ updateConversationTag: jest.fn() }));
jest.mock('../queries', () => ({ useConversationTagsQuery: jest.fn() }));

test('a confirmed rename wins over an already pending generated-title response', async () => {
  const conversationId = 'title-rename-race';
  const saved = { conversationId, title: 'User chosen title' } as TConversation;
  const genTitle = jest.mocked(dataService.genTitle);
  let finishTitle!: (value: { title: string }) => void;
  genTitle.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishTitle = resolve;
      }),
  );
  jest.mocked(dataService.updateConversation).mockResolvedValueOnce(saved);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  client.setQueryData([QueryKeys.conversation, conversationId], {
    conversationId,
    title: 'New Chat',
  });
  const listKey = [QueryKeys.allConversations, 'title-race'];
  client.setQueryData(listKey, {
    pages: [{ conversations: [{ conversationId, title: 'New Chat' }], nextCursor: null }],
    pageParams: [],
  });
  const otherKey = genTitleQueryKey('other-conversation');
  client.setQueryData(otherKey, { title: 'Other title' });
  queueTitleGeneration(conversationId);
  const { result, unmount } = renderHook(
    () => {
      useTitleGeneration();
      return useUpdateConversationMutation(conversationId);
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(genTitle).toHaveBeenCalledTimes(1));
  await act(async () => {
    await result.current.mutateAsync({ conversationId, title: saved.title });
  });
  expect(client.getQueryData<TConversation>([QueryKeys.conversation, conversationId])?.title).toBe(
    saved.title,
  );
  await act(async () => {
    finishTitle({ title: 'Older generated title' });
  });
  await waitFor(() => {
    expect(client.isFetching()).toBe(0);
    expect(
      client.getQueryData<TConversation>([QueryKeys.conversation, conversationId])?.title,
    ).toBe(saved.title);
    expect(client.getQueryData(listKey)).toMatchObject({
      pages: [{ conversations: [{ conversationId, title: saved.title }] }],
    });
  });
  expect(client.getQueryData(genTitleQueryKey(conversationId))).toEqual({ title: saved.title });
  expect(client.getQueryData(otherKey)).toEqual({ title: 'Other title' });
  unmount();
  client.clear();
});

test('a failed rename leaves the pending generated title usable', async () => {
  const conversationId = 'title-failed-rename';
  let finishTitle!: (value: { title: string }) => void;
  jest.mocked(dataService.genTitle).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishTitle = resolve;
      }),
  );
  jest.mocked(dataService.updateConversation).mockRejectedValueOnce(new Error('Rename failed'));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  client.setQueryData([QueryKeys.conversation, conversationId], {
    conversationId,
    title: 'New Chat',
  });
  queueTitleGeneration(conversationId);
  const { result, unmount } = renderHook(
    () => {
      useTitleGeneration();
      return useUpdateConversationMutation(conversationId);
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(dataService.genTitle).toHaveBeenCalledTimes(1));
  await act(async () => {
    await expect(
      result.current.mutateAsync({ conversationId, title: 'Rejected title' }),
    ).rejects.toThrow('Rename failed');
  });
  await act(async () => {
    finishTitle({ title: 'Generated title' });
  });
  await waitFor(() => {
    expect(
      client.getQueryData<TConversation>([QueryKeys.conversation, conversationId])?.title,
    ).toBe('Generated title');
  });
  unmount();
  client.clear();
});
