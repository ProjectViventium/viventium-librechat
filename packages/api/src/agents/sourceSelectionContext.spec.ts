import {
  buildTrustedSourceSelectionCapsule,
  type TrustedSourceSegment,
} from './sourceSelectionContext';

const file = {
  file_id: '12345678-1234-4234-8234-123456789abc',
  filename: 'answer.wav',
  type: 'audio/wav',
  bytes: 403172,
};
const source = {
  source_event_id: 'current',
  text: '',
  source_files: [file],
  authoring_revision: 2,
};
const capsule = (sources: TrustedSourceSegment[] = [source], supersedeScope = 'response_only') =>
  buildTrustedSourceSelectionCapsule(
    { source_event_id: 'current', revision: 2, source_segments: sources },
    { supersede_scope: supersedeScope },
  );
function decoded(text: string) {
  const encoded = text
    .split('<viventium_rapid_source_selection encoding="base64url-json-v1">')[1]
    .split('\n')
    .find((line) => /^[A-Za-z0-9_-]+$/.test(line))!;
  return JSON.parse(Buffer.from(encoded, 'base64url').toString());
}

test.each(['audio/wav', 'video/mp4', 'image/png', 'text/csv', 'application/pdf'])(
  'one attachment-only source retains its current identity and exact %s reference',
  (type) => {
    const result = capsule([{ ...source, source_files: [{ ...file, type }] }]);
    expect(decoded(result).sources).toEqual([
      {
        sourceOrdinal: 1,
        label: 'S1',
        preview: '',
        previewTruncated: false,
        attachmentCount: 1,
        attachments: [{ ...file, type }],
      },
    ]);
    expect(result).toContain('current accepted input');
    expect(result).toContain('other available files remain historical context');
    expect(result).not.toContain('Multiple unresolved');
  },
);
test('one captioned source keeps original text and strips paths and transport identities', () => {
  const result = capsule([
    {
      ...source,
      text: 'Use this file.',
      source_files: [
        { ...file, filepath: '/private/synthetic.wav', source_event_id: 'raw-transport-id' },
      ],
    },
  ]);
  expect(decoded(result).sources[0]).toMatchObject({
    preview: 'Use this file.',
    attachments: [file],
  });
  expect(JSON.stringify(decoded(result))).not.toMatch(/filepath|private|raw-transport-id/);
});
test('additive authoring exposes only its current files with the full ledger S-number', () => {
  const prior = {
    ...source,
    source_event_id: 'prior',
    authoring_revision: 1,
    source_files: [{ ...file, file_id: 'earlier-file', filename: 'shapes.png', type: 'image/png' }],
  };
  const result = capsule([prior, source]);
  expect(decoded(result).sources).toEqual([
    {
      sourceOrdinal: 2,
      label: 'S2',
      preview: '',
      previewTruncated: false,
      attachmentCount: 1,
      attachments: [file],
    },
  ]);
  expect(result).toContain('Earlier unresolved inputs already have independent authoring owners');
  expect(JSON.stringify(decoded(result))).not.toContain('earlier-file');
});
test('multiple owned sources keep their exact text and attachment bindings', () => {
  const result = capsule(
    [
      { ...source, source_event_id: 'first', text: 'Read this.' },
      { ...source, text: 'What is six times seven?', source_files: [] },
    ],
    'logical_turn',
  );
  expect(
    decoded(result).sources.map((item: { sourceOrdinal: number; attachmentCount: number }) => [
      item.sourceOrdinal,
      item.attachmentCount,
    ]),
  ).toEqual([
    [1, 1],
    [2, 0],
  ]);
  expect(result).toContain('Multiple unresolved user inputs');
});
test('ordinary single text input adds no capsule', () => {
  expect(capsule([{ ...source, text: 'Hello.', source_files: [] }])).toBe('');
});
test('bounded file metadata declares omission rather than silently dropping the input', () => {
  const files = Array.from({ length: 32 }, (_, i) => ({
    ...file,
    file_id: `file-${i}`,
    filename: 'x'.repeat(512),
  }));
  const result = capsule([{ ...source, source_files: files }]);
  const row = decoded(result).sources[0];
  expect(row.attachmentCount).toBe(32);
  expect(row.attachmentsTruncated).toBe(true);
  expect(row.attachments.length).toBeGreaterThan(0);
  expect(row.attachments.length).toBeLessThan(32);
});
