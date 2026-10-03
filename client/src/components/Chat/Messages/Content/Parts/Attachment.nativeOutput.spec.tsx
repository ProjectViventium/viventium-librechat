/* === VIVENTIUM START === Native selected files retain honest replay presentation. === */
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import Attachment, { AttachmentGroup } from './Attachment';
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options: { 0?: string } = {}) => {
      if (key === 'com_ui_native_file_size_limit') return `${options[0]} is too large to attach.`;
      if (key === 'com_ui_native_file_unavailable') return `${options[0]} could not be attached.`;
      return 'Attachment';
    },
}));
jest.mock('../MessageContent', () => ({
  ErrorMessage: ({ text }: { text: string }) => <div role="alert">{text}</div>,
}));
jest.mock('./LogLink', () => ({ useAttachmentLink: () => ({ handleDownload: jest.fn() }) }));
jest.mock('~/utils', () => ({ cn: (...args: string[]) => args.join(' ') }));
jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file }: { file: { filename: string } }) => <button>{file.filename}</button>,
}));
jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: () => <img alt="file" />,
}));
const unavailable = (code = 'native_output_file_unavailable') =>
  ({
    filename: 'result.csv',
    messageId: 'answer',
    nativeOutputFile: { version: 1, status: 'unavailable', code },
  }) as TAttachment;
test('unavailable native selection is visible without a download button', () => {
  render(<Attachment attachment={unavailable()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('result.csv could not be attached.');
  expect(screen.queryByRole('button')).toBeNull();
});
test('size failure uses the typed limit instead of a retrieval claim', () => {
  render(<Attachment attachment={unavailable('native_output_file_size_limit')} />);
  expect(screen.getByRole('alert')).toHaveTextContent('result.csv is too large to attach.');
});
test('group/reload retains useful normal file plus unavailable receipt', () => {
  const selected = {
    filename: 'valid.csv',
    filepath: '/uploads/owner/file.csv',
    file_id: 'file',
    user: 'owner',
  } as TAttachment;
  const { rerender } = render(<AttachmentGroup attachments={[selected, unavailable()]} />);
  expect(screen.getByRole('button')).toHaveTextContent('valid.csv');
  expect(screen.getByRole('alert')).toBeVisible();
  rerender(<AttachmentGroup attachments={JSON.parse(JSON.stringify([selected, unavailable()]))} />);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
test('unknown receipt is not misrepresented as an unavailable native output', () => {
  render(
    <Attachment
      attachment={
        {
          ...unavailable(),
          nativeOutputFile: { version: 2, status: 'unavailable' },
        } as unknown as TAttachment
      }
    />,
  );
  expect(screen.queryByRole('alert')).toBeNull();
});
/* === VIVENTIUM END === */
