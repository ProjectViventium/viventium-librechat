import { memo, useMemo, useCallback } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type {
  TMessageContentParts,
  SearchResultData,
  TAttachment,
  Agents,
} from 'librechat-data-provider';
import { MessageContext, SearchContext } from '~/Providers';
import { ParallelContentRenderer, type PartWithIndex } from './ParallelContent';
import { mapAttachments } from '~/utils';
import { EditTextPart, EmptyText } from './Parts';
import MemoryArtifacts from './MemoryArtifacts';
import Sources from '~/components/Web/Sources';
import Container from './Container';
import Part from './Part';
import { filterRenderableContentParts, type RenderableContentInput } from './contentPartUtils';
import { isNoResponseOnlyText } from '~/utils/noResponseTag';

/* === VIVENTIUM START ===
 * Feature: Background Cortex content parts rendering (activation/brewing/insights)
 *
 * Purpose:
 * - Support rendering Background Cortex status rows as message parts.
 * - Keep cortex parts separate during streaming (avoids index collisions with streamed content/tool calls).
 *
 * Why:
 * - Viventium streams cortex updates in parallel with the main agent response; upstream UI expects only
 *   standard LibreChat parts unless explicitly handled.
 *
 * Added: 2026-01-05
 */
type ContentPartsProps = {
  content: RenderableContentInput;
  fallbackText?: string | null;
  cortexParts?: Array<TMessageContentParts | undefined> | undefined;
  messageId: string;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isCreatedByUser: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?:
    | ((value: number) => void | React.Dispatch<React.SetStateAction<number>>)
    | null
    | undefined;
};

/**
 * ContentParts renders message content parts, handling both sequential and parallel layouts.
 *
 * For 90% of messages (single-agent, no parallel execution), this renders sequentially.
 * For multi-agent parallel execution, it uses ParallelContentRenderer to show columns.
 */
