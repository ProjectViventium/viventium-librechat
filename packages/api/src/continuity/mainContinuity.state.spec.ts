import { createHash } from 'node:crypto';
import { createMainContinuityFetch, encodeMainContextStateBlock, MAIN_CONTEXT_STATE_BLOCKS_HEADER } from './mainContinuity';

const roster = '<typed_data>\n{"goal":"é 漢字 \\"quoted\\"","snapshot":"fresh"}\n</typed_data>';
const context = `Current time: synthetic.\n${roster}\nEnd.`;
const chain = Buffer.from('[]').toString('base64');
const nativeCall = (fetch: typeof global.fetch, descriptor?: string, supplied?: unknown) =>
  createMainContinuityFetch(fetch, chain)('https://provider.invalid/v1/chat/completions', {
    method: 'POST', headers: { 'X-Viventium-Visible-Message-Chain-B64': chain, 'X-GlassHive-Turn-Context-B64': Buffer.from(context).toString('base64'),
      ...(descriptor === undefined ? {} : { [MAIN_CONTEXT_STATE_BLOCKS_HEADER]: descriptor }) },
    body: JSON.stringify({ messages: [], metadata: { main_context_state_blocks: supplied } }),
  });

test('compiler-owned UTF8 range moves to body metadata and small header is stripped', async () => {
  const descriptor = encodeMainContextStateBlock(context, roster);
  const expected = [{ kind: 'active_work', start_utf8: Buffer.byteLength('Current time: synthetic.\n'),
    length_utf8: Buffer.byteLength(roster), sha256: createHash('sha256').update(roster).digest('hex') }];
  const fetch = jest.fn(async (_input, init) => {
    expect(new Headers(init?.headers).has(MAIN_CONTEXT_STATE_BLOCKS_HEADER)).toBe(false);
    const metadata = JSON.parse(String(init?.body)).metadata;
    expect(metadata.main_context_state_blocks).toEqual(expected);
    expect(metadata.turn_context).toBe(context);
    return new Response('{}');
  });
  await nativeCall(fetch, descriptor, [{ kind: 'forged' }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('no authored source means no optimization even when the body claims a descriptor', async () => {
  const fetch = jest.fn(async (_input, init) => {
    expect(JSON.parse(String(init?.body)).metadata.main_context_state_blocks).toBeUndefined();
    return new Response('{}');
  });
  await nativeCall(fetch, undefined, [{ kind: 'active_work', start_utf8: 0 }]);
});

test.each(['empty','missing','ambiguous'])('missing or ambiguous authored source is not inferred (%s)', kind => {
  expect(encodeMainContextStateBlock(kind === 'ambiguous' ? `${roster}\n${roster}` : context,
    kind === 'empty' ? '' : kind === 'missing' ? roster + 'absent' : roster)).toBe('');
});

test.each([
  { start_utf8: -1 }, { length_utf8: 0 }, { length_utf8: true }, { sha256: 'b'.repeat(64) },
  { kind: 'other' }, { extra: true }, { start_utf8: 999999 },
])('rejects altered authored range before any network (%#)', async change => {
  const blocks = JSON.parse(Buffer.from(encodeMainContextStateBlock(context, roster), 'base64').toString());
  const descriptor = Buffer.from(JSON.stringify([{ ...blocks[0], ...change }])).toString('base64');
  const fetch = jest.fn();
  await expect(nativeCall(fetch, descriptor)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
