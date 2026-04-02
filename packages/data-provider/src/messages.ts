import type { TFile } from './types/files';
import type { TMessage } from './types';

export type ParentMessage = TMessage & { children: TMessage[]; depth: number };

function toTimestamp(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return Number.NaN;
  }

  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : Number.NaN;
}

export function buildTree({
  messages,
  fileMap,
}: {
  messages: (TMessage | undefined)[] | null;
  fileMap?: Record<string, TFile>;
}) {
  if (messages === null) {
    return null;
  }

  const messageMap: Record<string, ParentMessage> = {};
  const rootMessages: ParentMessage[] = [];
  const childrenCount: Record<string, number> = {};
  const orderedMessages = messages
    .filter((message): message is TMessage => Boolean(message))
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftCreated = toTimestamp((left.message as Record<string, unknown>).createdAt);
      const rightCreated = toTimestamp((right.message as Record<string, unknown>).createdAt);
      if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
        return leftCreated - rightCreated;
      }

      const leftUpdated = toTimestamp((left.message as Record<string, unknown>).updatedAt);
      const rightUpdated = toTimestamp((right.message as Record<string, unknown>).updatedAt);
      if (Number.isFinite(leftUpdated) && Number.isFinite(rightUpdated) && leftUpdated !== rightUpdated) {
        return leftUpdated - rightUpdated;
      }

      return left.index - right.index;
    });

  orderedMessages.forEach(({ message }) => {
    const extendedMessage: ParentMessage = {
      ...message,
      children: [],
      depth: 0,
      siblingIndex: 0,
    };

    if (message.files && fileMap) {
      extendedMessage.files = message.files.map((file) => fileMap[file.file_id ?? ''] ?? file);
    }

    messageMap[message.messageId] = extendedMessage;
  });

  orderedMessages.forEach(({ message }) => {
    const parentId = message.parentMessageId ?? '';
    childrenCount[parentId] = (childrenCount[parentId] || 0) + 1;

    const extendedMessage = messageMap[message.messageId];
    extendedMessage.siblingIndex = childrenCount[parentId] - 1;

    const parentMessage = messageMap[parentId];
    if (parentMessage && parentMessage.messageId !== extendedMessage.messageId) {
      parentMessage.children.push(extendedMessage);
    } else {
      rootMessages.push(extendedMessage);
    }
  });

  const setDepth = (message: ParentMessage, depth: number) => {
    message.depth = depth;
    message.children.forEach((child) => {
      setDepth(child as ParentMessage, depth + 1);
    });
  };

  rootMessages.forEach((message) => setDepth(message, 0));

  return rootMessages;
}
