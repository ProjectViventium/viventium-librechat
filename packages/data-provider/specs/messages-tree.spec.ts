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

  test('renders chained Listen-Only transcripts as one linear lane', () => {
    const tree = buildTree({
      messages: [
        {
          messageId: 'user-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: 'Question',
          createdAt: '2026-03-26T17:15:37.000Z',
        } as any,
        {
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          text: 'Answer',
          createdAt: '2026-03-26T17:16:31.000Z',
        } as any,
        {
          messageId: 'listen-only-1',
          parentMessageId: 'assistant-1',
          text: 'Ambient transcript 1',
          createdAt: '2026-03-26T17:17:00.000Z',
          metadata: { viventium: { type: 'listen_only_transcript', mode: 'listen_only' } },
        } as any,
        {
          messageId: 'listen-only-2',
          parentMessageId: 'listen-only-1',
          text: 'Ambient transcript 2',
          createdAt: '2026-03-26T17:18:00.000Z',
          metadata: { viventium: { type: 'listen_only_transcript', mode: 'listen_only' } },
        } as any,
        {
          messageId: 'listen-only-3',
          parentMessageId: 'listen-only-2',
          text: 'Ambient transcript 3',
          createdAt: '2026-03-26T17:19:00.000Z',
          metadata: { viventium: { type: 'listen_only_transcript', mode: 'listen_only' } },
        } as any,
      ],
    });

    const assistant = tree?.[0]?.children?.[0];
    expect(assistant?.children).toHaveLength(1);
    expect(assistant?.children?.[0]).toMatchObject({
      messageId: 'listen-only-1',
      siblingIndex: 0,
      children: [
        expect.objectContaining({
          messageId: 'listen-only-2',
          siblingIndex: 0,
          children: [
            expect.objectContaining({
              messageId: 'listen-only-3',
              siblingIndex: 0,
            }),
          ],
        }),
      ],
    });
  });
});
