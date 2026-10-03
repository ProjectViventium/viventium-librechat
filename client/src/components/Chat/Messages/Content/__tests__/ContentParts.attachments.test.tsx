/* === VIVENTIUM START === Message files use the existing authenticated attachment UI. === */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContentTypes, FileSources, ToolCallTypes, Tools } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import ContentParts from '../ContentParts';

const mockLocalDownload = jest.fn();
const mockUrlDownload = jest.fn();
const mockFileIdentity = jest.fn();

jest.mock('~/data-provider', () => ({
  useFileDownload: (user?: string, fileId?: string) => {
    mockFileIdentity(user, fileId);
    return { refetch: mockLocalDownload };
  },
  useCodeOutputDownload: () => ({ refetch: mockUrlDownload }),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options: { 0?: string } = {}) =>
      key === 'com_ui_native_file_unavailable'
        ? `${options[0]} could not be attached.`
        : 'Attachment',
}));
jest.mock('~/utils', () => ({
  mapAttachments: jest.requireActual('~/utils/map').mapAttachments,
  cn: (...args: string[]) => args.join(' '),
}));
jest.mock('~/Providers', () => {
  const React = jest.requireActual('react');
  return {
    MessageContext: React.createContext({}),
    SearchContext: React.createContext({}),
  };
});
jest.mock('../Parts', () => ({
  AttachmentGroup: jest.requireActual('../Parts/Attachment').AttachmentGroup,
  EmptyText: () => null,
  EditTextPart: () => null,
}));
jest.mock('../Part', () => {
  const { AttachmentGroup } = jest.requireActual('../Parts/Attachment');
  return {
    __esModule: true,
    default: ({
      part,
      attachments,
    }: {
      part: TMessageContentParts;
      attachments?: TAttachment[];
    }) => (
      <>
        {part.type === 'text' && typeof part.text === 'string' && <span>{part.text}</span>}
        {part.type === 'tool_call' && <AttachmentGroup attachments={attachments} />}
      </>
    ),
  };
});
jest.mock('../MemoryArtifacts', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Web/Sources', () => ({ __esModule: true, default: () => null }));
jest.mock('../SiblingHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('../MessageContent', () => ({
  ErrorMessage: ({ text }: { text: string }) => <div role="alert">{text}</div>,
}));
jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({
    file,
    onClick,
  }: {
    file: { filename: string };
    onClick: React.MouseEventHandler<HTMLButtonElement>;
  }) => <button onClick={onClick}>{file.filename}</button>,
}));
jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText: string }) => <img alt={altText} />,
}));

const file = (filename = 'result.csv', toolCallId?: string): TAttachment =>
  ({
    filename,
    filepath: '/uploads/owner/file.csv',
    file_id: 'file',
    user: 'owner',
    source: FileSources.local,
    ...(toolCallId ? { toolCallId } : {}),
  }) as TAttachment;
const text: TMessageContentParts = { type: ContentTypes.TEXT, text: 'Useful answer.' };
const tool: TMessageContentParts = {
  type: ContentTypes.TOOL_CALL,
  tool_call: {
    type: ToolCallTypes.TOOL_CALL,
    id: 'call-a',
    name: 'file_tool',
    args: '{}',
    progress: 1,
  },
};
const message = (content: TMessageContentParts[], attachments?: TAttachment[]) => (
  <ContentParts
    content={content}
    attachments={attachments}
    messageId="answer"
    isCreatedByUser={false}
    isLast={true}
    isSubmitting={false}
  />
);

beforeEach(() => {
  mockLocalDownload.mockResolvedValue({ data: 'blob:authenticated-file' });
  mockUrlDownload.mockResolvedValue({ data: 'blob:external-file' });
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: jest.fn(), configurable: true });
});

test('an imported message file is visible and downloads through its authenticated File identity', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const attachments = [file()];
  const { rerender } = render(message([text], attachments));
  fireEvent.click(screen.getByRole('button', { name: 'result.csv' }));
  expect(mockFileIdentity).toHaveBeenCalledWith('owner', 'file');
  await waitFor(() => expect(mockLocalDownload).toHaveBeenCalledTimes(1));
  expect(mockUrlDownload).not.toHaveBeenCalled();
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  rerender(message([text], JSON.parse(JSON.stringify(attachments))));
  expect(screen.getAllByRole('button', { name: 'result.csv' })).toHaveLength(1);
  expect(screen.getByText('Useful answer.')).toBeVisible();
});

test('parallel message files render once while tool-owned files stay with their tool', () => {
  render(
    message(
      [
        { ...text, agentId: 'agent-a', groupId: 0 },
        { ...tool, agentId: 'agent-b', groupId: 0 },
      ],
      [file('message.csv'), file('tool.csv', 'call-a')],
    ),
  );
  expect(screen.getAllByRole('button', { name: 'message.csv' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'tool.csv' })).toHaveLength(1);
});

test('a tool-owned file is not repeated in the message attachment group', () => {
  render(message([text, tool], [file('tool.csv', 'call-a')]));
  expect(screen.getAllByRole('button', { name: 'tool.csv' })).toHaveLength(1);
});

test('an unavailable message file shows the existing notice without a fake download', () => {
  render(
    message(
      [text],
      [
        {
          filename: 'missing.csv',
          nativeOutputFile: {
            version: 1,
            status: 'unavailable',
            code: 'native_output_file_unavailable',
          },
        } as TAttachment,
      ],
    ),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('missing.csv could not be attached.');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Useful answer.')).toBeVisible();
});

test('message image files reuse the existing image rendering', () => {
  render(message([text], [{ ...file('image.png'), width: 80, height: 60 } as TAttachment]));
  expect(screen.getAllByRole('img', { name: 'image.png' })).toHaveLength(1);
});

test('plain answers and non-file search metadata produce no download', () => {
  render(message([text], [{ type: Tools.web_search } as TAttachment]));
  expect(screen.getByText('Useful answer.')).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
/* === VIVENTIUM END === */
