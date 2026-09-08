import { useRecoilState } from 'recoil';
import { Fragment, useEffect, useCallback, useContext } from 'react';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import MessageContent from '~/components/Messages/MessageContent';
import MessageParts from './MessageParts';
import Message from './Message';
/* === VIVENTIUM START === Preserve autonomous results beside the selected branch. === */
import {
  getMessageBranchChoices,
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

  const setSiblingIdxRev = useCallback(
    (value: number) => {
      setSiblingIdx(choices.length - value - 1);
    },
    [choices.length, setSiblingIdx],
  );

  useEffect(() => {
    // reset siblingIdx when the tree changes, mostly when a new message is submitting.
    setSiblingIdx(0);
  }, [choices.length, setSiblingIdx]);

  useEffect(() => {
    if (choices.length && siblingIdx >= choices.length) {
      setSiblingIdx(0);
    }
  }, [siblingIdx, choices.length, setSiblingIdx]);

  if (!(messagesTree && choices.length)) {
    return null;
  }

  const selectedMessage = choices[choices.length - siblingIdx - 1] as TMessage | undefined;

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
                siblingIdx={choices.length - siblingIdx - 1}
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
      const MessageComponent =
        isAssistantsEndpoint(message.endpoint) && message.content
          ? MessageParts
          : message.content
            ? MessageContent
            : Message;
      return (
        <MessageInputBranchContext.Provider
          key={message.messageId}
          value={ownsInput && isSelected}
        >
          <MessageComponent
            message={message}
            currentEditId={currentEditId}
            setCurrentEditId={setCurrentEditId}
            siblingIdx={isSelected ? choices.length - siblingIdx - 1 : 0}
            siblingCount={isSelected ? choices.length : 1}
            setSiblingIdx={setSiblingIdxRev}
          />
        </MessageInputBranchContext.Provider>
      );
    },
  );
  /* === VIVENTIUM END === */
}
