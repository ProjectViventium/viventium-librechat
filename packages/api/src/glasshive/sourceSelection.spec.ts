import {
  selectTrustedLaunchRequestBody,
  selectTrustedSourceInstruction,
  trustedUploadedFilesFromRequestBody,
} from './sourceSelection';
import { createHash } from 'crypto';
import { normalizeInteractionSourceSegments } from './interactionSourceSegments';

test('source admission preserves all originals and file references with immutable order', () => {
  const text = '😀'.repeat(20000) + '\nKeep the final condition.';
  const files = Array.from({ length: 65 }, (_, n) => ({ file_id: `file-${n}` }));
  const originals = Array.from({ length: 40 }, (_, n) => ({
    source_event_id: `source-${n}`, text, source_files: files,
  }));
  const result = normalizeInteractionSourceSegments(originals);
  expect(result.overflowCount).toBe(0);
  expect(result.segments).toHaveLength(40);
  expect(result.segments[39]).toMatchObject({ ordinal: 39, text, source_files: files });
  expect(result.segments.some((s) => s.truncated)).toBe(false);
  expect(Object.isFrozen(result.segments[39])).toBe(true);
});

test('rehydrates a selected bounded preview by its original digest, never by a guessed summary', () => {
  const text = 'x'.repeat(40000) + '\nKeep this final condition.';
  const source = { source_event_id: 'one', text: text.slice(0, 32768), truncated: true,
    original_sha256: createHash('sha256').update(text).digest('hex') };
  const body = { viventiumSourceEventId: 'one', viventiumTriggeringSourceSegments: [source],
    viventiumInheritedConversation: { version: 1, sources: [
      { current_input: true, source_ordinals: [1], text },
    ] } };
  const result = selectTrustedLaunchRequestBody(body, [1]);
  if ('error' in result) throw new Error(result.error);
  expect((result.requestBody.viventiumTriggeringSourceSegments as typeof source[])[0].text === text).toBe(true);
  expect((result.requestBody.viventiumTriggeringSourceSegments as typeof source[])[0].truncated).toBeUndefined();
  expect(source.truncated).toBe(true);
  expect(selectTrustedLaunchRequestBody({ ...body, viventiumInheritedConversation: {
    version: 1, sources: [{ current_input: true, source_ordinals: [2], text }],
  } }, [1])).toEqual({ error: 'current_task_source_unavailable' });
});

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

  test('preserves complete file text and every authorized file descriptor', () => {
    const text = 'a'.repeat(256 * 1024) + '\nDo not publish this work.';
    const [file] = trustedUploadedFilesFromRequestBody({
      files: [{ file_id: 'synthetic', text }],
    });
    expect(file.text === text).toBe(true);
    const files = Array.from({ length: 65 }, (_, index) => ({ file_id: `synthetic-${index}` }));
    expect(trustedUploadedFilesFromRequestBody({ files }).map((item) => item.file_id))
      .toEqual(files.map((item) => item.file_id));
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
    expect(selectTrustedSourceInstruction(sources, 'Keep the original browser task too. 😀'))
      .toBe('Keep the original browser task too. 😀');
    expect(sources).toEqual([original]);
    expect(selectTrustedSourceInstruction(sources)).toBeUndefined();
  });
  test.each(['Invented recap.', 'Foreign historical task.', '', '  ', 17, null,
    ' Keep the original browser task too.', 'Keep the ORIGINAL browser task too.',
  ])('rejects malformed or nonverbatim selection %p', (instruction) => {
    expect(() => selectTrustedSourceInstruction([original], instruction)).toThrow(
      expect.objectContaining({ code: 'invalid_source_instruction_selection' }),
    );
  });
  test('rejects fabricated joins and preserves a complete large original clause', () => {
    expect(() => selectTrustedSourceInstruction(['First.', 'Second.'], 'First.\n\nSecond.'))
      .toThrow('invalid_source_instruction_selection');
    const large = 'x'.repeat(100001);
    expect(selectTrustedSourceInstruction([large], large)).toBe(large);
  });
  test('keeps remote shared conditions in original context without accepting a fabricated quote', () => {
    const first = 'Add a raincoat to the packing file.';
    const second = 'Separately, open the public reference page.';
    const condition = 'For both tasks, use only synthetic data and do not publish anything.';
    const source = `${first} ${second} ${condition}`;
    expect(selectTrustedSourceInstruction([source], first)).toBe(first);
    expect(selectTrustedSourceInstruction([source], second)).toBe(second);
    expect(() => selectTrustedSourceInstruction([source], `${first} ${condition}`))
      .toThrow('invalid_source_instruction_selection');
    const selected = selectTrustedLaunchRequestBody({
      viventiumTriggeringSourceSegments: [{ source_event_id: 'synthetic-source', text: source }],
    }, [1]);
    expect(selected).toEqual({ sourceOrdinals: [1], requestBody: {
      viventiumTriggeringSourceSegments: [{ source_event_id: 'synthetic-source', text: source }],
    } });
  });
});
