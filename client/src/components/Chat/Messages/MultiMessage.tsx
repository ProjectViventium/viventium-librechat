import { useRecoilState } from 'recoil';
import { Fragment, useRef, useEffect, useCallback, useContext } from 'react';
import { ContentTypes, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import MessageContent from '~/components/Messages/MessageContent';
import MessageParts from './MessageParts';
import Message from './Message';
/* === VIVENTIUM START === Preserve autonomous results beside the selected branch. === */
import {
  getMessageBranchChoices,
  resolveMessageSiblingIndex,
  isTrustedSystemMessageGroup,
  selectVisibleMessageBranches,
} from '~/utils/noResponseTag';
/* === VIVENTIUM END === */
import SiblingSwitch from '~/components/Chat/Messages/SiblingSwitch';
import { MessageInputBranchContext } from '~/Providers/MessageContext';
import store from '~/store';

export default function MultiMessage({
  // messageId is used recursively here
  messageId,
  messagesTree,
  currentEditId,
  setCurrentEditId,
}: TMessageProps) {
  const [siblingIdx, setSiblingIdx] = useRecoilState(store.messagesSiblingIdxFamily(messageId));
  const ownsInput = useContext(MessageInputBranchContext);
  const choices = getMessageBranchChoices(messagesTree ?? []);
  const previousChoiceCount = useRef(choices.length);
  const selectedSiblingIdx =
    previousChoiceCount.current === choices.length
      ? resolveMessageSiblingIndex(choices, siblingIdx)
      : 0;

  const setSiblingIdxRev = useCallback(
    (value: number) => {
      setSiblingIdx(choices.length - value - 1);
    },
    [choices.length, setSiblingIdx],
  );

  /* === VIVENTIUM START === Preserve an existing manual choice on mount and data refresh. === */
  useEffect(() => {
    if (previousChoiceCount.current !== choices.length) {
      previousChoiceCount.current = choices.length;
      setSiblingIdx(0);
    }
  }, [choices.length, setSiblingIdx]);
  /* === VIVENTIUM END === */

  if (!(messagesTree && choices.length)) {
    return null;
  }

  const selectedMessage = choices[choices.length - selectedSiblingIdx - 1] as TMessage | undefined;

  if (!selectedMessage) {
    return null;
  }

  /* === VIVENTIUM START === Keep each system group's original branch selector. === */
  return selectVisibleMessageBranches(messagesTree, selectedMessage.messageId).map(
    (visibleMessage) => {
      if (isTrustedSystemMessageGroup(visibleMessage)) {
        return (
          <Fragment key={visibleMessage.messageId}>
            {visibleMessage.messageId === selectedMessage.messageId && (
              <SiblingSwitch
                siblingIdx={choices.length - selectedSiblingIdx - 1}
                siblingCount={choices.length}
                setSiblingIdx={setSiblingIdxRev}
              />
            )}
            <MessageInputBranchContext.Provider
              value={ownsInput && visibleMessage.messageId === selectedMessage.messageId}
            >
              <MultiMessage
                messageId={visibleMessage.messageId}
                messagesTree={visibleMessage.children ?? []}
                currentEditId={currentEditId}
                setCurrentEditId={setCurrentEditId}
              />
            </MessageInputBranchContext.Provider>
          </Fragment>
        );
      }
      const message = visibleMessage;
      const isSelected = message.messageId === selectedMessage.messageId;
      let MessageComponent = Message;
      /* === VIVENTIUM START === Captions stored beside files use the existing text-field editor. === */
      const isUserCaptionEdit =
        message.isCreatedByUser === true &&
        typeof message.text === 'string' &&
        message.messageId === currentEditId &&
        Array.isArray(message.content) &&
        !message.content.some((part) => part?.type === ContentTypes.TEXT);
      if (message.content && !isUserCaptionEdit) {
        MessageComponent = isAssistantsEndpoint(message.endpoint) ? MessageParts : MessageContent;
      }
      /* === VIVENTIUM END === */
      return (
        <MessageInputBranchContext.Provider key={message.messageId} value={ownsInput && isSelected}>
          <MessageComponent
            message={message}
            currentEditId={currentEditId}
            setCurrentEditId={setCurrentEditId}
            siblingIdx={isSelected ? choices.length - selectedSiblingIdx - 1 : 0}
            siblingCount={isSelected ? choices.length : 1}
            setSiblingIdx={setSiblingIdxRev}
          />
        </MessageInputBranchContext.Provider>
      );
    },
  );
  /* === VIVENTIUM END === */
}
