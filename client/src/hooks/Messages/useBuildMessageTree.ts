import { useRecoilCallback } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
/* === VIVENTIUM START === Export the same visible autonomous results and selected branches. === */
import {
  getMessageBranchChoices,
  isTrustedSystemMessageGroup,
  selectVisibleMessageBranches,
} from '~/utils/noResponseTag';
/* === VIVENTIUM END === */
import store from '~/store';

export default function useBuildMessageTree() {
  const getSiblingIdx = useRecoilCallback(
    ({ snapshot }) =>
      async (messageId: string | null | undefined) =>
        await snapshot.getPromise(store.messagesSiblingIdxFamily(messageId)),
    [],
  );

  // return an object or an array based on branches and recursive option
  // messageId is used to get siblindIdx from recoil snapshot
  const buildMessageTree = async ({
    messageId,
    message,
    messages,
    branches = false,
    recursive = false,
    preserveInternalStructure = false,
  }: {
    messageId: string | null | undefined;
    message: Partial<TMessage> | null;
    messages: Array<Partial<TMessage> | undefined> | null;
    branches?: boolean;
    recursive?: boolean;
    preserveInternalStructure?: boolean;
  }): Promise<TMessage | Array<Partial<TMessage> | undefined>> => {
    const children: Array<Partial<TMessage> | undefined> = [];
    if (messages?.length != null && messages.length > 0) {
      const sourceMessages = messages.filter((candidate): candidate is TMessage =>
        Boolean(candidate),
      );
      const choices = getMessageBranchChoices(sourceMessages);
      const siblingIdx = choices.length > 1 ? await getSiblingIdx(messageId) : 0;
      const selected = choices[choices.length - siblingIdx - 1] ?? choices[choices.length - 1];
      let visible = sourceMessages;
      if (!branches)
        visible = selected ? selectVisibleMessageBranches(sourceMessages, selected.messageId) : [];
      for (const child of visible) {
        const result = await buildMessageTree({
          messageId: child.messageId,
          message: child,
          messages: child.children ?? [],
          branches,
          recursive,
          preserveInternalStructure,
        });
        children.push(...(Array.isArray(result) ? result : [result]));
      }
    }

    const metadata = message?.metadata as
      | {
          viventium?: {
            visibility?: string;
            interactionContext?: { actor_kind?: string; origin?: string };
          };
        }
      | undefined;
    const context = metadata?.viventium?.interactionContext;
    const visibleMessage =
      preserveInternalStructure && metadata?.viventium?.visibility === 'internal'
        ? {
            ...message,
            text: '',
            content: [],
            attachments: undefined,
            files: undefined,
            metadata: {
              viventium: {
                visibility: 'internal',
                interactionContext: {
                  actor_kind: context?.actor_kind,
                  origin: context?.origin,
                },
              },
            },
          }
        : message;
    const includeMessage =
      visibleMessage && (preserveInternalStructure || !isTrustedSystemMessageGroup(visibleMessage));
    if (recursive && includeMessage) {
      return { ...(visibleMessage as TMessage), children: children as TMessage[] };
    } else {
      let ret: TMessage[] = [];
      if (includeMessage) {
        const _message = { ...visibleMessage };
        delete _message.children;
        ret = [_message as TMessage];
      }
      for (const child of children) {
        ret = ret.concat(child as TMessage);
      }
      return ret;
    }
  };

  return buildMessageTree;
}
