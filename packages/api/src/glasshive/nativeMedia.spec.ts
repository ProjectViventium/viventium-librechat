import { createHash } from 'crypto';
import {
  buildGlassHiveNativeMediaContent,
  normalizeGlassHiveNativeMedia,
  renderGlassHiveNativeMediaLinks,
  selectGlassHiveNativeMediaFiles,
  nativeMediaOutputFilesForMessage,
  collectGlassHiveNativeMediaReferences,
  resolveGlassHiveNativeMediaMessageSelection,
  bindGlassHiveNativeMediaAttachmentReferences,
  renderGlassHiveNativeMediaAttachmentLinks,
} from './nativeMedia';
import type { ClientSession } from 'mongoose';
import type { NativeOutputDeliveryAttachment } from './nativeOutputFiles';
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
    artifactBaseUrl,
    fetchImage: jest.fn().mockImplementation(response),
  });
  const output = `![Sentence close-up](${media.observations[0].artifact_ref})\n\nSources: https://docs.example.test/`;
  expect(renderGlassHiveNativeMediaLinks(output, [insight], { artifactBaseUrl })).toBe(
    `![Sentence close-up](${download})\n\nSources: https://docs.example.test/`,
  );
  expect(
    renderGlassHiveNativeMediaLinks('The note is unchanged.', [insight], { artifactBaseUrl }),
  ).toBe('The note is unchanged.');
});

test('rejects unknown or stale selected image references and foreign authority', () => {
  const output = `![Note](${media.observations[0].artifact_ref})`;
  expect(() => renderGlassHiveNativeMediaLinks(output, [], { artifactBaseUrl })).toThrow(
    'native_media_selection_unavailable',
  );
  expect(() =>
    renderGlassHiveNativeMediaLinks('![Unknown](artifact_sha256:invalid)', [insight], {
      artifactBaseUrl,
    }),
  ).toThrow('native_media_selection_unavailable');
  expect(() =>
    renderGlassHiveNativeMediaLinks(
      output,
      [{ ...insight, authority: { kind: 'durable_terminal_callback', runId: 'another-run' } }],
      { artifactBaseUrl },
    ),
  ).toThrow('native_media_identity_invalid');
  expect(() =>
    renderGlassHiveNativeMediaLinks(
      output,
      [{ ...insight, authority: { kind: 'untrusted', runId: 'run-original' } }],
      { artifactBaseUrl },
    ),
  ).toThrow('native_media_authority_invalid');
});

