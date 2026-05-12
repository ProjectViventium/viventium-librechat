import { Suspense, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { DelayedRender } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TAttachment,
  SearchResultData,
  TMessageContentParts,
} from 'librechat-data-provider';
import { UnfinishedMessage } from './MessageContent';
import { filterRenderableContentParts } from './contentPartUtils';
import Sources from '~/components/Web/Sources';
import { cn, mapAttachments } from '~/utils';
import { isNoResponseOnlyText } from '~/utils/noResponseTag';
import { SearchContext } from '~/Providers';
import MarkdownLite from './MarkdownLite';
import store from '~/store';
import Part from './Part';

const SearchContent = ({
  message,
  attachments,
  searchResults,
}: {
  message: TMessage;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
}) => {
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const { messageId } = message;

  const attachmentMap = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const displayContent = useMemo(() => {
    const fallbackText = typeof message.text === 'string' ? message.text.trim() : '';
    const parts = filterRenderableContentParts(message.content, {
      visibleFallbackText: fallbackText,
    }) ?? [];
    const cortexTypes = new Set([
      ContentTypes.CORTEX_ACTIVATION,
      ContentTypes.CORTEX_BREWING,
      ContentTypes.CORTEX_INSIGHT,
    ]);
    const hasNonCortexRenderablePart = parts.some((part) => part && !cortexTypes.has(part.type));
    if (hasNonCortexRenderablePart || !fallbackText || isNoResponseOnlyText(fallbackText)) {
      return parts;
    }
    return [
      {
        type: ContentTypes.TEXT,
        text: fallbackText,
        [ContentTypes.TEXT]: fallbackText,
      } as TMessageContentParts,
      ...parts,
    ];
  }, [message.content, message.text]);

  if (displayContent && displayContent.length > 0) {
    return (
      <SearchContext.Provider value={{ searchResults }}>
        <Sources />
        {displayContent
          .filter((part: TMessageContentParts | undefined) => part)
          .map((part: TMessageContentParts | undefined, idx: number) => {
            if (!part) {
              return null;
            }

            const toolCallId =
              (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';
            const attachments = attachmentMap[toolCallId];
            return (
              <Part
                key={`display-${messageId}-${idx}`}
                showCursor={false}
                isSubmitting={false}
                isCreatedByUser={message.isCreatedByUser}
                attachments={attachments}
                part={part}
              />
            );
          })}
        {message.unfinished === true && (
          <Suspense>
            <DelayedRender delay={250}>
              <UnfinishedMessage message={message} key={`unfinished-${messageId}`} />
            </DelayedRender>
          </Suspense>
        )}
      </SearchContext.Provider>
    );
  }

  if (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    displayContent?.length === 0 &&
    isNoResponseOnlyText(message.text)
  ) {
    return null;
  }

  return (
    <div
      className={cn(
        'markdown prose dark:prose-invert light w-full break-words',
        message.isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
        message.isCreatedByUser ? 'dark:text-gray-20' : 'dark:text-gray-70',
      )}
      dir="auto"
    >
      <MarkdownLite content={message.text || ''} />
    </div>
  );
};

export default SearchContent;
