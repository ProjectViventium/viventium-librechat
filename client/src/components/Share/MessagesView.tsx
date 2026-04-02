import { useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import MultiMessage from './MultiMessage';
import { useLocalize } from '~/hooks';
/* === VIVENTIUM START ===
 * Feature: Hide internal no-response ({NTA}) follow-ups from the Share UI
 *
 * Purpose:
 * - Filter internal no-response follow-ups from rendering/exporting in shared views.
 *
 * Added: 2026-02-07
 */
import { filterNoResponseMessagesTree } from '~/utils';
/* === VIVENTIUM END === */

export default function MessagesView({
  messagesTree: _messagesTree,
  conversationId,
}: {
  messagesTree?: TMessage[] | null;
  conversationId: string;
}) {
  const localize = useLocalize();
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  /* === VIVENTIUM DISABLED (2026-02-21) ===
   * NTA client-side auto-hide disabled on LC Web UI for full visibility.
   * Share view follows main Chat view policy — show ALL responses.
   * To re-enable: uncomment the filterNoResponseMessagesTree line below and
   * remove the passthrough assignment.
   *
   * Original feature added: 2026-02-07
   */
  // const messagesTree = filterNoResponseMessagesTree(_messagesTree);
  const messagesTree = _messagesTree;
  /* === VIVENTIUM END === */
  return (
    <div className="min-h-0 flex-1 overflow-hidden pb-[50px]">
      <div className="dark:gpt-dark-gray relative h-full">
        <div
          style={{
            height: '100%',
            overflowY: 'auto',
            width: '100%',
          }}
        >
          <div className="flex flex-col pb-9 text-sm dark:bg-transparent">
            {/* === VIVENTIUM START ===
             * Feature: Hide internal no-response ({NTA}) follow-ups from the Share UI
             * Purpose: Render filtered `messagesTree` instead of upstream raw `_messagesTree`.
             * Added: 2026-02-07
             */}
            {(messagesTree && messagesTree.length == 0) || messagesTree === null ? (
              <div className="flex w-full items-center justify-center gap-1 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-800/50 dark:bg-gray-800 dark:text-gray-300">
                {localize('com_ui_nothing_found')}
              </div>
            ) : (
              <>
                <div>
                  <MultiMessage
                    key={conversationId} // avoid internal state mixture
                    messagesTree={messagesTree}
                    messageId={conversationId ?? null}
                    setCurrentEditId={setCurrentEditId}
                    currentEditId={currentEditId ?? null}
                  />
                </div>
              </>
            )}
            {/* === VIVENTIUM END === */}
            <div className="dark:gpt-dark-gray group h-0 w-full flex-shrink-0 dark:border-gray-800/50" />
          </div>
        </div>
      </div>
    </div>
  );
}
