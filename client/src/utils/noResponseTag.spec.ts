import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { filterNoResponseMessagesTree } from './noResponseTag';

function mkMessage({
  messageId,
  parentMessageId,
  text,
  isCreatedByUser,
  children,
}: {
  messageId: string;
  parentMessageId: string;
  text: string;
  isCreatedByUser: boolean;
  children?: TMessage[];
}): TMessage {
  return {
    messageId,
    parentMessageId,
    conversationId: 'convo-1',
    sender: isCreatedByUser ? 'User' : 'Viventium',
    text,
    isCreatedByUser,
    children: children ?? [],
  } as TMessage;
}

describe('filterNoResponseMessagesTree', () => {
  test('hides no-response assistant messages by default', () => {
    const root = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Normal user message',
      isCreatedByUser: true,
      children: [
        mkMessage({
          messageId: 'a1',
          parentMessageId: 'u1',
          text: '{NTA}',
          isCreatedByUser: false,
        }),
      ],
    });

    const filtered = filterNoResponseMessagesTree([root]);
    expect(filtered?.[0]?.children?.length).toBe(0);
  });

  test('keeps a minimal placeholder for no-response after scheduled brew prompts in chat mode', () => {
    const brewPrompt = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: '<!--viv_internal:brew_begin-->\n## Background Processing (Brewing)\nStrattera monitoring...',
      isCreatedByUser: true,
      children: [
        {
          ...mkMessage({
            messageId: 'a1',
            parentMessageId: 'u1',
            text: '',
            isCreatedByUser: false,
          }),
          content: [{ type: ContentTypes.TEXT, text: '{NTA}' }],
        } as TMessage,
      ],
    });

    const filtered = filterNoResponseMessagesTree([brewPrompt], {
      brewNoResponsePlaceholder: '-',
    });

    expect(filtered?.[0]?.children?.length).toBe(1);
    expect(filtered?.[0]?.children?.[0]?.text).toBe('-');
    expect(filtered?.[0]?.children?.[0]?.content?.[0]?.type).toBe(ContentTypes.TEXT);
    expect((filtered?.[0]?.children?.[0]?.content?.[0] as { text?: string })?.text).toBe('-');
  });

  test('does not show placeholder for non-brew no-response messages even when option is enabled', () => {
    const root = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'hi',
      isCreatedByUser: true,
      children: [
        mkMessage({
          messageId: 'a1',
          parentMessageId: 'u1',
          text: '{NTA}',
          isCreatedByUser: false,
        }),
      ],
    });

    const filtered = filterNoResponseMessagesTree([root], {
      brewNoResponsePlaceholder: '-',
    });

    expect(filtered?.[0]?.children?.length).toBe(0);
  });
});
