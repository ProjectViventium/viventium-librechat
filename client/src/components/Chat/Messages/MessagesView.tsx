import { useState, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { CSSTransition } from 'react-transition-group';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useLocalize } from '~/hooks';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { MessagesViewProvider } from '~/Providers';
import { fontSizeAtom } from '~/store/fontSize';
import MultiMessage from './MultiMessage';
/* === VIVENTIUM START ===
 * Feature: Hide internal no-response ({NTA}) follow-ups from the UI
 *
 * Purpose:
 * - Filter internal no-response follow-ups from rendering/exporting in the chat UI.
 *
 * Added: 2026-02-07
 */
import { cn, filterNoResponseMessagesTree } from '~/utils';
/* === VIVENTIUM END === */
import store from '~/store';

function MessagesViewContent({
  messagesTree: _messagesTree,
}: {
  messagesTree?: TMessage[] | null;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const { screenshotTargetRef } = useScreenshot();
  const scrollButtonPreference = useRecoilValue(store.showScrollButton);
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  const scrollToBottomRef = useRef<HTMLButtonElement>(null);

  /* === VIVENTIUM DISABLED (2026-02-21) ===
   * NTA client-side auto-hide disabled on LC Web UI for full visibility.
   * LC interface shows ALL responses (including {NTA} text and tool calls).
   * Other channels (Telegram, Voice, OpenClaw) still suppress NTA server-side.
   * To re-enable: uncomment the filterNoResponseMessagesTree line below and
   * remove the passthrough assignment.
   *
   * Original feature added: 2026-02-07
   */
  // const messagesTree = filterNoResponseMessagesTree(_messagesTree, {
  //   brewNoResponsePlaceholder: '-',
  // });
  const messagesTree = _messagesTree;

  const {
    conversation,
    scrollableRef,
    messagesEndRef,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
  } = useMessageScrolling(messagesTree);
  /* === VIVENTIUM END === */

  const { conversationId } = conversation ?? {};

  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            <div className="flex flex-col pb-9 pt-14 dark:bg-transparent">
              {/* === VIVENTIUM START ===
               * Feature: Hide internal no-response ({NTA}) follow-ups from the UI
               * Purpose: Render the filtered messages tree (`messagesTree`) instead of upstream raw `_messagesTree`.
               * Added: 2026-02-07
               */}
              {(messagesTree && messagesTree.length == 0) || messagesTree === null ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef}>
                    <MultiMessage
                      key={conversationId}
                      messagesTree={messagesTree}
                      messageId={conversationId ?? null}
                      setCurrentEditId={setCurrentEditId}
                      currentEditId={currentEditId ?? null}
                    />
                  </div>
                </>
              )}
              {/* === VIVENTIUM END === */}
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          <CSSTransition
            in={showScrollButton && scrollButtonPreference}
            timeout={{
              enter: 550,
              exit: 700,
            }}
            classNames="scroll-animation"
            unmountOnExit={true}
            appear={true}
            nodeRef={scrollToBottomRef}
          >
            <ScrollToBottom ref={scrollToBottomRef} scrollHandler={handleSmoothToRef} />
          </CSSTransition>
        </div>
      </div>
    </>
  );
}

export default function MessagesView({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent messagesTree={messagesTree} />
    </MessagesViewProvider>
  );
}
