/* === VIVENTIUM START === Saved input files reuse authorized attachment downloads. === */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import Files from '../Files';
import LogLink from '../Parts/LogLink';

const mockApiDownload = jest.fn();
const mockUrlDownload = jest.fn();
const mockFileIdentity = jest.fn();
const mockToast = jest.fn();

jest.mock('~/data-provider', () => ({
  useFileDownload: (user?: string, fileId?: string) => {
    mockFileIdentity(user, fileId);
    return { refetch: mockApiDownload };
  },
  useCodeOutputDownload: () => ({ refetch: mockUrlDownload }),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockToast }),
}));
jest.mock('~/utils', () => ({
  getCachedPreview: jest.fn(),
  getFileType: () => ({ title: 'File' }),
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));
jest.mock('~/components/Chat/Input/Files/FilePreview', () => () => null);
jest.mock('~/components/Chat/Input/Files/RemoveFile', () => () => null);
jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText: string }) => <img alt={altText} />,
}));

const file = (source = FileSources.local): TFile => ({
  user: 'synthetic-owner',
  file_id: 'saved-audio',
  filename: 'input.wav',
  filepath: '/uploads/synthetic-owner/input.wav',
  type: 'audio/wav',
  bytes: 12,
  embedded: false,
  object: 'file',
  usage: 0,
  source,
});
const message = (files: TFile[]) => ({ messageId: 'source', files }) as TMessage;

beforeEach(() => {
  mockApiDownload.mockResolvedValue({ data: 'blob:authorized-file' });
  mockUrlDownload.mockResolvedValue({ data: 'blob:external-file' });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
});

test('saved audio click downloads the exact owned file before and after reload', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const saved = message([file()]);
  const before = JSON.stringify(saved);
  const { rerender } = render(<Files message={saved} />);
  expect(mockApiDownload).not.toHaveBeenCalled();
  expect(mockUrlDownload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'input.wav' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(mockFileIdentity).toHaveBeenCalledWith('synthetic-owner', 'saved-audio');
  expect(click.mock.instances[0]).toHaveAttribute('download', 'input.wav');
  expect(click.mock.instances[0]).toHaveAttribute('href', 'blob:authorized-file');
  expect(mockApiDownload).toHaveBeenCalledTimes(1);
  expect(mockUrlDownload).not.toHaveBeenCalled();
  rerender(<Files message={JSON.parse(before) as TMessage} />);
  fireEvent.click(screen.getByRole('button', { name: 'input.wav' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(saved)).toBe(before);
  expect(window.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

test.each([FileSources.firebase, FileSources.s3, FileSources.azure_blob, FileSources.text])(
  'saved %s input uses the existing authorized file endpoint',
  async (source) => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Files message={message([file(source)])} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.wav' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(mockApiDownload).toHaveBeenCalledTimes(1);
    expect(mockUrlDownload).not.toHaveBeenCalled();
  },
);

test('a rejected authorized download shows the existing error without a URL fallback', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockApiDownload.mockResolvedValue({ data: undefined, error: new Error('Forbidden') });
  render(<Files message={message([file()])} />);
  fireEvent.click(screen.getByRole('button', { name: 'input.wav' }));
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' })),
  );
  expect(click).not.toHaveBeenCalled();
  expect(mockUrlDownload).not.toHaveBeenCalled();
});

test('an existing text-source attachment link uses the server local strategy', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const saved = file(FileSources.text);
  render(
    <LogLink {...saved} href={saved.filepath}>
      {'Download text'}
    </LogLink>,
  );
  fireEvent.click(screen.getByText('Download text'));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(mockApiDownload).toHaveBeenCalledTimes(1);
  expect(mockUrlDownload).not.toHaveBeenCalled();
});

test('external code output keeps its existing URL download path', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(
    <LogLink {...file(FileSources.execute_code)} href="/api/files/code/session/file">
      {'Download output'}
    </LogLink>,
  );
  fireEvent.click(screen.getByText('Download output'));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(mockUrlDownload).toHaveBeenCalledTimes(1);
  expect(mockApiDownload).not.toHaveBeenCalled();
});

test('extracted text retains its displayed original name but downloads with a text suffix', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const saved = { ...file(FileSources.text), filename: 'report.pdf', type: 'application/pdf' };
  render(<Files message={message([saved])} />);
  fireEvent.click(screen.getByRole('button', { name: 'report.pdf' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(click.mock.instances[0]).toHaveAttribute('download', 'report.pdf.txt');
  expect(screen.getByRole('button', { name: 'report.pdf' })).toBeVisible();
});
/* === VIVENTIUM END === */