test('keeps public links unchanged and does not authorize a foreign artifact URL', () => {
  const output = `![Note](${media.observations[0].artifact_ref})`;
  const foreign = {
    ...insight,
    nativeMedia: {
      ...media,
      observations: [
        { ...media.observations[0], download_url: 'https://foreign.example.test/image.png' },
      ],
    },
  };
  expect(() => renderGlassHiveNativeMediaLinks(output, [foreign], { artifactBaseUrl })).toThrow(
    'native_media_link_invalid',
  );
  expect(renderGlassHiveNativeMediaLinks('![Public](https://images.example.test/a.png)', [])).toBe(
    '![Public](https://images.example.test/a.png)',
  );
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

test('fetches accepted screenshot grants through the existing owner-authenticated transport', async () => {
  const priorEnv = { ...process.env };
  process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
  process.env.WPR_API_TOKEN = 'synthetic-token';
  process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-secret';
  process.env.VIVENTIUM_TENANT_ID = 'synthetic-tenant';
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  try {
    const content = await buildGlassHiveNativeMediaContent('Observed result.', [insight], {
      artifactBaseUrl,
      ownerId: 'synthetic-owner',
    });
    expect(network).toHaveBeenCalledWith(
      'http://127.0.0.1:8766/v1/link-refs/ghr_1234567890abcdef',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    const headers = network.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer synthetic-token');
    const assertion = headers.get('X-Viventium-Service-Assertion') || '';
    expect(JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url').toString()).owner_id).toBe(
      'synthetic-owner',
    );
    expect(content).toEqual(
      expect.arrayContaining([
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` },
        },
      ]),
    );
  } finally {
    network.mockRestore();
    process.env = priorEnv;
  }
});

test('loads a bounded screenshot group concurrently and retains native observation order', async () => {
  const second = {
    ...media.observations[0],
    content_index: 2,
    download_url: `${artifactBaseUrl}/v1/link-refs/ghr_second1234567890`,
  };
  let firstResolve: ((value: Response) => void) | undefined;
  const fetchImage = jest.fn((url: string) =>
    url === download
      ? new Promise<Response>((resolve) => {
          firstResolve = resolve;
        })
      : Promise.resolve(response()),
  );
  const pending = buildGlassHiveNativeMediaContent(
    'Observed result.',
    [{ ...insight, nativeMedia: { ...media, observations: [media.observations[0], second] } }],
    { artifactBaseUrl, fetchImage },
  );
  expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([download, second.download_url]);
  firstResolve?.(response());
  const result = await pending;
  expect(JSON.parse((result as Array<{ text: string }>)[1].text).native_media.observations).toEqual(
    [media.observations[0], second],
  );
  expect(result).toHaveLength(4);
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
  const result = await buildGlassHiveNativeMediaContent(
    'Clipped result text.',
    [{ authority: insight.authority, runInput }],
    { fetchImage },
  );
  expect(result).toEqual([
    { type: 'text', text: 'Clipped result text.' },
    { type: 'text', text: JSON.stringify({ accepted_run_input: runInput }) },
  ]);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('keeps each accepted input bound to its own result run', async () => {
  const other = {
    ...acceptedRunInput,
    run_id: 'run-independent',
    instruction: 'Explain the chart.',
  };
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
  await expect(
    buildGlassHiveNativeMediaContent('result', [{ runInput: acceptedRunInput }]),
  ).rejects.toThrow('mission_input_authority_invalid');
  await expect(
    buildGlassHiveNativeMediaContent('result', [
      {
        authority: { ...insight.authority, runId: 'run-different' },
        runInput: acceptedRunInput,
      },
    ]),
  ).rejects.toThrow('mission_input_identity_invalid');
});

describe('accepted nonterminal work input before Phase B model admission', () => {
  const authority = { kind: 'durable_work_callback', runId: 'run-original' };
  test('preserves the full accepted needs-input goal and continuation without granting media', async () => {
    const runInput = {
      ...acceptedRunInput,
      instruction: 'Update the fictional offline checklist with progress count and reset. '.repeat(
        100,
      ),
    };
    const fetchImage = jest.fn();
    await expect(
      buildGlassHiveNativeMediaContent(
        'Authorization is needed before work starts.',
        [{ authority, runInput }],
        { fetchImage },
      ),
    ).resolves.toEqual([
      { type: 'text', text: 'Authorization is needed before work starts.' },
      { type: 'text', text: JSON.stringify({ accepted_run_input: runInput }) },
    ]);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  test.each([
    'missing_authority',
    'unknown_kind',
    'generic_cortex',
    'missing_run',
    'foreign_run',
    'stale_run',
  ])('%s cannot carry accepted work input', async (caseName) => {
    const bound = caseName === 'missing_authority' ? undefined : { ...authority };
    if (bound && caseName === 'unknown_kind') bound.kind = 'unknown';
    if (bound && caseName === 'generic_cortex') bound.kind = 'cortex_insight';
    if (bound && caseName === 'missing_run') bound.runId = '';
    if (bound && caseName === 'foreign_run') bound.runId = 'run-foreign';
    const runInput =
      caseName === 'stale_run' ? { ...acceptedRunInput, run_id: 'run-stale' } : acceptedRunInput;
    const fetchImage = jest.fn();
    await expect(
      buildGlassHiveNativeMediaContent(
        'Goal cannot supply its own authority.',
        [{ authority: bound, runInput }],
        { fetchImage },
      ),
    ).rejects.toMatchObject({
      code: ['missing_authority', 'unknown_kind', 'generic_cortex'].includes(caseName)
        ? 'mission_input_authority_invalid'
        : 'mission_input_identity_invalid',
    });
    expect(fetchImage).not.toHaveBeenCalled();
  });
  test('nonterminal accepted input cannot authorize native output media', async () => {
    const fetchImage = jest.fn();
    await expect(
      buildGlassHiveNativeMediaContent(
        'Accepted input is contextual evidence.',
        [{ authority, runInput: acceptedRunInput, nativeMedia: media }],
        { fetchImage },
      ),
    ).rejects.toMatchObject({ code: 'native_media_authority_invalid' });
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

test('captures only explicit selected native refs with their exact run and tool provenance', () => {
  const onSelection = jest.fn();
  const output = `[Evidence](${media.observations[0].artifact_ref})\n![Preview](${media.observations[0].artifact_ref})`;
  renderGlassHiveNativeMediaLinks(output, [insight], { artifactBaseUrl, onSelection });
  expect(onSelection).toHaveBeenCalledTimes(2);
  expect(onSelection).toHaveBeenCalledWith({
    run_id: 'run-original',
    tool_call_id: 'call-image',
    content_index: 1,
    artifact_ref: `artifact_sha256:${sha256}`,
    label: 'Preview',
  });
  onSelection.mockClear();
  renderGlassHiveNativeMediaLinks(
    `Unselected: ${media.observations[0].artifact_ref}. [Public](https://example.test)`,
    [insight],
    { artifactBaseUrl, onSelection },
  );
  expect(onSelection).not.toHaveBeenCalled();
});

test('selected references rebind only to exact current owner/run/tool/index callback evidence', () => {
  const item = media.observations[0];
  const selection = {
    run_id: item.run_id,
    tool_call_id: item.tool_call_id,
    content_index: item.content_index,
    artifact_ref: item.artifact_ref,
  };
  const row = {
    ownerId: 'owner',
    runId: item.run_id,
    terminalCallbackId: 'callback',
    nativeMedia: media,
  };
  const files = selectGlassHiveNativeMediaFiles([selection, selection], [row], 'owner');
  expect(files.get('callback')).toEqual([
    {
      filename: 'Evidence.png',
      mime_type: item.mime_type,
      bytes: item.bytes,
      sha256: item.sha256,
      download_url: download,
    },
  ]);
  expect(selectGlassHiveNativeMediaFiles([], [row], 'owner').size).toBe(0);
  expect(() =>
    selectGlassHiveNativeMediaFiles([selection], [{ ...row, ownerId: 'other' }], 'owner'),
  ).toThrow('native_media_authority_invalid');
  expect(() =>
    selectGlassHiveNativeMediaFiles([selection], [{ ...row, runId: 'stale' }], 'owner'),
  ).toThrow('native_media_identity_invalid');
  for (const stale of [
    { ...selection, tool_call_id: 'other' },
    { ...selection, content_index: 2 },
    { ...selection, artifact_ref: `artifact_sha256:${'f'.repeat(64)}` },
    { ...selection, run_id: 'other' },
  ]) {
    expect(() => selectGlassHiveNativeMediaFiles([stale], [row], 'owner')).toThrow(
      'native_media_selection_unavailable',
    );
  }
  expect(() =>
    selectGlassHiveNativeMediaFiles([{ ...selection, artifact_ref: 'invalid' }], [row], 'owner'),
  ).toThrow('native_media_selection_unavailable');
});

test.each(['attempt-native', undefined])(
  'selected media retains original accepted callback proof with saved attempt %s',
  (attemptId) => {
    const source = {
      ownerId: 'owner',
      runId: 'run-original',
      attemptId,
      attemptNumber: 1,
      terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'b'.repeat(32),
      terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
      terminalCallbackResultRevision: 2,
      terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
      terminalCallbackEffectGeneration: 1,
    };
    const identity = {
      userId: source.ownerId,
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'answer',
      agentId: 'main',
      logicalTurnId: '',
      revision: 1,
      requestId: source.terminalCallbackId,
      runId: source.runId,
      attemptId: attemptId || '',
    };
    const files =
      selectGlassHiveNativeMediaFiles(
        [{ ...media.observations[0], label: 'Readable evidence' }].map(
          ({ run_id, tool_call_id, content_index, artifact_ref, label }) => ({
            run_id,
            tool_call_id,
            content_index,
            artifact_ref,
            label,
          }),
        ),
        [{ ...source, nativeMedia: media }],
        source.ownerId,
      ).get(source.terminalCallbackId) || [];
    expect(nativeMediaOutputFilesForMessage(source, files, identity)).toMatchObject({
      owner_id: 'owner',
      message_id: 'answer',
      request_id: source.terminalCallbackId,
      run_id: source.runId,
      attempt_id: attemptId || '',
      files: [{ filename: 'Readable_evidence.png' }],
    });
    for (const broken of [
      { ...source, attemptNumber: 0 },
      { ...source, terminalCallbackAcceptedOperationId: '' },
      { ...source, terminalCallbackResultRevision: 0 },
      { ...source, terminalCallbackResultDigest: '' },
      { ...source, terminalCallbackEffectGeneration: 0 },
      { ...source, ownerId: 'other' },
      { ...source, runId: 'other' },
      { ...source, terminalCallbackId: `cb_terminal_${'e'.repeat(64)}` },
    ]) {
      expect(() => nativeMediaOutputFilesForMessage(broken, files, identity)).toThrow(
        'native_media_authority_invalid',
      );
    }
  },
);

test.each(['artifact_ref', 'download_url', 'open_url'] as const)(
  'Main exact selected %s reaches the same captured observation and canonical File grant',
  (field) => {
    const onSelection = jest.fn();
    const selected = `![Readable evidence](${media.observations[0][field]})`;
    expect(
      renderGlassHiveNativeMediaLinks(selected, [insight], { artifactBaseUrl, onSelection }),
    ).toBe(`![Readable evidence](${download})`);
    expect(onSelection).toHaveBeenCalledWith({
      run_id: 'run-original',
      tool_call_id: 'call-image',
      content_index: 1,
      artifact_ref: `artifact_sha256:${sha256}`,
      label: 'Readable evidence',
    });
  },
);

test('canonicalizes only current accepted grant spellings and retains exact receipt binding', () => {
  const item = {
    ...media.observations[0],
    download_url: download.replace('artifacts.example.test', 'ARTIFACTS.EXAMPLE.TEST:443'),
    open_url: media.observations[0].open_url.replace(
      'artifacts.example.test',
      'ARTIFACTS.EXAMPLE.TEST:443',
    ),
  };
  const current = { ...insight, nativeMedia: { ...media, observations: [item] } };
  for (const url of [item.download_url, download, item.open_url, media.observations[0].open_url]) {
    const onSelection = jest.fn();
    expect(
      renderGlassHiveNativeMediaLinks(`[Evidence](${url})`, [current], {
        artifactBaseUrl,
        onSelection,
      }),
    ).toBe(`[Evidence](${download})`);
    expect(onSelection).toHaveBeenCalledTimes(1);
  }
  const selection = {
    run_id: item.run_id,
    tool_call_id: item.tool_call_id,
    content_index: item.content_index,
    artifact_ref: item.artifact_ref,
  };
  expect(
    selectGlassHiveNativeMediaFiles(
      [selection],
      [
        {
          ownerId: 'owner',
          runId: item.run_id,
          terminalCallbackId: 'callback',
          nativeMedia: current.nativeMedia,
        },
      ],
      'owner',
    ).get('callback')?.[0].download_url,
  ).toBe(download);
});

test.each([
  'https://artifacts.example.test/v1/link-refs/ghr_stale1234567890',
  'https://other.example.test/v1/link-refs/ghr_1234567890abcdef',
  download + '?other=1',
  'https://docs.example.test/source',
])('unselected, stale or foreign exact URL grants no selection: %s', (url) => {
  const onSelection = jest.fn();
  const authored = `![Evidence](${url})`;
  expect(
    renderGlassHiveNativeMediaLinks(authored, [insight], { artifactBaseUrl, onSelection }),
  ).toBe(authored);
  expect(onSelection).not.toHaveBeenCalled();
});

test.each([
  '`![Literal](REFERENCE)`',
  '``[Literal](REFERENCE)``',
  '```markdown\n![Literal](REFERENCE)\n```',
  '~~~markdown\n[Literal](REFERENCE)\n~~~',
  '````markdown\n```\n![Literal](REFERENCE)\n````',
  '```markdown\n![Literal](REFERENCE)',
  '`Multiline\n![Literal](REFERENCE)\nexample`',
  String.raw`!\[Literal](REFERENCE)`,
  String.raw`\[Literal](REFERENCE)`,
])('code or escaped literal markup does not select an observation: %s', (template) => {
  for (const reference of [
    media.observations[0].artifact_ref,
    download,
    media.observations[0].open_url,
  ]) {
    const literal = template.replace('REFERENCE', reference);
    const onSelection = jest.fn();
    expect(
      renderGlassHiveNativeMediaLinks(literal, [insight], { artifactBaseUrl, onSelection }),
    ).toBe(literal);
    expect(onSelection).not.toHaveBeenCalled();
  }
});

test('visible links after a protected code block retain model selection', () => {
  const onSelection = jest.fn();
  const literal = `\`![Literal](${download})\``;
  const visible = `[Selected](${media.observations[0].artifact_ref})`;
  expect(
    renderGlassHiveNativeMediaLinks(`${literal}\n${visible}`, [insight], {
      artifactBaseUrl,
      onSelection,
    }),
  ).toBe(`${literal}\n[Selected](${download})`);
  expect(onSelection).toHaveBeenCalledTimes(1);
});

test('an escaped bang preserves a real authored link while escaped brackets remain literal', () => {
  const onSelection = jest.fn();
  const authored = String.raw`\![Selected](${media.observations[0].artifact_ref})`;
  expect(
    renderGlassHiveNativeMediaLinks(authored, [insight], { artifactBaseUrl, onSelection }),
  ).toBe(String.raw`\![Selected](${download})`);
  expect(onSelection).toHaveBeenCalledTimes(1);
});

const retainedMediaSource = {
  ownerId: 'owner',
  conversationId: 'conversation',
  originRef: 'origin',
  workRef: 'work',
  runId: 'run-original',
  attemptNumber: 1,
  nativeMedia: media,
  terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
  terminalCallbackAcceptedOperationId: 'b'.repeat(32),
  terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
  terminalCallbackResultRevision: 2,
  terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
  terminalCallbackEffectGeneration: 1,
};
function retainedStore(rows = [retainedMediaSource]) {
  return {
    readEvidence: jest.fn().mockResolvedValue(rows),
    isAccepted: jest.fn().mockResolvedValue(true),
    fenceAccepted: jest.fn().mockResolvedValue(true),
  };
}
const retainedSession = { inTransaction: () => true } as ClientSession;
const availableMediaFile: NativeOutputDeliveryAttachment = {
  user: 'owner',
  file_id: `native_${'e'.repeat(64)}`,
  filename: 'Capture.png',
  filepath: '/uploads/owner/capture.png',
  bytes: bytes.length,
  type: 'image/png',
  source: 'local',
  object: 'file',
  nativeOutputFile: { version: 1, status: 'available', messageId: 'answer', downloadUrl: download },
};

describe('ordinary Main retained image selections', () => {
  let priorBase: string | undefined;
  beforeEach(() => {
    priorBase = process.env.GLASSHIVE_ARTIFACT_BASE_URL;
    process.env.GLASSHIVE_ARTIFACT_BASE_URL = artifactBaseUrl;
  });
  afterEach(() => {
    if (priorBase === undefined) delete process.env.GLASSHIVE_ARTIFACT_BASE_URL;
    else process.env.GLASSHIVE_ARTIFACT_BASE_URL = priorBase;
  });
  test.each(['artifact_ref', 'download_url', 'open_url'] as const)(
    'resolves selected historical %s only under current owner/conversation and original accepted winner',
    async (field) => {
      const text = `![Capture](${media.observations[0][field]})\n[Source](https://docs.example.test)`;
      const store = retainedStore();
      const selected = await resolveGlassHiveNativeMediaMessageSelection(
        { text, ownerId: 'owner', conversationId: 'conversation' },
        store,
      );
      expect(selected?.rows).toEqual([retainedMediaSource]);
      expect(selected?.selectedNativeMedia).toEqual([
        {
          run_id: 'run-original',
          tool_call_id: 'call-image',
          content_index: 1,
          artifact_ref: media.observations[0].artifact_ref,
          label: 'Capture',
        },
      ]);
      expect(store.readEvidence.mock.calls[0][0]).toMatchObject({
        ownerId: 'owner',
        conversationId: 'conversation',
      });
      expect(store.isAccepted).toHaveBeenCalledWith({
        _id: retainedMediaSource.terminalCallbackResultKey,
        ownerId: 'owner',
        originRef: 'origin',
        workRef: 'work',
        runId: 'run-original',
        attemptNumber: 1,
        callbackId: retainedMediaSource.terminalCallbackId,
        resultRevision: 2,
        resultDigest: retainedMediaSource.terminalCallbackResultDigest,
        acceptedOperationId: retainedMediaSource.terminalCallbackAcceptedOperationId,
        acceptedOperationGeneration: 1,
      });
      await selected?.authorizePublication(retainedSession);
      expect(store.fenceAccepted).toHaveBeenCalledWith(
        {
          resultKey: retainedMediaSource.terminalCallbackResultKey,
          callbackId: retainedMediaSource.terminalCallbackId,
          resultRevision: 2,
          resultDigest: retainedMediaSource.terminalCallbackResultDigest,
          acceptedOperationId: retainedMediaSource.terminalCallbackAcceptedOperationId,
          generation: 1,
        },
        retainedSession,
      );
      const bound = bindGlassHiveNativeMediaAttachmentReferences(
        text,
        selected?.rows || [],
        [availableMediaFile],
        'owner',
        'answer',
      );
      expect(bound[0].nativeOutputFile).toMatchObject({
        selectedReferences: [media.observations[0][field]],
      });
      expect(
        renderGlassHiveNativeMediaAttachmentLinks(text, bound, {
          ownerId: 'owner',
          messageId: 'answer',
        }),
      ).toBe(`![Capture](${download})\n[Source](https://docs.example.test)`);
    },
  );
  test('rejects original evidence superseded before import or during final publication', async () => {
    const text = `[Capture](${download})`;
    const store = retainedStore();
    store.isAccepted.mockResolvedValueOnce(false);
    await expect(
      resolveGlassHiveNativeMediaMessageSelection(
        { text, ownerId: 'owner', conversationId: 'conversation' },
        store,
      ),
    ).rejects.toThrow('native_media_evidence_superseded');
    store.fenceAccepted.mockResolvedValueOnce(false);
    const selected = await resolveGlassHiveNativeMediaMessageSelection(
      { text, ownerId: 'owner', conversationId: 'conversation' },
      store,
    );
    await expect(selected?.authorizePublication(retainedSession)).rejects.toThrow(
      'native_media_evidence_superseded',
    );
  });
  test.each(['ownerId', 'conversationId'] as const)(
    'rejects foreign retained source %s',
    async (field) => {
      const store = retainedStore([{ ...retainedMediaSource, [field]: 'other' }]);
      await expect(
        resolveGlassHiveNativeMediaMessageSelection(
          { text: `[Capture](${download})`, ownerId: 'owner', conversationId: 'conversation' },
          store,
        ),
      ).rejects.toThrow('native_media_authority_invalid');
      expect(store.isAccepted).not.toHaveBeenCalled();
    },
  );
  test.each([
    'Plain answer.',
    '[Source](https://docs.example.test)',
    `\`![Literal](${download})\``,
    `~~~\n![Literal](${download})\n~~~`,
  ])('ordinary links or protected examples cause no source/store work: %s', async (text) => {
    const store = retainedStore();
    expect(
      await resolveGlassHiveNativeMediaMessageSelection(
        { text, ownerId: 'owner', conversationId: 'conversation' },
        store,
      ),
    ).toBeUndefined();
    expect(store.readEvidence).not.toHaveBeenCalled();
  });
  test('unknown public grants produce no import and unknown typed references fail explicitly', async () => {
    const store = retainedStore([]);
    expect(
      await resolveGlassHiveNativeMediaMessageSelection(
        { text: `[Other](${download})`, ownerId: 'owner', conversationId: 'conversation' },
        store,
      ),
    ).toBeUndefined();
    await expect(
      resolveGlassHiveNativeMediaMessageSelection(
        {
          text: `[Other](${media.observations[0].artifact_ref})`,
          ownerId: 'owner',
          conversationId: 'conversation',
        },
        store,
      ),
    ).rejects.toThrow('native_media_selection_unavailable');
  });
  test('only actually-selected aliases on exact imported Files may canonicalize presentation', () => {
    const authored = `[Capture](${media.observations[0].open_url})\n\`[Code](${media.observations[0].artifact_ref})\``;
    const bound = bindGlassHiveNativeMediaAttachmentReferences(
      authored,
      [retainedMediaSource],
      [availableMediaFile],
      'owner',
      'answer',
    );
    expect(bound[0].nativeOutputFile).toMatchObject({
      selectedReferences: [media.observations[0].open_url],
    });
    expect(
      renderGlassHiveNativeMediaAttachmentLinks(authored, bound, {
        ownerId: 'owner',
        messageId: 'other',
      }),
    ).toBe(authored);
    expect(
      renderGlassHiveNativeMediaAttachmentLinks(authored, bound, {
        ownerId: 'other',
        messageId: 'answer',
      }),
    ).toBe(authored);
    for (const changed of [
      { ...availableMediaFile, file_id: 'ordinary' },
      {
        ...availableMediaFile,
        nativeOutputFile: {
          version: 1 as const,
          status: 'unavailable' as const,
          code: 'native_output_file_unavailable',
        },
      },
    ]) {
      expect(
        renderGlassHiveNativeMediaAttachmentLinks(authored, [changed], {
          ownerId: 'owner',
          messageId: 'answer',
        }),
      ).toBe(authored);
    }
    expect(collectGlassHiveNativeMediaReferences(authored)).toEqual([
      media.observations[0].open_url,
    ]);
  });
});
