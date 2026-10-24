import {
  selectTrustedLaunchRequestBody,
  selectTrustedSourceInstruction,
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

describe('exact inherited instruction selection', () => {
  const original = 'Update the packing file. Keep the original browser task too. 😀';
  test('preserves a verbatim clause and leaves the complete original source intact', () => {
    const sources = Object.freeze([original]);
    expect(selectTrustedSourceInstruction(sources, 'Keep the original browser task too. 😀')).toBe(
      'Keep the original browser task too. 😀',
    );
    expect(sources).toEqual([original]);
    expect(selectTrustedSourceInstruction(sources)).toBeUndefined();
  });
  test.each([
    'Invented recap.',
    'Foreign historical task.',
    '',
    '  ',
    17,
    null,
    ' Keep the original browser task too.',
    'Keep the ORIGINAL browser task too.',
  ])('rejects malformed or nonverbatim selection %p', (instruction) => {
    expect(() => selectTrustedSourceInstruction([original], instruction)).toThrow(
      expect.objectContaining({ code: 'invalid_source_instruction_selection' }),
    );
  });
  test('does not match a fabricated join across separate original sources or clip oversized text', () => {
    expect(() =>
      selectTrustedSourceInstruction(['First.', 'Second.'], 'First.\n\nSecond.'),
    ).toThrow('invalid_source_instruction_selection');
    const large = 'x'.repeat(100001);
    expect(() => selectTrustedSourceInstruction([large], large)).toThrow(
      'invalid_source_instruction_selection',
    );
  });
  test('keeps remote shared conditions in original context without accepting a fabricated quote', () => {
    const first = 'Add a raincoat to the packing file.';
    const second = 'Separately, open the public reference page.';
    const condition = 'For both tasks, use only synthetic data and do not publish anything.';
    const source = `${first} ${second} ${condition}`;
    expect(selectTrustedSourceInstruction([source], first)).toBe(first);
    expect(selectTrustedSourceInstruction([source], second)).toBe(second);
    expect(() => selectTrustedSourceInstruction([source], `${first} ${condition}`)).toThrow(
      'invalid_source_instruction_selection',
    );
    const selected = selectTrustedLaunchRequestBody(
      {
        viventiumTriggeringSourceSegments: [{ source_event_id: 'synthetic-source', text: source }],
      },
      [1],
    );
    expect(selected).toEqual({
      sourceOrdinals: [1],
      requestBody: {
        viventiumTriggeringSourceSegments: [{ source_event_id: 'synthetic-source', text: source }],
      },
    });
  });
});
