/* === VIVENTIUM START ===
 * Feature: Local Skyvern bridge route tests
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

let mockGetUserKeyValues;
let mockUpdateUserKey;
let mockFindOne;
let mockLoggerError;

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: (...args) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    openAI: 'openAI',
    anthropic: 'anthropic',
  },
}));

jest.mock('mongoose', () => ({
  models: {
    Key: {
      findOne: (...args) => mockFindOne(...args),
    },
  },
}));

jest.mock('~/models', () => ({
  getUserKeyValues: (...args) => mockGetUserKeyValues(...args),
  updateUserKey: (...args) => mockUpdateUserKey(...args),
}));

function createKeyQuery(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/viventium/skyvern', require('../skyvern'));
  return app;
}

describe('/api/viventium/skyvern/openai/v1/chat/completions', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockLoggerError = jest.fn();
    mockGetUserKeyValues = jest.fn();
    mockUpdateUserKey = jest.fn().mockResolvedValue(undefined);
    mockFindOne = jest.fn().mockReturnValue(createKeyQuery({ userId: 'user-1' }));
    process.env.SKYVERN_API_KEY = 'bridge-secret';
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VIVENTIUM_ANTHROPIC_DIRECT_API_KEY;
    delete process.env.VIVENTIUM_SKYVERN_BRIDGE_API_KEY;
    global.fetch = jest.fn();
  });

  test('rejects requests without the bridge secret', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/viventium/skyvern/openai/v1/chat/completions')
      .send({ model: 'openai/gpt-5.4', messages: [] });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Unauthorized');
  });

  test('uses OpenAI connected account via Codex responses and returns chat completion JSON', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'openai-access-token',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers: {
        'OpenAI-Beta': 'responses=experimental',
        originator: 'pi',
      },
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
      oauthExpiresAt: Date.now() + 60 * 60 * 1000,
    });

    global.fetch.mockResolvedValueOnce(
      new Response(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_1","object":"response","output":[]}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","usage":{"input_tokens":11,"output_tokens":2},"output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const app = createTestApp();
    const response = await request(app)
      .post('/api/viventium/skyvern/openai/v1/chat/completions')
      .set('authorization', 'Bearer bridge-secret')
      .send({
        model: 'openai/gpt-5.4',
        max_tokens: 64,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('OK');
    expect(response.body.usage.total_tokens).toBe(13);

    const [, fetchInit] = global.fetch.mock.calls[0];
    const upstreamBody = JSON.parse(fetchInit.body);
    expect(upstreamBody.model).toBe('gpt-5.4');
    expect(upstreamBody.instructions).toBe('You are concise.');
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamBody.store).toBe(false);
    expect(upstreamBody.max_output_tokens).toBeUndefined();
    expect(upstreamBody.temperature).toBeUndefined();
  });

  test('refreshes OpenAI connected accounts when the token is expired', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'expired-openai-token',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers: {
        'OpenAI-Beta': 'responses=experimental',
        originator: 'pi',
      },
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
      refreshToken: 'refresh-openai-token',
      oauthExpiresAt: Date.now() - 1000,
    });

    global.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'refreshed-openai-access-token',
            refresh_token: 'refresh-openai-token-2',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}]}}',
            '',
          ].join('\n'),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const app = createTestApp();
    const response = await request(app)
      .post('/api/viventium/skyvern/openai/v1/chat/completions')
      .set('authorization', 'Bearer bridge-secret')
      .send({
        model: 'openai/gpt-5.4',
        messages: [{ role: 'user', content: 'test' }],
      });

    expect(response.status).toBe(200);
    expect(mockUpdateUserKey).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('uses Anthropic connected account bearer auth for Anthropic models', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'anthropic-oauth-test-token',
      authToken: 'anthropic-oauth-test-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
      oauthExpiresAt: Date.now() + 60 * 60 * 1000,
    });

    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Anthropic OK' }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createTestApp();
    const response = await request(app)
      .post('/api/viventium/skyvern/openai/v1/chat/completions')
      .set('authorization', 'Bearer bridge-secret')
      .send({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Say hello' }],
      });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Anthropic OK');

    const [fetchUrl, fetchInit] = global.fetch.mock.calls[0];
    expect(fetchUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchInit.headers.authorization).toBe('Bearer anthropic-oauth-test-token');
    expect(fetchInit.headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(JSON.parse(fetchInit.body).system).toEqual([
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ]);
  });
});
