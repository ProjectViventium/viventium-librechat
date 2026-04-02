import { buildTree } from '../src/messages';

describe('buildTree', () => {
  test('attaches a child to its parent even when the child is fetched first', () => {
    const tree = buildTree({
      messages: [
        {
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          text: 'Answer',
          createdAt: '2026-03-26T17:16:31.602Z',
        } as any,
        {
          messageId: 'user-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: 'Question',
          createdAt: '2026-03-26T17:15:37.748Z',
        } as any,
      ],
    });

    expect(tree).toHaveLength(1);
    expect(tree?.[0]).toMatchObject({
      messageId: 'user-1',
      depth: 0,
      children: [
        expect.objectContaining({
          messageId: 'assistant-1',
          depth: 1,
          siblingIndex: 0,
        }),
      ],
    });
  });

  test('assigns sibling order by createdAt instead of input order', () => {
    const tree = buildTree({
      messages: [
        {
          messageId: 'assistant-2',
          parentMessageId: 'user-1',
          text: 'Second answer',
          createdAt: '2026-03-26T17:16:40.000Z',
        } as any,
        {
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          text: 'First answer',
          createdAt: '2026-03-26T17:16:31.000Z',
        } as any,
        {
          messageId: 'user-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: 'Question',
          createdAt: '2026-03-26T17:15:37.000Z',
        } as any,
      ],
    });

    expect(tree?.[0]?.children?.map((message) => message.messageId)).toEqual([
      'assistant-1',
      'assistant-2',
    ]);
    expect(tree?.[0]?.children?.map((message) => message.siblingIndex)).toEqual([0, 1]);
  });
});
