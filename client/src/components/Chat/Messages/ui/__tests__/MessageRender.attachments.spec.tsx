/* === VIVENTIUM START === Plain-text messages use the same authenticated file delivery. === */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { TAttachment, TMessage } from 'librechat-data-provider';
import MessageRender from '../MessageRender';

const mockLocalDownload = jest.fn();
const mockUrlDownload = jest.fn();
const mockFileIdentity = jest.fn();

jest.mock('jotai', () => ({ useAtomValue: () => 'text-base', atom: jest.fn() }));
jest.mock('recoil', () => ({ useRecoilValue: () => false }));
jest.mock('~/store', () => ({}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: ({ attachments }: { attachments?: TAttachment[] }) => ({ attachments }),
  useMessageContext: () => ({ isSubmitting: false, isLatestMessage: true }),
  useMessageActions: () => ({
    conversation: { conversationId: 'conversation' },
    messageLabel: 'Assistant',
    latestMessageId: 'answer',
    latestMessageDepth: 1,
  }),
  useContentMetadata: () => ({ hasParallelContent: false }),
}));
jest.mock('~/Providers', () => {
  const React = jest.requireActual('react');
  return {
    MessageContext: React.createContext({}),
    useMessageContext: () => ({ isSubmitting: false, isLatestMessage: true }),
  };
});
jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  getMessageAriaLabel: () => 'Assistant message',
}));
jest.mock('~/data-provider', () => ({
  useFileDownload: (user?: string, fileId?: string) => {
    mockFileIdentity(user, fileId);
    return { refetch: mockLocalDownload };
  },
  useCodeOutputDownload: () => ({ refetch: mockUrlDownload }),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  DelayedRender: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock(
  '~/components/Chat/Messages/Content/Markdown',
  () =>
    ({ content }: { content: string }) => <span>{content}</span>,
);
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => () => null);
jest.mock('~/components/Chat/Messages/Content/EditMessage', () => () => null);
jest.mock('~/components/Chat/Messages/Content/Parts/Thinking', () => () => null);
jest.mock('~/components/Messages/Content/Error', () => ({ text }: { text: string }) => (
  <span>{text}</span>
));
jest.mock('~/components/Chat/Messages/ui/PlaceholderRow', () => () => null);
jest.mock('~/components/Chat/Messages/SiblingSwitch', () => () => null);
jest.mock('~/components/Chat/Messages/HoverButtons', () => () => null);
jest.mock('~/components/Chat/Messages/MessageIcon', () => () => null);
jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({
    file,
    onClick,
  }: {
    file: TAttachment;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
  }) => <button onClick={onClick}>{file.filename}</button>,
}));
jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText: string }) => <img alt={altText} />,
}));

const file = (filename = 'comparison.csv', toolCallId?: string): TAttachment =>
  ({
    filename,
    filepath: '/uploads/owner/comparison.csv',
    file_id: 'owned-file',
    user: 'owner',
    source: FileSources.local,
    type: 'text/csv',
    ...(toolCallId ? { toolCallId } : {}),
  }) as TAttachment;
const message = (text: string, attachments?: TAttachment[]): TMessage => ({
  messageId: 'answer',
  conversationId: 'conversation',
  parentMessageId: 'question',
  isCreatedByUser: false,
  endpoint: 'agents',
  text,
  attachments,
  unfinished: false,
  error: false,
});
const show = (text: string, attachments?: TAttachment[]) => (
  <MessageRender message={message(text, attachments)} currentEditId={null} />
);

beforeEach(() => {
  mockLocalDownload.mockResolvedValue({ data: 'blob:authenticated-file' });
  mockUrlDownload.mockResolvedValue({ data: 'blob:external-file' });
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: jest.fn(), configurable: true });
});

test('a saved plain-text reply shows its file once and uses the owning authenticated download', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const attachments = [file()];
  const { rerender } = render(show('Your comparison is ready.', attachments));
  fireEvent.click(screen.getByRole('button', { name: 'comparison.csv' }));
  expect(mockFileIdentity).toHaveBeenCalledWith('owner', 'owned-file');
  await waitFor(() => expect(mockLocalDownload).toHaveBeenCalledTimes(1));
  expect(mockUrlDownload).not.toHaveBeenCalled();
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  rerender(show('Your comparison is ready.', JSON.parse(JSON.stringify(attachments))));
  expect(screen.getAllByRole('button', { name: 'comparison.csv' })).toHaveLength(1);
  expect(screen.getByText('Your comparison is ready.')).toBeVisible();
});

test('a file-only reply does not need an invented content array or public text', () => {
  render(show('', [file()]));
  expect(screen.getAllByRole('button', { name: 'comparison.csv' })).toHaveLength(1);
});

test('the message group does not duplicate attachments owned by a tool call', () => {
  render(show('Your comparison is ready.', [file(), file('tool.csv', 'call-a')]));
  expect(screen.getAllByRole('button', { name: 'comparison.csv' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'tool.csv' })).not.toBeInTheDocument();
});

test('ordinary plain-text replies keep their text without a file control', () => {
  render(show('The bus leaves at noon.'));
  expect(screen.getByText('The bus leaves at noon.')).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(mockLocalDownload).not.toHaveBeenCalled();
});
/* === VIVENTIUM END === */
