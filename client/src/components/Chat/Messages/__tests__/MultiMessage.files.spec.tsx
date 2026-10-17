/* === VIVENTIUM START === Saved channel user rows dispatch to the existing whole-message editor. === */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import MultiMessage from '../MultiMessage';

const mockAsk = jest.fn();
let mockMessage: TMessage;
jest.mock('jotai', () => ({ useAtomValue: () => 'text-base', atom: jest.fn() }));
jest.mock('recoil', () => ({
  useRecoilState: () => [0, jest.fn()],
  useRecoilValue: (key: string) => (key === 'direction' ? 'ltr' : false),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { chatDirection: 'direction', messagesSiblingIdxFamily: () => 'sibling' },
}));
jest.mock('~/Providers', () => {
  const React = jest.requireActual('react');
  return {
    MessageContext: React.createContext({}),
    useMessageContext: () => ({}),
    useMessagesConversation: () => ({ conversation: { conversationId: 'conversation' } }),
    useMessagesOperations: () => ({ getMessages: () => [mockMessage], setMessages: jest.fn() }),
  };
});
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({ attachments: [] }),
  useContentMetadata: () => ({ hasParallelContent: false }),
  useMessageProcess: () => ({
    conversation: { conversationId: 'conversation' },
    handleScroll: jest.fn(),
  }),
  useMessageActions: ({
    message,
    currentEditId,
  }: {
    message: TMessage;
    currentEditId?: string;
  }) => ({
    ask: mockAsk,
    edit: currentEditId === message.messageId,
    enterEdit: jest.fn(),
    conversation: { conversationId: 'conversation', endpoint: 'agents' },
    messageLabel: 'Message',
    latestMessageId: message.messageId,
    latestMessageDepth: message.depth,
  }),
}));
jest.mock('~/hooks/Chat', () => ({ useGetAddedConvo: () => () => null }));
jest.mock('~/utils', () => ({
  cn: () => '',
  getMessageAriaLabel: () => 'Message',
  removeFocusRings: '',
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateMessageMutation: () => ({ mutate: jest.fn() }),
}));
jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    TextareaAutosize: React.forwardRef(
      (
        props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
        ref: React.ForwardedRef<HTMLTextAreaElement>,
      ) => <textarea {...props} ref={ref} />,
    ),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    DelayedRender: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock(
  '../Content/Container',
  () =>
    ({ children }: { children: React.ReactNode }) =>
      children,
);
jest.mock('../Content/Markdown', () => ({ content }: { content: string }) => (
  <span>{content}</span>
));
jest.mock('../Content/MarkdownLite', () => () => null);
jest.mock('../Content/Parts/Thinking', () => () => null);
jest.mock('../Content/Parts/Attachment', () => ({ AttachmentGroup: () => null }));
jest.mock('~/components/Messages/Content/Error', () => () => null);
jest.mock('../ui/PlaceholderRow', () => () => null);
jest.mock('../SiblingSwitch', () => () => null);
jest.mock('../HoverButtons', () => () => null);
jest.mock('../MessageIcon', () => () => null);
jest.mock('../MessageParts', () => () => <div data-testid="assistants-parts" />);
jest.mock('../Content/ContentParts', () => ({ edit }: { edit: boolean }) => (
  <div data-testid="content-parts" data-edit={edit} />
));

beforeEach(() => {
  mockMessage = {
    messageId: 'user',
    conversationId: 'conversation',
    parentMessageId: 'previous',
    endpoint: 'agents',
    isCreatedByUser: true,
    text: '',
    content: [],
    depth: 1,
    files: [{ file_id: 'saved-file', filepath: '/uploads/input.txt', type: 'text/plain' }],
  };
});

function show(edit = true) {
  return render(
    <MultiMessage
      messagesTree={[mockMessage]}
      currentEditId={edit ? 'user' : null}
      setCurrentEditId={jest.fn()}
    />,
  );
}

test.each(['agents', 'assistants'])(
  'saved empty content[] user edit reaches the real editor: %s',
  async (endpoint) => {
    mockMessage.endpoint = endpoint;
    const before = JSON.stringify(mockMessage);
    show();
    expect(screen.getByTestId('message-text-editor')).toHaveValue('');
    await act(async () => {
      fireEvent.click(screen.getByText('com_ui_save_submit'));
    });
    expect(mockAsk).toHaveBeenCalledWith(
      { text: '', parentMessageId: 'previous', conversationId: 'conversation' },
      { overrideFiles: mockMessage.files, addedConvo: undefined },
    );
    expect(JSON.stringify(mockMessage)).toBe(before);
  },
);

test('saved user image parts retain exact caption and files through edit', async () => {
  mockMessage.text = '  Exact saved caption.  ';
  mockMessage.content = [
    { type: ContentTypes.IMAGE_URL, image_url: { url: '/uploads/input.png' } },
  ];
  const before = JSON.stringify(mockMessage);
  show();
  expect(screen.getByTestId('message-text-editor')).toHaveValue(mockMessage.text);
  fireEvent.change(screen.getByTestId('message-text-editor'), { target: { value: '' } });
  await act(async () => {
    fireEvent.click(screen.getByText('com_ui_save_submit'));
  });
  expect(mockAsk.mock.calls[0][0].text).toBe('');
  expect(mockAsk.mock.calls[0][1].overrideFiles).toBe(mockMessage.files);
  expect(JSON.stringify(mockMessage)).toBe(before);
});

test.each(['agents', 'assistants'])(
  'assistant %s editing keeps its existing part renderer',
  (endpoint) => {
    mockMessage.endpoint = endpoint;
    mockMessage.isCreatedByUser = false;
    mockMessage.content = [{ type: ContentTypes.TEXT, text: 'Assistant answer.' }];
    show();
    expect(
      screen.getByTestId(endpoint === 'agents' ? 'content-parts' : 'assistants-parts'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('message-text-editor')).not.toBeInTheDocument();
  },
);

test('ordinary saved user display keeps its existing content renderer', () => {
  show(false);
  expect(screen.getByTestId('content-parts')).toHaveAttribute('data-edit', 'false');
  expect(screen.queryByTestId('message-text-editor')).not.toBeInTheDocument();
});

test('legacy structured-only user text keeps its existing route', () => {
  delete (mockMessage as Partial<TMessage>).text;
  mockMessage.content = [{ type: ContentTypes.TEXT, text: 'Structured-only caption.' }];
  show();
  expect(screen.getByTestId('content-parts')).toHaveAttribute('data-edit', 'true');
  expect(screen.queryByTestId('message-text-editor')).not.toBeInTheDocument();
});

test.each(['', 'Saved text.'])(
  'user TEXT parts keep their existing persistence route: %j',
  (text) => {
    mockMessage.text = text;
    mockMessage.content = [{ type: ContentTypes.TEXT, text }];
    show();
    expect(screen.getByTestId('content-parts')).toHaveAttribute('data-edit', 'true');
    expect(screen.queryByTestId('message-text-editor')).not.toBeInTheDocument();
  },
);
/* === VIVENTIUM END === */
