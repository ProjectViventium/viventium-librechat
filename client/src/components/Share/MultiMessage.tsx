import { Fragment, useRef, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';

import Message from './Message';
/* === VIVENTIUM START === Match the chat's additive system-result projection. === */
import {
  getMessageBranchChoices,
  resolveMessageSiblingIndex,
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
  const previousChoiceCount = useRef(choices.length);
  const selectedSiblingIdx =
    previousChoiceCount.current === choices.length
      ? resolveMessageSiblingIndex(choices, siblingIdx)
      : 0;

  const setSiblingIdxRev = (value: number) => {
    setSiblingIdx(choices.length - value - 1);
  };

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

  const selectedMessage = choices[choices.length - selectedSiblingIdx - 1] as TMessage | null;
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
                siblingIdx={choices.length - selectedSiblingIdx - 1}
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
          siblingIdx={isSelected ? choices.length - selectedSiblingIdx - 1 : 0}
          siblingCount={isSelected ? choices.length : 1}
          setSiblingIdx={setSiblingIdxRev}
        />
      );
    },
  );
  /* === VIVENTIUM END === */
}
