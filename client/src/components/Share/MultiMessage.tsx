import { Fragment, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';

import Message from './Message';
/* === VIVENTIUM START === Match the chat's additive system-result projection. === */
import {
  getMessageBranchChoices,
  isTrustedSystemMessageGroup,
  selectVisibleMessageBranches,
} from '~/utils/noResponseTag';
/* === VIVENTIUM END === */
import SiblingSwitch from '~/components/Chat/Messages/SiblingSwitch';
import store from '~/store';

export default function MultiMessage({
  // messageId is used recursively here
  messageId,
  messagesTree,
  currentEditId,
  setCurrentEditId,
}: TMessageProps) {
  const [siblingIdx, setSiblingIdx] = useRecoilState(store.messagesSiblingIdxFamily(messageId));
  const choices = getMessageBranchChoices(messagesTree ?? []);

  const setSiblingIdxRev = (value: number) => {
    setSiblingIdx(choices.length - value - 1);
  };

  useEffect(() => {
    // reset siblingIdx when the tree changes, mostly when a new message is submitting.
    setSiblingIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.length]);

  useEffect(() => {
    if (siblingIdx >= choices.length) {
      setSiblingIdx(0);
    }
  }, [siblingIdx, choices.length, setSiblingIdx]);

  if (!(messagesTree && choices.length)) {
    return null;
  }

  const selectedMessage = choices[choices.length - siblingIdx - 1] as TMessage | null;
  if (!selectedMessage) {
    return null;
  }

  /* === VIVENTIUM START === Keep hidden group keys and ordinary branch selection. === */
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
            <MultiMessage
              messageId={visibleMessage.messageId}
              messagesTree={visibleMessage.children ?? []}
              currentEditId={currentEditId}
              setCurrentEditId={setCurrentEditId}
            />
          </Fragment>
        );
      }
      const message = visibleMessage;
      const isSelected = message.messageId === selectedMessage.messageId;
      return (
        <Message
          key={message.messageId}
          message={message}
          currentEditId={currentEditId}
          setCurrentEditId={setCurrentEditId}
          siblingIdx={isSelected ? choices.length - siblingIdx - 1 : 0}
          siblingCount={isSelected ? choices.length : 1}
          setSiblingIdx={setSiblingIdxRev}
        />
      );
    },
  );
  /* === VIVENTIUM END === */
}