const ContentParts = memo(function ContentParts({
  edit,
  isLast,
  content,
  fallbackText,
  cortexParts,
  messageId,
  enterEdit,
  siblingIdx,
  attachments,
  isSubmitting,
  setSiblingIdx,
  searchResults,
  conversationId,
  isCreatedByUser,
  isLatestMessage,
}: ContentPartsProps) {
  const attachmentMap = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;
  const cortexTypes = useMemo(
    () =>
      new Set([
        ContentTypes.CORTEX_ACTIVATION,
        ContentTypes.CORTEX_BREWING,
        ContentTypes.CORTEX_INSIGHT,
      ]),
    [],
  );
  const displayContent = useMemo(() => {
    const normalizedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : '';
    const parts =
      filterRenderableContentParts(content, {
        visibleFallbackText: normalizedFallback,
      }) ?? [];
    const hasNonCortexRenderablePart = parts.some((part) => part && !cortexTypes.has(part.type));
    if (
      hasNonCortexRenderablePart ||
      !normalizedFallback ||
      isNoResponseOnlyText(normalizedFallback)
    ) {
      return parts;
    }

    return [
      {
        type: ContentTypes.TEXT,
        text: normalizedFallback,
        [ContentTypes.TEXT]: normalizedFallback,
      } as TMessageContentParts,
      ...parts,
    ];
  }, [content, cortexTypes, fallbackText]);

  /**
   * Cortex parts come from a dedicated transient store during streaming
   * (`__viventiumCortexParts`) to avoid index collisions with streamed content/tool calls.
   * After streaming completes, cortex parts are also persisted into message.content (DB truth).
   */
  const cortexPartsFromContent: PartWithIndex[] = useMemo(() => {
    const parts: PartWithIndex[] = [];
    displayContent.forEach((part, idx) => {
      if (part && cortexTypes.has(part.type)) {
        parts.push({ part, idx });
      }
    });
    return parts;
  }, [displayContent, cortexTypes]);

  const cortexPartsEffective: PartWithIndex[] = useMemo(() => {
    if (Array.isArray(cortexParts) && cortexParts.length > 0) {
      const parts: PartWithIndex[] = [];
      cortexParts.forEach((part, idx) => {
        if (part) {
          parts.push({ part, idx });
        }
      });
      return parts;
    }
    return cortexPartsFromContent;
  }, [cortexParts, cortexPartsFromContent]);

  /**
   * Render a single content part with proper context.
   */
  const renderPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean) => {
      const toolCallId = (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';
      const partAttachments = attachmentMap[toolCallId];

      return (
        <MessageContext.Provider
          key={`provider-${messageId}-${idx}`}
          value={{
            messageId,
            isExpanded: true,
            conversationId,
            partIndex: idx,
            nextType: displayContent?.[idx + 1]?.type,
            isSubmitting: effectiveIsSubmitting,
            isLatestMessage,
          }}
        >
          <Part
            part={part}
            attachments={partAttachments}
            isSubmitting={effectiveIsSubmitting}
            key={`part-${messageId}-${idx}`}
            isCreatedByUser={isCreatedByUser}
            isLast={isLastPart}
            showCursor={isLastPart && isLast}
          />
        </MessageContext.Provider>
      );
    },
    [
      attachmentMap,
      displayContent,
      conversationId,
      effectiveIsSubmitting,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  // Early return: no content
  if (!displayContent) {
    return null;
  }

  // Edit mode: render editable text parts
  if (edit === true && enterEdit && setSiblingIdx) {
    return (
      <>
        {displayContent.map((part, idx) => {
          if (!part) {
            return null;
          }
          const isTextPart =
            part?.type === ContentTypes.TEXT ||
            typeof (part as unknown as Agents.MessageContentText)?.text !== 'string';
          const isThinkPart =
            part?.type === ContentTypes.THINK ||
            typeof (part as unknown as Agents.ReasoningDeltaUpdate)?.think !== 'string';
          if (!isTextPart && !isThinkPart) {
            return null;
          }

          const isToolCall = part.type === ContentTypes.TOOL_CALL || part['tool_call_ids'] != null;
          if (isToolCall) {
            return null;
          }

          return (
            <EditTextPart
              index={idx}
              part={part as Agents.MessageContentText | Agents.ReasoningDeltaUpdate}
              messageId={messageId}
              isSubmitting={isSubmitting}
              enterEdit={enterEdit}
              siblingIdx={siblingIdx ?? null}
              setSiblingIdx={setSiblingIdx}
              key={`edit-${messageId}-${idx}`}
            />
          );
        })}
      </>
    );
  }

  const showEmptyCursor = displayContent.length === 0 && effectiveIsSubmitting;

  // Parallel content: use dedicated renderer with columns (TMessageContentParts includes ContentMetadata)
  const hasParallelContent = displayContent.some(
    (part) => part?.groupId != null && (part?.type == null || !cortexTypes.has(part.type)),
  );
  if (hasParallelContent) {
    return (
      <ParallelContentRenderer
        content={displayContent}
        messageId={messageId}
        conversationId={conversationId}
        attachments={attachments}
        searchResults={searchResults}
        isSubmitting={effectiveIsSubmitting}
        renderPart={renderPart}
      />
    );
  }

  // Sequential content: render parts in order (90% of cases)
  const sequentialParts: PartWithIndex[] = [];
  displayContent.forEach((part, idx) => {
    if (part) {
      if (cortexTypes.has(part.type)) {
        return;
      }
      sequentialParts.push({ part, idx });
    }
  });
  const lastSequentialIdx = sequentialParts.length
    ? sequentialParts[sequentialParts.length - 1].idx
    : -1;

  return (
    <SearchContext.Provider value={{ searchResults }}>
      <MemoryArtifacts attachments={attachments} />
      <Sources messageId={messageId} conversationId={conversationId || undefined} />
      {/* VIVENTIUM NOTE: Render cortex status rows BEFORE main message content. */}
      {cortexPartsEffective.map(({ part }, idx) => {
        if (!part) {
          return null;
        }
        return (
          <Part
            key={`cortex-${messageId}-${idx}`}
            part={part}
            attachments={undefined}
            isSubmitting={effectiveIsSubmitting}
            isCreatedByUser={isCreatedByUser}
            isLast={false}
            showCursor={false}
          />
        );
      })}
      {showEmptyCursor && (
        <Container>
          <EmptyText />
        </Container>
      )}
      {sequentialParts.map(({ part, idx }) => renderPart(part, idx, idx === lastSequentialIdx))}
    </SearchContext.Provider>
  );
});

export default ContentParts;

/* === VIVENTIUM END === */
