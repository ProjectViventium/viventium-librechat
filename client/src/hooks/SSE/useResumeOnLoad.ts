import { useEffect, useRef } from 'react';
import { useSetRecoilState, useRecoilValue } from 'recoil';
/* === VIVENTIUM START ===
 * Feature: Exact optimistic-to-authoritative resume identity.
 * Purpose: Publish the exact projected pair to the canonical query cache before reconnect.
 */
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
/* === VIVENTIUM END === */
import { Constants, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation, TSubmission, Agents } from 'librechat-data-provider';
import { useActiveJobs, useStreamStatus } from '~/data-provider';
import store from '~/store';
/* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
import { projectResumeMessages, type ResumeMessageProjection } from './resumeMessageProjection';
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
export function hasAuthoritativeResumePair(resumeState?: Agents.ResumeState): boolean {
  const presentation = resumeState?.clientPresentation;
  return Boolean(
    resumeState?.userMessage?.messageId?.trim() &&
    resumeState.responseMessageId?.trim() &&
    (presentation?.mode === 'append' || presentation?.mode === 'regenerate') &&
    presentation.userMessageId?.trim() &&
    presentation.responseMessageId?.trim() &&
    presentation.targetUserMessageId?.trim(),
  );
}
/* === VIVENTIUM END === */

/**
 * Build a submission object from resume state for reconnected streams.
 * This provides the minimum data needed for useResumableSSE to subscribe.
 */
/* === VIVENTIUM START ===
 * Feature: Exact optimistic-to-authoritative resume identity.
 * Purpose: FINAL history excludes the rebound active pair, so its authoritative server pair is
 *          appended once instead of becoming a second conversation branch.
 */
export function buildSubmissionFromResumeState(
  resumeState: Agents.ResumeState,
  streamId: string,
  messages: TMessage[],
  conversationId: string,
  projection: ResumeMessageProjection = projectResumeMessages(
    resumeState,
    messages,
    conversationId,
  ),
): TSubmission {
  const conversation: TConversation = {
    conversationId,
    title: 'Resumed Chat',
    endpoint: null,
  } as TConversation;

  return {
    messages: projection.historyMessages,
    userMessage: projection.userMessage,
    initialResponse: projection.responseMessage,
    conversation,
    isRegenerate: resumeState.clientPresentation?.mode === 'regenerate',
    isTemporary: false,
    endpointOption: {},
    // Signal to useResumableSSE to subscribe to existing stream instead of starting new
    resumeStreamId: streamId,
  } as TSubmission & { resumeStreamId: string };
}
/* === VIVENTIUM END === */

/**
 * Hook to resume streaming if navigating to a conversation with active generation.
 * Checks stream status via React Query and sets submission if active job found.
 *
 * This hook:
 * 1. Uses useStreamStatus to check for active jobs on navigation
 * 2. If active job found, builds a submission with streamId and sets it
 * 3. useResumableSSE picks up the submission and subscribes to the stream
 *
 * @param messagesLoaded - Whether the messages query has finished loading (prevents race condition)
 */
