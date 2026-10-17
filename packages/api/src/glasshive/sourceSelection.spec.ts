import {
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
} from './sourceSelection';

describe('trusted upload text representation', () => {
  test.each(['', 'Exact supplied text.\n'])('preserves explicit text %p', (text) => {
    expect(
      trustedUploadedFilesFromRequestBody({ files: [{ file_id: 'synthetic', text }] }),
    ).toEqual([{ file_id: 'synthetic', media_group_index: 0, text }]);
  });

  test('keeps absent text absent and rejects untrusted file paths', () => {
    expect(
      trustedUploadedFilesFromRequestBody({
        files: [
          {
            file_id: 'synthetic',
            filepath: '/untrusted/path',
            source_path: '/untrusted/path',
          },
        ],
      }),
    ).toEqual([{ file_id: 'synthetic', media_group_index: 0 }]);
  });

  test('retains the existing text size limit', () => {
    const [file] = trustedUploadedFilesFromRequestBody({
      files: [{ file_id: 'synthetic', text: 'a'.repeat(256 * 1024 + 1) }],
    });
    expect(file.text).toHaveLength(256 * 1024);
  });

  test('selected mission sources retain empty text without adding sibling files or paths', () => {
    const result = selectTrustedLaunchRequestBody(
      {
        viventiumTriggeringSourceSegments: [
          { source_event_id: 'first' },
          { source_event_id: 'second' },
        ],
        files: [
          {
            file_id: 'first-file',
            source_event_id: 'first',
            text: '',
            filepath: '/untrusted/path',
          },
          { file_id: 'second-file', source_event_id: 'second', text: 'Sibling text.' },
        ],
      },
      [1],
    );
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.requestBody.files).toEqual([
      {
        file_id: 'first-file',
        text: '',
        media_group_index: 0,
        source_event_id: 'first',
        source_index: 0,
      },
    ]);
  });
});
