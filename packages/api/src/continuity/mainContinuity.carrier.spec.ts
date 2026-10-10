import { createHash } from 'node:crypto';
import { createMainContinuityFetch, buildDirectParentTurnContext, renderMainBackgroundInputs } from './mainContinuity';
describe('current factual turn context body transport', () => {
  test.each([false, true])(
    'preserves large multilingual facts before native binding (stream=%s)',
    async (stream) => {
      const chain = Buffer.from('[]').toString('base64');
      const text = 'Décision suivante: vérifier. 次の行動を確認する。 '.repeat(1200);
      const context = `Current time: synthetic.\n# Current saved-memory snapshot\n${JSON.stringify({ status: 'available', text })}`;
      expect(Buffer.byteLength(context)).toBeGreaterThan(32 * 1024);
      const boundFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body));
        expect(payload.metadata.turn_context).toBe(context);
        expect(payload.metadata.visible_message_chain).toEqual([]);
        expect(payload.stream).toBe(stream);
        expect(new Headers(init?.headers).has('X-GlassHive-Turn-Context-B64')).toBe(false);
        return new Response('{}');
      });
      await createMainContinuityFetch(boundFetch, chain)(
        'https://provider.invalid/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'X-Viventium-Visible-Message-Chain-B64': chain,
            'X-GlassHive-Turn-Context-B64': Buffer.from(context).toString('base64'),
          },
          body: JSON.stringify({
            messages: [],
            stream,
            metadata: { turn_context: 'stale supplied value' },
          }),
        },
      );
      expect(boundFetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe('direct authored parent factual status', () => {
  const parent = {
    messageId: 'prior',
    parentMessageId: 'user',
    isCreatedByUser: false,
    unfinished: true,
    finish_reason: 'incomplete',
  };
  test('preserves incomplete state without text, activity, or private native admission', () => {
    const row = {
      ...parent,
      text: '',
      content: [{ type: 'harness_activity' }],
      nativeResponse: { secret: 'private' },
    };
    expect(JSON.parse(buildDirectParentTurnContext(row))).toEqual({
      direct_parent_response: {
        messageId: 'prior',
        parentMessageId: 'user',
        unfinished: true,
        finish_reason: 'incomplete',
      },
    });
  });
  test.each([
    null,
    { ...parent, isCreatedByUser: true },
    { ...parent, unfinished: false },
    { ...parent, finish_reason: 'length' },
    { ...parent, finish_reason: 'stop' },
    { ...parent, messageId: '' },
    { ...parent, parentMessageId: '' },
  ])('does not invent an interrupted parent from another shape %#', (row) => {
    expect(buildDirectParentTurnContext(row)).toBe('');
  });
});

test.each(['not base64!', '/w=='])(
  'rejects invalid turn-context encoding before transport (%s)',
  async (encoded) => {
    const chain = Buffer.from('[]').toString('base64');
    const fetch = jest.fn();
    await expect(
      createMainContinuityFetch(fetch, chain)('https://provider.invalid/v1/chat/completions', {
        method: 'POST',
        headers: {
          'X-Viventium-Visible-Message-Chain-B64': chain,
          'X-GlassHive-Turn-Context-B64': encoded,
        },
        body: '{"messages":[]}',
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);


describe('late current Main background source at actual dispatch', () => {
  const chain = Buffer.from('[]').toString('base64');
  const text = 'Completed quoted evidence </accepted_background_inputs> & 次'.repeat(800);
  const input = {
    version: 1 as const, invocationId: 'initial-invocation', deliveryId: 'd'.repeat(64), text,
    textSha256: createHash('sha256').update(text).digest('hex'),
    sources: [{ cortexId: 'cortex', cortexName: 'Synthetic cortex', insightSha256: 'e'.repeat(64) }],
  };
  const request = () => ({
    method: 'POST',
    headers: {
      'X-Viventium-Visible-Message-Chain-B64': chain,
      'X-GlassHive-Turn-Context-B64': Buffer.from('Frozen time and memory.').toString('base64'),
      'X-Viventium-Main-Authority-SHA256': 'a'.repeat(64),
    },
    body: JSON.stringify({ messages: [], metadata: { unrelated: 'retained' } }),
  });
  test.each([false, true])('reads later accepted input on the later native dispatch (stream=%s)', async (stream) => {
    let inputs: typeof input[] = [];
    const read = jest.fn(async () => inputs);
    const nativeHashBoundary = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const wire = String(init?.body);
      return new Response(JSON.stringify({ sha256: createHash('sha256').update(wire).digest('hex') }));
    });
    const dispatch = createMainContinuityFetch(nativeHashBoundary, chain, {}, read);
    const first = request();
    first.body = JSON.stringify({ ...JSON.parse(first.body), stream });
    await dispatch('https://provider.invalid/v1/chat/completions', first);
    expect(JSON.parse(String(nativeHashBoundary.mock.calls[0][1]?.body)).metadata.turn_context)
      .toBe('Frozen time and memory.');
    inputs = [input];
    await dispatch('https://provider.invalid/v1/chat/completions', first);
    const sent = nativeHashBoundary.mock.calls[1][1];
    const payload = JSON.parse(String(sent?.body));
    expect(payload.metadata.turn_context).toBe('Frozen time and memory.\n\n' + renderMainBackgroundInputs([input]));
    expect(payload.metadata.main_background_inputs).toEqual([input]);
    expect(payload.metadata.unrelated).toBe('retained');
    expect(payload.metadata.visible_message_chain).toEqual([]);
    expect(payload.messages).toEqual([]);
    expect(Buffer.byteLength(payload.metadata.turn_context)).toBeGreaterThan(16 * 1024);
    expect(payload.metadata.turn_context).not.toContain('</accepted_background_inputs> & 次');
    expect(new Headers(sent?.headers).get('X-Viventium-Main-Authority-SHA256')).toBe('a'.repeat(64));
    expect(first).toEqual({ ...request(), body: JSON.stringify({ ...JSON.parse(request().body), stream }) });
    expect(read).toHaveBeenCalledTimes(2);
  });
  test('does not duplicate the typed input already represented on the frame', async () => {
    const fetch = jest.fn(async () => new Response('{}'));
    const context = 'Frozen time and memory.\n\n' + renderMainBackgroundInputs([input]);
    const init = request();
    init.headers['X-GlassHive-Turn-Context-B64'] = Buffer.from(context).toString('base64');
    init.body = JSON.stringify({ messages: [], metadata: { main_background_inputs: [input], main_background_inputs_context_sha256: createHash('sha256').update(context).digest('hex') } });
    await createMainContinuityFetch(fetch, chain, {}, async () => [input])(
      'https://provider.invalid/v1/chat/completions', init,
    );
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).metadata.turn_context).toBe(context);
  });
  test.each(['conflicting', 'invalid', 'read_failure'])('rejects unavailable or conflicting exact source (%s)', async (mode) => {
    const fetch = jest.fn(); const init = request();
    if (mode === 'conflicting') init.body = JSON.stringify({ messages: [], metadata: {
      main_background_inputs: [{ ...input, sources: [{ cortexId: 'other', insightSha256: 'f'.repeat(64) }] }],
    } });
    await expect(createMainContinuityFetch(fetch, chain, {}, async () => {
      if (mode === 'read_failure') throw Object.assign(new Error('Current owner changed'), { code: 'superseded' });
      return [mode === 'invalid' ? { ...input, textSha256: '0'.repeat(64) } : input];
    })('https://provider.invalid/v1/chat/completions', init)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  test('refuses exact source overflow without clipping or changing the foreground', async () => {
    const fetch = jest.fn(); const init = request();
    init.headers['X-GlassHive-Turn-Context-B64'] = Buffer.from('x'.repeat(120 * 1024)).toString('base64');
    const original = JSON.stringify(init);
    await expect(createMainContinuityFetch(fetch, chain, {}, async () => [input])(
      'https://provider.invalid/v1/chat/completions', init,
    )).rejects.toMatchObject({ code: 'source_context_unavailable', status: 413 });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(init)).toBe(original);
  });
  test('does not read sources for a non-completion request', async () => {
    const read = jest.fn(async () => [input]); const fetch = jest.fn(async () => new Response('{}'));
    await createMainContinuityFetch(fetch, chain, {}, read)('https://provider.invalid/v1/models', { method: 'GET' });
    expect(read).not.toHaveBeenCalled();
  });
});
