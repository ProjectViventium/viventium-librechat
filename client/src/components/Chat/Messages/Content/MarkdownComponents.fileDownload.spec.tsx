/* === VIVENTIUM START === Imported File links keep the authorized owner and original filename. === */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { a as MarkdownAnchor, img as MarkdownImage } from './MarkdownComponents';
import { MessageContext } from '~/Providers/MessageContext';
import type { TAttachment } from 'librechat-data-provider';
const mockDownload = jest.fn(async () => ({ data: 'blob:synthetic-owned-file' }));
const mockFileDownload = jest.fn((..._args: string[]) => ({ refetch: mockDownload }));
jest.mock('./Image', () => ({ __esModule: true, default: (props: { imagePath: string; altText: string; file: TAttachment }) =>
  <img alt={props.altText} src={`owned:${props.file.file_id}`} data-path={props.imagePath} /> }));
jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'owner' }) }));
jest.mock('~/store', () => ({ __esModule: true, default: { user: 'synthetic-user-atom' } }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/data-provider', () => ({
  useFileDownload: (...args: string[]) => mockFileDownload(...args),
  useGetStartupConfig: () => ({ data: {} }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => ({ __esModule: true, default: () => false }));
jest.mock('~/Providers', () => ({ useCodeBlockContext: () => ({}),
  useMessageContext: jest.requireActual('~/Providers/MessageContext').useMessageContext }));
jest.mock('~/utils', () => ({ handleDoubleClick: jest.fn() }));
jest.mock('~/hooks', () => ({ useLocalize: () => (value: string) => value }));
jest.mock('~/components/Messages/Content/MermaidErrorBoundary', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Messages/Content/CodeBlock', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Messages/Content/Mermaid', () => ({ __esModule: true, default: () => null }));

test.each([
  ['copy%20%5Bfinal%5D.md', 'copy [final].md'],
  ['literal%2520.md', 'literal%20.md'],
  ['result.csv', 'result.csv'],
  ['bad%legacy.md', 'bad%legacy.md'],
])('ordinary File link decodes its filename once: %s', async (segment, expected) => {
  const downloads: string[] = [];
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    downloads.push(this.download);
  });
  const originalRevoke = window.URL.revokeObjectURL;
  window.URL.revokeObjectURL = jest.fn();
  try {
    render(<MarkdownAnchor href={`/files/owner/native_imported/${segment}`}>Download</MarkdownAnchor>);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloads).toEqual([expected]));
    expect(mockFileDownload).toHaveBeenCalledWith('owner', 'native_imported');
  } finally {
    click.mockRestore();
    window.URL.revokeObjectURL = originalRevoke;
  }
});
const grant = 'https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef';
const owned = { user: 'owner', file_id: 'native_' + 'a'.repeat(64), filename: 'copy [final].md',
  filepath: '/uploads/owner/immutable.md', bytes: 19, type: 'text/markdown', source: 'local', object: 'file',
  nativeOutputFile: { version: 1, status: 'available', messageId: 'answer', downloadUrl: grant } } as TAttachment;
function renderGrant(attachments: TAttachment[] = [owned], href = grant, messageId = 'answer') {
  return render(<MessageContext.Provider value={{ messageId, isExpanded: true,
    viventiumFileAttachments: attachments }}>
    <MarkdownAnchor href={href}>Download</MarkdownAnchor>
  </MessageContext.Provider>);
}
test('exact verified native grant uses normal File download without changing authored source or binding', async () => {
  const before = JSON.stringify(owned);
  const downloads: string[] = [];
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloads.push(this.download); });
  const revoke = window.URL.revokeObjectURL;
  window.URL.revokeObjectURL = jest.fn();
  try {
    renderGrant();
    const anchor = screen.getByRole('button', { name: 'Download' });
    expect(anchor).not.toHaveAttribute('href');
    fireEvent.click(anchor);
    await waitFor(() => expect(downloads).toEqual(['copy [final].md']));
    expect(mockFileDownload).toHaveBeenCalledWith('owner', owned.file_id);
    expect(JSON.stringify(owned)).toBe(before);
  } finally { click.mockRestore(); window.URL.revokeObjectURL = revoke; }
});
test.each([
  ['missing import', [], grant, 'answer'],
  ['foreign owner', [{ ...owned, user: 'other' }], grant, 'answer'],
  ['missing File id', [{ ...owned, file_id: '' }], grant, 'answer'],
  ['ordinary unbound File', [{ ...owned, file_id: 'ordinary_file' }], grant, 'answer'],
  ['missing filepath', [{ ...owned, filepath: '' }], grant, 'answer'],
  ['missing filename', [{ ...owned, filename: '' }], grant, 'answer'],
  ['foreign message', [owned], grant, 'other'],
  ['partial grant', [owned], grant + '?other=1', 'answer'],
  ['unrelated URL', [owned], 'https://unrelated.example.test/file', 'answer'],
  ['unavailable import', [{ ...owned, nativeOutputFile: { version: 1, status: 'unavailable', code: 'native_output_file_unavailable' } }], grant, 'answer'],
])('keeps %s external; it gains no File download binding', (_label, attachments, href, messageId) => {
  renderGrant(attachments as TAttachment[], href as string, messageId as string);
  expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', href);
  expect(mockFileDownload).toHaveBeenCalledWith('owner', '');
});
/* === VIVENTIUM END === */

test('selected image grant opens through the exact owner/message File viewer', () => {
  const image = { ...owned, type: 'image/png', filename: 'evidence.png' } as TAttachment;
  render(<MessageContext.Provider value={{ messageId: 'answer', isExpanded: true,
    viventiumFileAttachments: [image] }}><MarkdownImage src={grant} alt="Selected evidence" /></MessageContext.Provider>);
  expect(screen.getByRole('img', { name: 'Selected evidence' })).toHaveAttribute('src', `owned:${owned.file_id}`);
});
test('foreign image grant cannot borrow a File viewer binding', () => {
  const image = { ...owned, type: 'image/png', filename: 'evidence.png', user: 'other' } as TAttachment;
  render(<MessageContext.Provider value={{ messageId: 'answer', isExpanded: true,
    viventiumFileAttachments: [image] }}><MarkdownImage src={grant} alt="Foreign" /></MessageContext.Provider>);
  expect(screen.getByRole('img', { name: 'Foreign' })).toHaveAttribute('src', grant);
});
