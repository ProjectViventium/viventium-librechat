import path from 'path';

describe('packages/api dist Codex normalization', () => {
  it('lifts system and developer messages into top-level instructions in the shipped dist bundle', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true, echoed: init?.body ?? null }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      jest.resetModules();
      const distPath = path.resolve(__dirname, '../../../dist/index.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getOpenAIConfig } = require(distPath) as {
        getOpenAIConfig: (
          apiKey: string,
          options?: Record<string, unknown>,
        ) => { configOptions?: { fetch?: typeof fetch } };
      };

      const result = getOpenAIConfig('mock-api-key', {
        reverseProxyUrl: 'https://chatgpt.com/backend-api/codex',
      });

      const wrappedFetch = result.configOptions?.fetch;
      expect(wrappedFetch).toBeDefined();

      await wrappedFetch?.('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.2',
          input: [
            { type: 'message', role: 'system', content: 'System instruction' },
            {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: 'Developer instruction' }],
            },
            { type: 'message', role: 'user', content: 'hello' },
          ],
          stream: false,
        }),
      });

      const sentInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
      const sentPayload = JSON.parse(String(sentInit.body));
      expect(sentPayload.instructions).toBe('System instruction\n\nDeveloper instruction');
      expect(sentPayload.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
      expect(sentPayload.include).toEqual(['reasoning.encrypted_content']);
      expect(sentPayload.store).toBe(false);
      expect(sentPayload.stream).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
