/* === VIVENTIUM START ===
 * Feature: Durable client-presentation resume identity regression coverage.
 */
import { Constants, ContentTypes } from 'librechat-data-provider';
import { renderHook } from '@testing-library/react';
import type { Agents, TMessage } from 'librechat-data-provider';
import { queueTitleGeneration } from '~/data-provider';
import useResumeOnLoad from '../useResumeOnLoad';
import { buildSubmissionFromResumeState, hasAuthoritativeResumePair } from '../useResumeOnLoad';
import { projectResumeMessages } from '../resumeMessageProjection';

const mockSetSubmission = jest.fn();
const mockQueryClient = { setQueryData: jest.fn() };
const mockConversation = { endpoint: 'agents' };
const mockActiveJobs = { isSuccess: true, data: { activeJobIds: [] } };
const mockStatus = { isSuccess: true, data: { active: false } };
jest.mock('recoil', () => ({
  useSetRecoilState: () => mockSetSubmission,
  useRecoilValue: (key: string) => (key === 'conversation' ? mockConversation : null),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));
jest.mock('~/data-provider', () => ({
  queueTitleGeneration: jest.fn(),
  useActiveJobs: () => mockActiveJobs,
  useStreamStatus: () => mockStatus,
}));
jest.mock('~/store', () => ({
  submissionByIndex: () => 'submission',
  conversationByIndex: () => 'conversation',
}));

const conversationId = 'conversation-canonical';
const rootId = String(Constants.NO_PARENT);

type ClientPresentation = {
  mode: 'append' | 'regenerate';
  userMessageId: string;
  responseMessageId: string;
  targetUserMessageId: string;
};

type ResumeStateWithPresentation = Agents.ResumeState & {
  clientPresentation?: ClientPresentation;
  sourceMessageId?: string;
};

function message(input: Partial<TMessage> & Pick<TMessage, 'messageId'>): TMessage {
  return {
    conversationId,
    parentMessageId: rootId,
    text: '',
    isCreatedByUser: false,
    ...input,
  } as TMessage;
}

function resumeState(
  overrides: Partial<ResumeStateWithPresentation> = {},
): ResumeStateWithPresentation {
  return {
    runSteps: [],
    aggregatedContent: [{ type: ContentTypes.TEXT, text: 'authoritative partial' }],
    userMessage: {
      messageId: 'server-user',
      parentMessageId: rootId,
      conversationId,
      text: 'synthetic prompt',
    },
    responseMessageId: 'server-response',
    conversationId,
    sender: 'Synthetic Agent',
    clientPresentation: {
      mode: 'append',
      userMessageId: 'client-user',
      responseMessageId: 'client-user_',
      targetUserMessageId: 'client-user',
    },
    ...overrides,
  } as ResumeStateWithPresentation;
}

describe('already-recovered first response title', () => {
  it('observes a later partial-to-final message update with stable native dependencies', () => {
    const user = message({ messageId: 'root-user', isCreatedByUser: true });
    const answer = message({ messageId: 'answer', parentMessageId: user.messageId });
    let messages = [user, { ...answer, unfinished: true }];
    const getMessages = () => messages;
    const { rerender } = renderHook(() => useResumeOnLoad(conversationId, getMessages(), 0, true));
    expect(queueTitleGeneration).not.toHaveBeenCalled();
    messages = [user, { ...answer, unfinished: false }];
    rerender();
    expect(queueTitleGeneration).toHaveBeenCalledWith(conversationId);
  });

  it.each([
    { label: 'completed root pair', overrides: {}, expected: 1 },
    { label: 'unfinished response', overrides: { unfinished: true }, expected: 0 },
    { label: 'unknown completion', overrides: { unfinished: undefined }, expected: 0 },
    { label: 'different parent', overrides: { parentMessageId: 'other-user' }, expected: 0 },
    { label: 'other conversation', overrides: { conversationId: 'other' }, expected: 0 },
    { label: 'user row', overrides: { isCreatedByUser: true }, expected: 0 },
  ])('queues $expected for $label after history loads', ({ overrides, expected }) => {
    const user = message({ messageId: 'root-user', isCreatedByUser: true });
    const response = message({
      messageId: 'finished-answer',
      parentMessageId: user.messageId,
      unfinished: false,
      ...overrides,
    });
    const getMessages = () => [response, user];
    const { rerender } = renderHook(
      ({ loaded }) => useResumeOnLoad(conversationId, getMessages(), 0, loaded),
      { initialProps: { loaded: false } },
    );
    expect(queueTitleGeneration).not.toHaveBeenCalled();
    rerender({ loaded: true });
    expect(queueTitleGeneration).toHaveBeenCalledTimes(expected);
    if (expected) expect(queueTitleGeneration).toHaveBeenCalledWith(conversationId);
  });
});

describe('buildSubmissionFromResumeState', () => {
  it('replaces the exact optimistic pair before SYNC and FINAL append the authoritative pair', () => {
    const priorUser = message({ messageId: 'prior-user', isCreatedByUser: true, text: 'prior' });
    const priorAssistant = message({
      messageId: 'prior-response',
      parentMessageId: 'prior-user',
      text: 'prior answer',
    });
    const optimisticUser = message({
      messageId: 'client-user',
      parentMessageId: 'prior-response',
      isCreatedByUser: true,
      text: 'synthetic prompt',
      files: [{ file_id: 'synthetic-file' }],
    });
    const optimisticResponse = message({
      messageId: 'client-user_',
      parentMessageId: 'client-user',
      content: [{ type: ContentTypes.TEXT, text: 'optimistic partial' }],
    });
    const submission = buildSubmissionFromResumeState(
      resumeState({
        userMessage: {
          messageId: 'server-user',
          parentMessageId: 'prior-response',
          conversationId,
          text: 'synthetic prompt',
        },
      }),
      'stream-1',
      [priorUser, priorAssistant, optimisticUser, optimisticResponse],
      conversationId,
    );
    const finalMessages = [
      ...submission.messages,
      submission.userMessage,
      submission.initialResponse,
    ].filter((item): item is TMessage => item != null);

    expect(finalMessages.map((item) => item.messageId)).toEqual([
      'prior-user',
      'prior-response',
      'server-user',
      'server-response',
    ]);
    expect(submission.userMessage.files).toEqual([{ file_id: 'synthetic-file' }]);
  });

  it('does not prune unmatched or unrelated history', () => {
    const existing = [
      message({ messageId: 'existing-user', isCreatedByUser: true }),
      message({ messageId: 'existing-response', parentMessageId: 'existing-user' }),
    ];
    const submission = buildSubmissionFromResumeState(
      resumeState({
        clientPresentation: {
          mode: 'append',
          userMessageId: 'missing-user',
          responseMessageId: 'missing-response',
          targetUserMessageId: 'missing-user',
        },
      }),
      'stream-2',
      existing,
      conversationId,
    );

    expect(submission.messages).toEqual(existing);
  });

  it('projects latest SYNC content over an authoritative persisted placeholder', () => {
    const authoritativeUser = message({
      messageId: 'server-user',
      isCreatedByUser: true,
    });
    const authoritativePlaceholder = message({
      messageId: 'server-response',
      parentMessageId: 'server-user',
      content: [{ type: ContentTypes.TEXT, text: 'Generation in progress.' }],
    });
    const state = resumeState({
      aggregatedContent: [{ type: ContentTypes.TEXT, text: 'Latest streamed output' }],
    });
    const projection = projectResumeMessages(
      state,
      [authoritativeUser, authoritativePlaceholder],
      conversationId,
    );
    const submission = buildSubmissionFromResumeState(
      state,
      'stream-authoritative',
      [authoritativeUser, authoritativePlaceholder],
      conversationId,
      projection,
    );
    const finalMessages = [
      ...submission.messages,
      submission.userMessage,
      submission.initialResponse,
    ].filter((item): item is TMessage => item != null);

    expect(submission.messages).toEqual([]);
    expect(submission.initialResponse?.content).toEqual([
      { type: ContentTypes.TEXT, text: 'Latest streamed output' },
    ]);
    expect(
      projection.visibleMessages.find((item) => item.messageId === 'server-response')?.content,
    ).toEqual([{ type: ContentTypes.TEXT, text: 'Latest streamed output' }]);
    expect(finalMessages.map((item) => item.messageId)).toEqual(['server-user', 'server-response']);
  });

  it('collapses mixed optimistic and authoritative pairs to one authoritative pair', () => {
    const optimisticUser = message({
      messageId: 'client-user',
      isCreatedByUser: true,
    });
    const optimisticResponse = message({
      messageId: 'client-user_',
      parentMessageId: 'client-user',
    });
    const authoritativeUser = message({
      messageId: 'server-user',
      isCreatedByUser: true,
    });
    const authoritativeResponse = message({
      messageId: 'server-response',
      parentMessageId: 'server-user',
    });
    const submission = buildSubmissionFromResumeState(
      resumeState(),
      'stream-mixed',
      [optimisticUser, optimisticResponse, authoritativeUser, authoritativeResponse],
      conversationId,
    );
    const finalMessages = [
      ...submission.messages,
      submission.userMessage,
      submission.initialResponse,
    ].filter((item): item is TMessage => item != null);

    expect(finalMessages.map((item) => item.messageId)).toEqual(['server-user', 'server-response']);
  });

  it('projects exact new-chat placeholders after the server settles a canonical conversation', () => {
    const optimisticUser = message({
      messageId: 'client-user',
      conversationId: String(Constants.NEW_CONVO),
      isCreatedByUser: true,
    });
    const optimisticResponse = message({
      messageId: 'client-user_',
      conversationId: String(Constants.NEW_CONVO),
      parentMessageId: 'client-user',
    });
    const submission = buildSubmissionFromResumeState(
      resumeState(),
      'stream-new-chat',
      [optimisticUser, optimisticResponse],
      conversationId,
    );

    expect(submission.messages).toEqual([]);
    expect(submission.userMessage.messageId).toBe('server-user');
    expect(submission.initialResponse?.messageId).toBe('server-response');
  });

  it('ignores a colliding interaction source without an exact client presentation pair', () => {
    const existing = [
      message({ messageId: 'historical-source', isCreatedByUser: true }),
      message({ messageId: 'historical-response', parentMessageId: 'historical-source' }),
    ];
    const submission = buildSubmissionFromResumeState(
      resumeState({
        sourceMessageId: 'historical-source',
        clientPresentation: {
          mode: 'append',
          userMessageId: 'missing-user',
          responseMessageId: 'missing-response',
          targetUserMessageId: 'missing-user',
        },
      }),
      'stream-collision',
      existing,
      conversationId,
    );

    expect(submission.messages).toEqual(existing);
  });

  it('keeps regenerate sibling order and replaces only the active response', () => {
    const targetUser = message({ messageId: 'target-user', isCreatedByUser: true });
    const firstResponse = message({ messageId: 'response-1', parentMessageId: 'target-user' });
    const secondResponse = message({ messageId: 'response-2', parentMessageId: 'target-user' });
    const activeResponse = message({
      messageId: 'client-regenerate-response',
      parentMessageId: 'target-user',
    });
    const submission = buildSubmissionFromResumeState(
      resumeState({
        userMessage: {
          messageId: 'target-user',
          parentMessageId: rootId,
          conversationId,
          text: 'target',
        },
        responseMessageId: 'server-regenerate-response',
        clientPresentation: {
          mode: 'regenerate',
          userMessageId: 'client-request-not-rendered',
          responseMessageId: 'client-regenerate-response',
          targetUserMessageId: 'target-user',
        },
      }),
      'stream-regenerate',
      [targetUser, firstResponse, secondResponse, activeResponse],
      conversationId,
    );
    const finalMessages = [...submission.messages, submission.initialResponse].filter(
      (item): item is TMessage => item != null,
    );

    expect(submission.isRegenerate).toBe(true);
    expect(finalMessages.map((item) => item.messageId)).toEqual([
      'target-user',
      'response-1',
      'response-2',
      'server-regenerate-response',
    ]);
  });

  it('waits for authoritative onStart IDs before creating a resume submission', () => {
    expect(
      hasAuthoritativeResumePair(
        resumeState({ userMessage: undefined, responseMessageId: undefined }),
      ),
    ).toBe(false);
    expect(hasAuthoritativeResumePair(resumeState({ clientPresentation: undefined }))).toBe(false);
    expect(hasAuthoritativeResumePair(resumeState())).toBe(true);
  });
});
/* === VIVENTIUM END === */
