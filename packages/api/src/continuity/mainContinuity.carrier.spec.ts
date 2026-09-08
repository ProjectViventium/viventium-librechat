import { createMainContinuityFetch, buildDirectParentTurnContext } from './mainContinuity';
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
