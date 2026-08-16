import { useEffect } from 'react';
import { useRecoilCallback, useRecoilValue } from 'recoil';
import { Spinner, useToastContext } from '@librechat/client';
import { useParams, useSearchParams } from 'react-router-dom';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { TPreset } from 'librechat-data-provider';
import {
  useNewConvo,
  useAppStartup,
  useAssistantListMap,
  useIdChangeEffect,
  useLocalize,
} from '~/hooks';
import { useGetConvoIdQuery, useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import {
  getDefaultModelSpec,
  getModelSpecPreset,
  processValidSettings,
  logger,
  isNotFoundError,
} from '~/utils';
import { ToolCallsMapProvider } from '~/Providers';
import ChatView from '~/components/Chat/ChatView';
import { NotificationSeverity } from '~/common';
import useAuthRedirect from './useAuthRedirect';
import temporaryStore from '~/store/temporary';
import store from '~/store';

export default function ChatRoute() {
  const { data: startupConfig } = useGetStartupConfig();
  const { isAuthenticated, user, roles } = useAuthRedirect();

  const defaultTemporaryChat = useRecoilValue(temporaryStore.defaultTemporaryChat);
  const setIsTemporary = useRecoilCallback(
    ({ set }) =>
      (value: boolean) => {
        set(temporaryStore.isTemporary, value);
      },
    [],
  );
  useAppStartup({ startupConfig, user });

  const index = 0;
  const [searchParams] = useSearchParams();
  const { conversationId = '' } = useParams();
  useIdChangeEffect(conversationId);
  const { hasSetConversation, conversation } = store.useCreateConversationAtom(index);
  const { newConversation } = useNewConvo();
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const modelsQuery = useGetModelsQuery({
    enabled: isAuthenticated,
    refetchOnMount: 'always',
  });
  const initialConvoQuery = useGetConvoIdQuery(conversationId, {
    enabled:
      isAuthenticated && conversationId !== Constants.NEW_CONVO && !hasSetConversation.current,
  });
  const endpointsQuery = useGetEndpointsQuery({ enabled: isAuthenticated });
  const assistantListMap = useAssistantListMap();

  const isTemporaryChat = conversation && conversation.expiredAt ? true : false;

  useEffect(() => {
    if (conversationId === Constants.NEW_CONVO) {
      setIsTemporary(defaultTemporaryChat);
    } else if (isTemporaryChat) {
      setIsTemporary(isTemporaryChat);
    } else {
      setIsTemporary(false);
    }
  }, [conversationId, isTemporaryChat, setIsTemporary, defaultTemporaryChat]);

  /** This effect is mainly for the first conversation state change on first load of the page.
   *  Adjusting this may have unintended consequences on the conversation state.
   */
  useEffect(() => {
    // Wait for roles to load so hasAgentAccess has a definitive value in useNewConvo
    const rolesLoaded = roles?.USER != null;
    const shouldSetConvo =
      (startupConfig && rolesLoaded && !hasSetConversation.current && !modelsQuery.data?.initial) ??
      false;
    /* Early exit if startupConfig is not loaded and conversation is already set and only initial models have loaded */
    if (!shouldSetConvo) {
      return;
    }

    const isNewConvo = conversationId === Constants.NEW_CONVO;
    /* === VIVENTIUM START ===
     * Feature: Exact-route persisted conversation settlement
     * Purpose: A delayed or stale route query must never initialize or settle another conversation.
     */
    const routeConversation =
      !isNewConvo && initialConvoQuery.data?.conversationId === conversationId
        ? initialConvoQuery.data
        : undefined;
    /* === VIVENTIUM END === */

    const getNewConvoPreset = () => {
      const result = getDefaultModelSpec(startupConfig);
      const spec = result?.default ?? result?.last;
      const specPreset = spec ? getModelSpecPreset(spec) : undefined;

      const queryParams: Record<string, string> = {};
      searchParams.forEach((value, key) => {
        if (key !== 'prompt' && key !== 'q' && key !== 'submit') {
          queryParams[key] = value;
        }
      });
      const querySettings = processValidSettings(queryParams);

      return Object.keys(querySettings).length > 0
        ? { ...specPreset, ...querySettings }
        : specPreset;
    };

    if (isNewConvo && endpointsQuery.data && modelsQuery.data) {
      const preset = getNewConvoPreset();

      logger.log('conversation', 'ChatRoute, new convo effect', conversation);
      newConversation({
        modelsData: modelsQuery.data,
        template: conversation ? conversation : undefined,
        ...(preset ? { preset } : {}),
      });

      hasSetConversation.current = true;
    } else if (routeConversation && endpointsQuery.data && modelsQuery.data) {
      /* === VIVENTIUM START ===
       * Feature: Exact-route persisted conversation settlement
       * Purpose: Mark initialization complete only after applying the conversation selected by the route.
       */
      logger.log('conversation', 'ChatRoute initialConvoQuery', routeConversation);
      newConversation({
        template: routeConversation,
        /* this is necessary to load all existing settings */
        preset: routeConversation as TPreset,
        modelsData: modelsQuery.data,
        keepLatestMessage: true,
      });
      hasSetConversation.current = true;
      /* === VIVENTIUM END === */
    } else if (
      conversationId &&
      endpointsQuery.data &&
      modelsQuery.data &&
      initialConvoQuery.isError &&
      isNotFoundError(initialConvoQuery.error)
    ) {
      const result = getDefaultModelSpec(startupConfig);
      const spec = result?.default ?? result?.last;
      showToast({
        message: localize('com_ui_conversation_not_found'),
        severity: NotificationSeverity.WARNING,
      });
      logger.log(
        'conversation',
        'ChatRoute initialConvoQuery isNotFoundError',
        initialConvoQuery.error,
      );
      newConversation({
        modelsData: modelsQuery.data,
        ...(spec ? { preset: getModelSpecPreset(spec) } : {}),
      });
      hasSetConversation.current = true;
    } else if (
      isNewConvo &&
      assistantListMap[EModelEndpoint.assistants] &&
      assistantListMap[EModelEndpoint.azureAssistants]
    ) {
      const preset = getNewConvoPreset();

      logger.log('conversation', 'ChatRoute new convo, assistants effect', conversation);
      newConversation({
        modelsData: modelsQuery.data,
        template: conversation ? conversation : undefined,
        ...(preset ? { preset } : {}),
      });
      hasSetConversation.current = true;
    } else if (
      routeConversation &&
      assistantListMap[EModelEndpoint.assistants] &&
      assistantListMap[EModelEndpoint.azureAssistants]
    ) {
      /* === VIVENTIUM START ===
       * Feature: Exact-route persisted conversation settlement
       * Purpose: Preserve assistant-map initialization only for a query result correlated to the route.
       */
      logger.log('conversation', 'ChatRoute convo, assistants effect', routeConversation);
      newConversation({
        template: routeConversation,
        preset: routeConversation as TPreset,
        modelsData: modelsQuery.data,
        keepLatestMessage: true,
      });
      hasSetConversation.current = true;
      /* === VIVENTIUM END === */
    }
    /* Creates infinite render if all dependencies included due to newConversation invocations exceeding call stack before hasSetConversation.current becomes truthy */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roles,
    startupConfig,
    /* === VIVENTIUM START ===
     * Feature: Exact-route persisted conversation settlement
     * Purpose: Re-evaluate query correlation whenever the selected route changes.
     */
    conversationId,
    /* === VIVENTIUM END === */
    initialConvoQuery.data,
    initialConvoQuery.isError,
    endpointsQuery.data,
    modelsQuery.data,
    assistantListMap,
  ]);

  if (endpointsQuery.isLoading || modelsQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center" aria-live="polite" role="status">
        <Spinner className="text-text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  // if not a conversation
  if (conversation?.conversationId === Constants.SEARCH) {
    return null;
  }
  /* === VIVENTIUM START ===
   * Feature: Exact-route persisted conversation settlement
   * Purpose: Never mount ChatView with a null or stale conversation from another route.
   */
  if (!conversation || conversation.conversationId !== conversationId) {
    return null;
  }
  /* === VIVENTIUM END === */
  // if conversationId is null
  if (!conversationId) {
    return null;
  }

  return (
    <ToolCallsMapProvider conversationId={conversation.conversationId ?? ''}>
      <ChatView index={index} />
    </ToolCallsMapProvider>
  );
}
