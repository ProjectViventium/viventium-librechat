import React from 'react';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile } from 'librechat-data-provider';
import Image from '../Image';
const mockGetFileDownload = jest.fn();
jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  FileSources: { local: 'local' },
  QueryKeys: { fileDownload: 'fileDownload' },
  dataService: { getFileDownload: (...args: string[]) => mockGetFileDownload(...args) },
}));
jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.flat().filter(Boolean).join(' '),
}));
jest.mock('@librechat/client', () => ({ Skeleton: () => <span /> }));
jest.mock('../DialogImage', () => ({ __esModule: true, default: () => null }));
const file: Pick<TFile, 'user' | 'file_id' | 'source' | 'type' | 'filepath'> = {
  user: 'synthetic-owner',
  file_id: 'original-svg',
  source: 'local' as TFile['source'],
  type: 'image/svg+xml',
  filepath: '/uploads/synthetic-owner/original.svg',
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="9"><script>void 0</script></svg>';
const response = (identity = file.file_id) => ({
  data: new Blob([svg], { type: 'application/octet-stream' }),
  headers: { 'x-file-metadata': JSON.stringify({ file_id: identity, type: file.type }) },
});
const renderImage = (current = file) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Image imagePath={current.filepath} altText="original.svg" file={current} />, {
    wrapper,
  });
};
beforeEach(() => {
  jest.clearAllMocks();
  mockGetFileDownload.mockResolvedValue(response());
  window.URL.createObjectURL = jest.fn().mockReturnValue('blob:verified-original');
  window.URL.revokeObjectURL = jest.fn();
});
afterEach(cleanup);
test('reload uses authenticated original bytes/MIME in an image-only Blob and revokes it', async () => {
  const view = renderImage();
  await waitFor(() =>
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:verified-original'),
  );
  expect(mockGetFileDownload).toHaveBeenCalledWith(file.user, file.file_id);
  const blob = (window.URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
  expect(blob.type).toBe(file.type);
  expect(blob.size).toBe(new Blob([svg]).size);
  expect(view.container.querySelector('svg')).toBeNull();
  expect(view.container.querySelector('script')).toBeNull();
  view.unmount();
  expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:verified-original');
  renderImage();
  await waitFor(() =>
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:verified-original'),
  );
  expect(mockGetFileDownload).toHaveBeenCalledTimes(2);
});
test.each(['denied', 'wrong identity', 'malformed metadata', 'wrong MIME'])(
  'does not use raw/public path fallback after %s',
  async (failure) => {
    if (failure === 'denied') mockGetFileDownload.mockRejectedValue(new Error('403'));
    if (failure === 'wrong identity')
      mockGetFileDownload.mockResolvedValue(response('different-file'));
    if (failure === 'malformed metadata')
      mockGetFileDownload.mockResolvedValue({ ...response(), headers: { 'x-file-metadata': '{' } });
    if (failure === 'wrong MIME')
      mockGetFileDownload.mockResolvedValue({
        ...response(),
        headers: {
          'x-file-metadata': JSON.stringify({ file_id: file.file_id, type: 'text/html' }),
        },
      });
    renderImage();
    await waitFor(() => expect(mockGetFileDownload).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('img')).not.toHaveAttribute('src', file.filepath);
  },
);
test('late old-file response cannot install an old Blob after identity changes', async () => {
  let resolveOld: (value: ReturnType<typeof response>) => void = () => {};
  mockGetFileDownload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const nextFile = { ...file, file_id: 'new-original' };
  mockGetFileDownload.mockResolvedValue(response(nextFile.file_id));
  const view = renderImage();
  await waitFor(() => expect(mockGetFileDownload).toHaveBeenCalledTimes(1));
  view.rerender(<Image imagePath={nextFile.filepath} altText="original.svg" file={nextFile} />);
  await waitFor(() =>
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:verified-original'),
  );
  await act(async () => {
    resolveOld(response());
  });
  expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
});
test('ordinary /images keeps its URL and does not fetch through the upload API', () => {
  renderImage({ ...file, filepath: '/images/synthetic-owner/original.png' });
  expect(screen.getByRole('img')).toHaveAttribute('src', '/images/synthetic-owner/original.png');
  expect(mockGetFileDownload).not.toHaveBeenCalled();
});