export default function useResumeOnLoad(
  conversationId: string | undefined,
  getMessages: () => TMessage[] | undefined,
  runIndex = 0,
  messagesLoaded = true,
) {
  /* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
  const queryClient = useQueryClient();
  /* === VIVENTIUM END === */
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const currentSubmission = useRecoilValue(store.submissionByIndex(runIndex));
  const currentConversation = useRecoilValue(store.conversationByIndex(runIndex));
  const endpoint = currentConversation?.endpoint;
  const endpointType = currentConversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const resumableEnabled = !isAssistantsEndpoint(actualEndpoint);
  // Track conversations we've already processed (either resumed or skipped)
  const processedConvoRef = useRef<string | null>(null);
  /* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
  const identityRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* === VIVENTIUM END === */

  // Check for active stream when conversation changes
  // Allow check if no submission OR submission is for a different conversation (stale)
  const submissionConvoId = currentSubmission?.conversation?.conversationId;
  const hasActiveSubmissionForThisConvo = currentSubmission && submissionConvoId === conversationId;

  const shouldCheck =
    resumableEnabled &&
    messagesLoaded && // Wait for messages to load before checking
    !hasActiveSubmissionForThisConvo && // Allow if no submission or stale submission
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO &&
    processedConvoRef.current !== conversationId; // Don't re-check processed convos

  const {
    data: streamStatus,
    isSuccess,
    refetch: refetchStreamStatus,
  } = useStreamStatus(conversationId, shouldCheck);
  const { data: activeJobsData, isSuccess: activeJobsReady } = useActiveJobs(resumableEnabled);

  useEffect(() => {
    console.log('[ResumeOnLoad] Effect check', {
      resumableEnabled,
      conversationId,
      messagesLoaded,
      hasCurrentSubmission: !!currentSubmission,
      currentSubmissionConvoId: currentSubmission?.conversation?.conversationId,
      isSuccess,
      streamStatusActive: streamStatus?.active,
      streamStatusStreamId: streamStatus?.streamId,
      processedConvoRef: processedConvoRef.current,
    });

    if (!resumableEnabled || !conversationId || conversationId === Constants.NEW_CONVO) {
      console.log('[ResumeOnLoad] Skipping - not enabled or new convo');
      return;
    }

    // Wait for messages to load to avoid race condition where sync overwrites then DB overwrites
    if (!messagesLoaded) {
      console.log('[ResumeOnLoad] Waiting for messages to load');
      return;
    }

    // Local active-job cache is the single source of truth for same-session resume decisions.
    // FINAL removes the job optimistically so Phase B can finish in the background without
    // immediately re-opening a stale resume stream on the same page.
    if (!activeJobsReady) {
      console.log('[ResumeOnLoad] Waiting for active jobs query');
      return;
    }

    const activeJobIds = activeJobsData?.activeJobIds ?? [];
    const isConversationInActiveJobs = activeJobIds.includes(conversationId);
    if (!isConversationInActiveJobs) {
      console.log('[ResumeOnLoad] Skipping resume - conversation not active in local job cache');
      processedConvoRef.current = conversationId;
      return;
    }

    // Don't resume if we already have an active submission FOR THIS CONVERSATION
    // A stale submission with undefined/different conversationId should not block us
    if (hasActiveSubmissionForThisConvo) {
      console.log('[ResumeOnLoad] Skipping - already have active submission for this conversation');
      // Mark as processed so we don't try again
      processedConvoRef.current = conversationId;
      return;
    }

    // If there's a stale submission for a different conversation, log it but continue
    if (currentSubmission && submissionConvoId !== conversationId) {
      console.log(
        '[ResumeOnLoad] Found stale submission for different conversation, will check for resume',
        {
          staleConvoId: submissionConvoId,
          currentConvoId: conversationId,
        },
      );
    }

    // Wait for stream status query to complete
    if (!isSuccess || !streamStatus) {
      console.log('[ResumeOnLoad] Waiting for stream status query');
      return;
    }

    // Don't process the same conversation twice
    if (processedConvoRef.current === conversationId) {
      console.log('[ResumeOnLoad] Skipping - already processed this conversation');
      return;
    }

    // Check if there's an active job to resume
    // DON'T mark as processed here - only mark when we actually create a submission
    // This prevents stale cache data from blocking subsequent resume attempts
    if (!streamStatus.active || !streamStatus.streamId) {
      console.log('[ResumeOnLoad] No active job to resume for:', conversationId);
      return;
    }

    /* === VIVENTIUM START ===
     * Feature: Exact optimistic-to-authoritative resume identity.
     * Purpose: A job is admitted before onStart persists server message IDs. Poll without marking
     *          the conversation processed; guessing here creates a second visible branch.
     */
    if (!hasAuthoritativeResumePair(streamStatus.resumeState)) {
      if (!identityRetryRef.current) {
        identityRetryRef.current = setTimeout(() => {
          identityRetryRef.current = null;
          void refetchStreamStatus();
        }, 250);
      }
      return;
    }
    if (identityRetryRef.current) {
      clearTimeout(identityRetryRef.current);
      identityRetryRef.current = null;
    }
    /* === VIVENTIUM END === */

    // Mark as processed NOW - we verified there's an active job and will create submission
    processedConvoRef.current = conversationId;

    console.log('[ResumeOnLoad] Found active job, creating submission...', {
      streamId: streamStatus.streamId,
      status: streamStatus.status,
      hasResumeState: streamStatus.resumeState != null,
      runStepCount: streamStatus.resumeState?.runSteps?.length ?? 0,
      aggregatedContentCount: streamStatus.resumeState?.aggregatedContent?.length ?? 0,
      hasClientPresentation: Boolean(streamStatus.resumeState?.clientPresentation),
      hasUserMessage: Boolean(streamStatus.resumeState?.userMessage?.messageId),
      hasResponseMessageId: Boolean(streamStatus.resumeState?.responseMessageId),
    });

    const messages = getMessages() || [];

    // Build submission from resume state if available
    if (streamStatus.resumeState) {
      /* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
      const projection = projectResumeMessages(streamStatus.resumeState, messages, conversationId);
      const submission = buildSubmissionFromResumeState(
        streamStatus.resumeState,
        streamStatus.streamId,
        messages,
        conversationId,
        projection,
      );
      if (projection.projectedActivePair) {
        queryClient.setQueryData<TMessage[]>(
          [QueryKeys.messages, conversationId],
          projection.visibleMessages,
        );
      }
      /* === VIVENTIUM END === */
      setSubmission(submission);
    } else {
      // Minimal submission without resume state
      const lastUserMessage = [...messages].reverse().find((m) => m.isCreatedByUser);
      const submission = {
        messages,
        userMessage:
          lastUserMessage ?? ({ messageId: 'resume', conversationId, text: '' } as TMessage),
        initialResponse: {
          messageId: 'resume_',
          conversationId,
          text: '',
          content: streamStatus.aggregatedContent ?? [{ type: 'text', text: '' }],
        } as TMessage,
        conversation: { conversationId, title: 'Resumed Chat' } as TConversation,
        isRegenerate: false,
        isTemporary: false,
        endpointOption: {},
        // Signal to useResumableSSE to subscribe to existing stream instead of starting new
        resumeStreamId: streamStatus.streamId,
      } as TSubmission & { resumeStreamId: string };
      setSubmission(submission);
    }
  }, [
    conversationId,
    resumableEnabled,
    messagesLoaded,
    hasActiveSubmissionForThisConvo,
    submissionConvoId,
    currentSubmission,
    activeJobsData?.activeJobIds,
    activeJobsReady,
    isSuccess,
    streamStatus,
    refetchStreamStatus,
    getMessages,
    queryClient,
    setSubmission,
  ]);

  // Reset processedConvoRef when conversation changes to allow re-checking
  useEffect(() => {
    // Always reset when conversation changes - this allows resuming when navigating back
    if (conversationId !== processedConvoRef.current) {
      console.log('[ResumeOnLoad] Resetting processedConvoRef for new conversation:', {
        old: processedConvoRef.current,
        new: conversationId,
      });
      processedConvoRef.current = null;
    }
    if (identityRetryRef.current) {
      clearTimeout(identityRetryRef.current);
      identityRetryRef.current = null;
    }
  }, [conversationId]);

  useEffect(
    () => () => {
      if (identityRetryRef.current) {
        clearTimeout(identityRetryRef.current);
      }
    },
    [],
  );
}
