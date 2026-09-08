import { createHash } from 'crypto';
import {
  buildGlassHiveNativeMediaContent,
  normalizeGlassHiveNativeMedia,
  renderGlassHiveNativeMediaLinks,
} from './nativeMedia';
import type { GlassHiveNativeMedia } from './nativeMedia';

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const artifactBaseUrl = 'https://artifacts.example.test';
const download = `${artifactBaseUrl}/v1/link-refs/ghr_1234567890abcdef`;
const media: GlassHiveNativeMedia = {
  observations: [
    {
      kind: 'image',
      source: 'native_tool_result',
      run_id: 'run-original',
      artifact_ref: `artifact_sha256:${sha256}`,
      tool_call_id: 'call-image',
      tool_name: 'native-tool',
      content_index: 1,
      mime_type: 'image/png',
      bytes: bytes.length,
      sha256,
      download_url: download,
      open_url: `${artifactBaseUrl}/v1/link-refs/ghr_fedcba0987654321`,
    },
  ],
  omitted_count: 2,
};
const insight = {
  authority: { kind: 'durable_terminal_callback', runId: 'run-original' },
  nativeMedia: media,
};
const response = () =>
  new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.length),
    },
  });

test('preserves exact verified pixels and link metadata as input, with no output attachment selection', async () => {
  const fetchImage = jest.fn().mockImplementation(response);
  const result = await buildGlassHiveNativeMediaContent(
    'Existing user request and result evidence.',
    [insight],
    { artifactBaseUrl, fetchImage },
  );
  expect(result).toEqual([
    { type: 'text', text: 'Existing user request and result evidence.' },
    { type: 'text', text: expect.any(String) },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` },
    },
  ]);
  expect(JSON.parse((result as Array<{ text: string }>)[1].text)).toEqual({
    native_media: { ...media, visible_to_user: false },
  });
  expect(fetchImage).toHaveBeenCalledWith(download, expect.objectContaining({ redirect: 'error' }));
  expect(result).not.toHaveProperty('attachments');
});

test('resolves only the model-selected admitted image through its verified current artifact', async () => {
  await buildGlassHiveNativeMediaContent('Request', [insight], {
    artifactBaseUrl, fetchImage: jest.fn().mockImplementation(response),
  });
  const output = `![Sentence close-up](${media.observations[0].artifact_ref})\n\nSources: https://docs.example.test/`;
  expect(renderGlassHiveNativeMediaLinks(output, [insight], { artifactBaseUrl })).toBe(
    `![Sentence close-up](${download})\n\nSources: https://docs.example.test/`,
  );
  expect(renderGlassHiveNativeMediaLinks('The note is unchanged.', [insight], { artifactBaseUrl }))
    .toBe('The note is unchanged.');
});

test('rejects unknown or stale selected image references and foreign authority', () => {
  const output = `![Note](${media.observations[0].artifact_ref})`;
  expect(() => renderGlassHiveNativeMediaLinks(output, [], { artifactBaseUrl }))
    .toThrow('native_media_selection_unavailable');
  expect(() => renderGlassHiveNativeMediaLinks('![Unknown](artifact_sha256:invalid)', [insight], { artifactBaseUrl }))
    .toThrow('native_media_selection_unavailable');
  expect(() => renderGlassHiveNativeMediaLinks(output, [{ ...insight,
    authority: { kind: 'durable_terminal_callback', runId: 'another-run' },
  }], { artifactBaseUrl })).toThrow('native_media_identity_invalid');
  expect(() => renderGlassHiveNativeMediaLinks(output, [{ ...insight,
    authority: { kind: 'untrusted', runId: 'run-original' },
  }], { artifactBaseUrl })).toThrow('native_media_authority_invalid');
});

test('keeps public links unchanged and does not authorize a foreign artifact URL', () => {
  const output = `![Note](${media.observations[0].artifact_ref})`;
  const foreign = { ...insight, nativeMedia: { ...media, observations: [
    { ...media.observations[0], download_url: 'https://foreign.example.test/image.png' },
  ] } };
  expect(() => renderGlassHiveNativeMediaLinks(output, [foreign], { artifactBaseUrl }))
    .toThrow('native_media_link_invalid');
  expect(renderGlassHiveNativeMediaLinks('![Public](https://images.example.test/a.png)', []))
    .toBe('![Public](https://images.example.test/a.png)');
});

test('keeps existing text-only synthesis byte-identical and does not fetch', async () => {
  const fetchImage = jest.fn();
  expect(
    await buildGlassHiveNativeMediaContent('original prompt', [{}], {
      fetchImage,
    }),
  ).toBe('original prompt');
  expect(fetchImage).not.toHaveBeenCalled();
});

test('rejects a different run, wrong artifact digest, duplicate source identity, and unsupported media', () => {
  expect(() => normalizeGlassHiveNativeMedia(media, 'run-new')).toThrow(
    'native_media_identity_invalid',
  );
  expect(() =>
    normalizeGlassHiveNativeMedia(
      {
        ...media,
        observations: [
          {
            ...media.observations[0],
            artifact_ref: `artifact_sha256:${'a'.repeat(64)}`,
          },
        ],
      },
      'run-original',
    ),
  ).toThrow('native_media_identity_invalid');
  expect(() =>
    normalizeGlassHiveNativeMedia(
      {
        ...media,
        observations: [...media.observations, ...media.observations],
      },
      'run-original',
    ),
  ).toThrow('native_media_identity_invalid');
  expect(() =>
    normalizeGlassHiveNativeMedia(
      {
        ...media,
        observations: [{ ...media.observations[0], mime_type: 'image/svg+xml' }],
      },
      'run-original',
    ),
  ).toThrow('native_media_invalid');
});

test.each([
  'http://127.0.0.1/internal',
  'https://other.example.test/v1/link-refs/ghr_1234567890abcdef',
  `${artifactBaseUrl}/internal`,
  `${download}?redirect=https://other.example.test`,
  'https://secret@artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
])('rejects unbound or non-artifact URL without fetching: %s', async (download_url) => {
  const fetchImage = jest.fn();
  await expect(
    buildGlassHiveNativeMediaContent(
      'prompt',
      [
        {
          ...insight,
          nativeMedia: {
            ...media,
            observations: [{ ...media.observations[0], download_url }],
          },
        },
      ],
      { artifactBaseUrl, fetchImage },
    ),
  ).rejects.toThrow('native_media_link_invalid');
  expect(fetchImage).not.toHaveBeenCalled();
});

test('does not accept ordinary background data as authenticated worker image evidence', async () => {
  const fetchImage = jest.fn();
  await expect(
    buildGlassHiveNativeMediaContent(
      'prompt',
      [{ ...insight, authority: { kind: 'background' } }],
      { artifactBaseUrl, fetchImage },
    ),
  ).rejects.toThrow('native_media_authority_invalid');
  expect(fetchImage).not.toHaveBeenCalled();
});

test.each([
  () => new Response(bytes, { headers: { 'content-type': 'text/html' } }),
  () =>
    new Response(Buffer.alloc(bytes.length), {
      headers: { 'content-type': 'image/png' },
    }),
  () =>
    new Response(bytes.subarray(1), {
      headers: { 'content-type': 'image/png' },
    }),
  () =>
    new Response(Buffer.concat([bytes, Buffer.from('extra')]), {
      headers: { 'content-type': 'image/png' },
    }),
])(
  'rejects MIME, digest or stream-length mismatch before model invocation',
  async (makeResponse) => {
    await expect(
      buildGlassHiveNativeMediaContent('prompt', [insight], {
        artifactBaseUrl,
        fetchImage: jest.fn().mockImplementation(makeResponse),
      }),
    ).rejects.toThrow('native_media_content_mismatch');
  },
);

test('keeps unavailable image evidence retryable through the existing synthesis failure path', async () => {
  await expect(
    buildGlassHiveNativeMediaContent('prompt', [insight], {
      artifactBaseUrl,
      fetchImage: jest.fn().mockResolvedValue(new Response('', { status: 503 })),
    }),
  ).rejects.toThrow('native_media_unavailable');
  await expect(
    buildGlassHiveNativeMediaContent('prompt', [insight], {
      artifactBaseUrl,
      fetchImage: jest.fn().mockRejectedValue(new Error('private transport detail')),
    }),
  ).rejects.toThrow('native_media_unavailable');
});

test('enforces declared image and aggregate byte bounds without truncating observations', () => {
  expect(() =>
    normalizeGlassHiveNativeMedia(
      {
        ...media,
        observations: Array.from({ length: 25 }, (_, content_index) => ({
          ...media.observations[0],
          content_index,
        })),
      },
      'run-original',
    ),
  ).toThrow('native_media_invalid');
  expect(() =>
    normalizeGlassHiveNativeMedia(
      {
        ...media,
        observations: Array.from({ length: 5 }, (_, content_index) => ({
          ...media.observations[0],
          content_index,
          bytes: 8 * 1024 * 1024,
        })),
      },
      'run-original',
    ),
  ).toThrow('native_media_identity_invalid');
});

const acceptedRunInput = {
  version: 1 as const,
  run_id: 'run-original',
  instruction: 'Compare the result with the supplied material and return the requested evidence.',
  continuation_context: {
    version: 1 as const,
    base_instruction: 'Prepare the document without submitting it.',
    guidance: ['Use the revised figures.', 'Keep the document unchanged during the comparison.'],
  },
};

test('carries accepted continuation context independently of result clipping and media', async () => {
  const runInput = { ...acceptedRunInput, instruction: 'Complete accepted request. '.repeat(1000) };
  const fetchImage = jest.fn();
  const result = await buildGlassHiveNativeMediaContent('Clipped result text.', [
    { authority: insight.authority, runInput },
  ], { fetchImage });
  expect(result).toEqual([
    { type: 'text', text: 'Clipped result text.' },
    { type: 'text', text: JSON.stringify({ accepted_run_input: runInput }) },
  ]);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('keeps each accepted input bound to its own result run', async () => {
  const other = { ...acceptedRunInput, run_id: 'run-independent', instruction: 'Explain the chart.' };
  const result = await buildGlassHiveNativeMediaContent('Two results.', [
    { authority: insight.authority, runInput: acceptedRunInput },
    { authority: { ...insight.authority, runId: other.run_id }, runInput: other },
  ]);
  expect(result).toEqual([
    { type: 'text', text: 'Two results.' },
    { type: 'text', text: JSON.stringify({ accepted_run_input: acceptedRunInput }) },
    { type: 'text', text: JSON.stringify({ accepted_run_input: other }) },
  ]);
});

test('rejects untrusted or different-run accepted input before model admission', async () => {
  await expect(buildGlassHiveNativeMediaContent('result', [{ runInput: acceptedRunInput }]))
    .rejects.toThrow('mission_input_authority_invalid');
  await expect(buildGlassHiveNativeMediaContent('result', [{
    authority: { ...insight.authority, runId: 'run-different' }, runInput: acceptedRunInput,
  }])).rejects.toThrow('mission_input_identity_invalid');
});
