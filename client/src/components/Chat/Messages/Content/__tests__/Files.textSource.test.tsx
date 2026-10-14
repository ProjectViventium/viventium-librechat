import React from 'react';
import { render, screen } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('~/utils', () => ({ getCachedPreview: jest.fn() }));
jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ imagePath, file }: { imagePath: string; file?: TFile }) => (
    <img alt="image" src={imagePath} data-file-id={file?.file_id} />
  ),
}));
jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file }: { file: TFile }) => <span data-testid="file">{file.filename}</span>,
}));

const file = (source: FileSources): TFile => ({
  user: 'synthetic-owner',
  file_id: 'svg-file',
  bytes: 12,
  embedded: false,
  filename: 'drawing.svg',
  filepath: '/temporary/drawing.svg',
  object: 'file',
  type: 'image/svg+xml',
  usage: 0,
  source,
});
const message = (files: TFile[]) => ({ messageId: 'message', files }) as TMessage;

test('text source SVG stays a file after reload without its cached image preview', () => {
  const saved = message([file(FileSources.text)]);
  const { rerender } = render(<Files message={saved} />);
  expect(screen.getByTestId('file')).toHaveTextContent('drawing.svg');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  rerender(<Files message={JSON.parse(JSON.stringify(saved)) as TMessage} />);
  expect(screen.getByTestId('file')).toHaveTextContent('drawing.svg');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('ordinary provider images retain their image presentation beside text context files', () => {
  render(
    <Files
      message={message([
        file(FileSources.text),
        { ...file(FileSources.local), file_id: 'provider-svg', filepath: '/uploads/provider.svg' },
      ])}
    />,
  );
  expect(screen.getByTestId('file')).toHaveTextContent('drawing.svg');
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.getByRole('img')).toHaveAttribute('src', '/uploads/provider.svg');
});

test('raw image preview receives the same canonical file identity after reload', () => {
  const raw = {
    ...file(FileSources.local),
    file_id: 'raw-svg',
    filepath: '/uploads/synthetic-owner/raw.svg',
  };
  const { rerender } = render(<Files message={message([raw])} />);
  expect(screen.getByRole('img')).toHaveAttribute('data-file-id', raw.file_id);
  rerender(<Files message={JSON.parse(JSON.stringify(message([raw]))) as TMessage} />);
  expect(screen.getByRole('img')).toHaveAttribute('data-file-id', raw.file_id);
});
