/* === VIVENTIUM START ===
 * Feature: GlassHive host-worker callbacks
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const crypto = require('crypto');
const express = require('express');

let mockSaveMessage;
let mockUpdateMessage;
let mockGetConvo;
let mockGetMessages;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      warn: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  getConvo: (...args) => mockGetConvo(...args),
  getMessages: (...args) => mockGetMessages(...args),
  saveMessage: (...args) => mockSaveMessage(...args),
  updateMessage: (...args) => mockUpdateMessage(...args),
}));

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function signature(body, secret = 'callback-secret') {
  const binding = `${String(body.worker_id || '').trim()}:${String(body.run_id || '').trim()}`;
  const perRunSecret = crypto.createHmac('sha256', secret).update(binding).digest('hex');
  return `sha256=${crypto
    .createHmac('sha256', perRunSecret)
    .update(Buffer.from(stableStringify(body), 'utf8'))
    .digest('hex')}`;
}

function callbackBody(overrides = {}) {
  return {
    callback_id: `cb_${crypto.randomUUID().replaceAll('-', '')}`,
    callback_ts: Math.floor(Date.now() / 1000),
    event: 'run.completed',
    message: 'Codex worker finished the task.',
    user_id: 'user-1',
    agent_id: 'agent-main',
    conversation_id: 'conv-1',
    parent_message_id: 'msg-parent',
    message_id: 'msg-anchor',
    worker_id: 'wrk-1',
    run_id: 'run-1',
    surface: 'api',
    ...overrides,
  };
}

function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/glasshive', router);
  return app;
}

function createMockReq({ url, headers = {}, body = {} }) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  return {
    method: 'POST',
    url,
    originalUrl: url,
    path: url.replace('/api/viventium/glasshive', '') || '/',
    headers: normalized,
    body,
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
    on: jest.fn(),
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value;
    }),
    getHeader(name) {
      return res.headers[name];
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json: jest.fn((payload) => {
      res.body = payload;
      res.writableEnded = true;
      res._resolve();
      return res;
    }),
  };
  res._done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return res;
}

function dispatch(app, req, res) {
  app.handle(req, res, (err) => {
    if (err) {
      throw err;
    }
    if (!res.writableEnded) {
      res._resolve();
    }
  });
  return res._done;
}

describe('/api/viventium/glasshive/callback', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSaveMessage = jest.fn().mockResolvedValue({});
    mockUpdateMessage = jest.fn().mockResolvedValue({});
    mockGetConvo = jest.fn().mockResolvedValue({ conversationId: 'conv-1', user: 'user-1' });
    mockGetMessages = jest.fn().mockResolvedValue([]);
    process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET = 'callback-secret';
  });

  test('rejects callbacks with an invalid HMAC signature', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody();
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': 'sha256=bad' },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('binds callback signatures to the worker and run ids', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const originalBody = callbackBody();
    const tamperedBody = { ...originalBody, run_id: 'run-other' };
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(originalBody) },
      body: tamperedBody,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('persists a signed completion callback into the originating conversation', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody();
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(mockGetConvo).toHaveBeenCalledWith('user-1', 'conv-1');
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    const [saveReq, message] = mockSaveMessage.mock.calls[0];
    expect(saveReq.user.id).toBe('user-1');
    expect(message.conversationId).toBe('conv-1');
    expect(message.parentMessageId).toBe('msg-anchor');
    expect(message.text).toBe('Codex worker finished the task.');
    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Codex worker finished the task.',
      },
    ]);
    expect(message.metadata.viventium.workerId).toBe('wrk-1');
  });

  test('verifies and persists literal UTF-8 callback text', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_unicode_text',
      message: 'Finished — “quoted” café.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toBe('Finished — “quoted” café.');
  });

  test('preserves readable callback paragraphs while redacting local details', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_multiline_text',
      message:
        'Captured 42 rows.  \n\nCreated `/Users/example/private/results.md`.\n\nNext step: reply continue.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toBe(
      'Captured 42 rows.\n\nCreated `[local path]`.\n\nNext step: reply continue.',
    );
    expect(message.content[0].text).toBe(message.text);
  });

  test('keeps long final-result callback text within the shared worker limit', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const longResult = `Summary:\n\n${'A'.repeat(1500)}\n\nNext step: none.`;
    const body = callbackBody({
      callback_id: 'cb_long_final_result',
      message: longResult,
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toBe(longResult);
    expect(message.content[0].text).toBe(longResult);
  });

  test('preserves leading indentation in callback text', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const codeBlock = 'Summary:\n\n```json\n  {  "ok":   true  }\n```';
    const body = callbackBody({
      callback_id: 'cb_indented_final_result',
      message: codeBlock,
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toContain('\n  { "ok": true }\n');
    expect(message.content[0].text).toBe(message.text);
  });

  test('rejects visible callbacks without an assistant anchor message id so GlassHive retries or records failure', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ message_id: '' });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(425);
    expect(res.body.error).toBe('missing_callback_anchor');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test('anchors early callbacks to the assistant response message id instead of creating a sibling branch', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: 'previous-assistant',
        createdAt: '2026-04-28T14:00:00.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_early_anchor',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'checkpoint.ready',
      message: 'Approve the next step.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.parentMessageId).toBe('assistant-response-msg');
    expect(message.metadata.viventium.requestedParentMessageId).toBe('user-msg');
    expect(message.metadata.viventium.anchorMessageId).toBe('assistant-response-msg');
  });

  test('updates a blank assistant anchor instead of leaving an empty status bubble', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: 'previous-assistant',
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'assistant-response-msg',
        parentMessageId: 'user-msg',
        text: '',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_blank_anchor',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'run.started',
      message: 'Raw worker start text that should not be exposed.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    const [, message] = mockUpdateMessage.mock.calls[0];
    expect(message.messageId).toBe('assistant-response-msg');
    expect(message.parentMessageId).toBe('user-msg');
    expect(message.text).toBe('I’m working on it now.');
    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'I’m working on it now.',
      },
    ]);
    expect(message.metadata.viventium.anchorMessageId).toBe('assistant-response-msg');
  });

  test('updates one GlassHive status message instead of creating callback branches', async () => {
    const persistedMessages = [];
    mockSaveMessage = jest.fn().mockImplementation(async (_req, message) => {
      persistedMessages.push({
        ...message,
        createdAt: `2026-04-28T14:00:0${persistedMessages.length + 1}.000Z`,
      });
      return {};
    });
    mockGetMessages = jest.fn().mockImplementation(async () => [
      {
        messageId: 'user-msg',
        parentMessageId: 'previous-assistant',
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      ...persistedMessages,
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const firstBody = callbackBody({
      callback_id: 'cb_chain_first',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'run.started',
      message: 'Raw worker start text that should not be exposed.',
    });
    const firstRes = createMockRes();

    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(firstBody) },
        body: firstBody,
      }),
      firstRes,
    );

    const firstSaved = persistedMessages[0];
    mockUpdateMessage = jest.fn().mockImplementation(async (_req, message) => {
      persistedMessages[0] = {
        ...persistedMessages[0],
        ...message,
        updatedAt: '2026-04-28T14:00:03.000Z',
      };
      return {};
    });
    const secondBody = callbackBody({
      callback_id: 'cb_chain_second',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'run.completed',
      message: 'Finished host worker.',
    });
    const secondRes = createMockRes();

    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(secondBody) },
        body: secondBody,
      }),
      secondRes,
    );

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    const [, updated] = mockUpdateMessage.mock.calls[0];
    expect(updated.messageId).toBe(firstSaved.messageId);
    expect(updated.parentMessageId).toBe('assistant-response-msg');
    expect(updated.text).toBe('Finished host worker.');
    expect(updated.content).toEqual([
      {
        type: 'text',
        text: 'Finished host worker.',
      },
    ]);
    expect(updated.metadata.viventium.events.map((event) => event.event)).toEqual([
      'run.started',
      'run.completed',
    ]);
  });

  test.each([
    'worker.ready',
    'worker.resumed_by_alias',
    'run.queued',
    'worker.paused',
    'worker.interrupted',
    'worker.terminated',
  ])('ignores %s callbacks so users do not get worker plumbing chatter', async (event) => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: `cb_${event.replaceAll('.', '_')}_ignored`,
      event,
      message: 'Raw worker lifecycle text that should stay hidden.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body.reason).toBe('missing_context_or_text');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test('persists run.started as one concise status message for long-running workers', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_run_started_visible',
      event: 'run.started',
      message: 'Raw worker lifecycle text that should stay hidden.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toBe('I’m working on it now.');
  });

  test.each([
    ['run.failed', 'Browser needs attention.', 'I got stuck: Browser needs attention.'],
    ['run.cancelled', 'The task was cancelled.', 'I stopped: The task was cancelled.'],
    ['run.interrupted', 'The run was interrupted.', 'I stopped: The run was interrupted.'],
    [
      'takeover.requested',
      'Please take over the browser.',
      'I need you to take over: Please take over the browser.',
    ],
  ])(
    'formats visible %s callbacks in user-facing language',
    async (event, rawMessage, expected) => {
      const router = require('../glasshive');
      const app = createTestApp(router);
      const body = callbackBody({
        callback_id: `cb_${event.replaceAll('.', '_')}_visible`,
        event,
        message: rawMessage,
      });
      const req = createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(body) },
        body,
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      expect(res.statusCode).toBe(200);
      const [, message] = mockSaveMessage.mock.calls[0];
      expect(message.text).toBe(expected);
    },
  );

  test('sanitizes worker plumbing from visible callback text', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_sanitize_plumbing',
      event: 'run.failed',
      message:
        'Worker wrk_visual_qa run_visual_qa prj_visual_qa failed at http://127.0.0.1:8766/ui/workers/wrk_visual_qa/terminal from ~/private/state.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text).toContain('[worker id]');
    expect(message.text).toContain('[run id]');
    expect(message.text).toContain('[project id]');
    expect(message.text).toContain('[local worker link]');
    expect(message.text).toContain('[local path]');
    expect(message.text).not.toContain('127.0.0.1:8766');
    expect(message.text).not.toContain('wrk_visual_qa');
    expect(message.text).not.toContain('run_visual_qa');
    expect(message.text).not.toContain('prj_visual_qa');
    expect(message.text).not.toContain('~/private');
  });

  test('redacts common local path forms with spaces before visible persistence', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_sanitize_local_paths',
      event: 'run.completed',
      message:
        'Saved `/Users/example/My Documents/result.md` and copied /private/var/folders/example/state.txt from /home/example/project/output.txt plus C:\\Users\\example\\Desktop\\sample.txt and /users/example/lowercase.txt.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.text.match(/\[local path\]/g)).toHaveLength(5);
    expect(message.text).not.toContain('/Users/example');
    expect(message.text).not.toContain('My Documents');
    expect(message.text).not.toContain('/private/var');
    expect(message.text).not.toContain('/home/example');
    expect(message.text).not.toContain('C:\\Users\\example');
    expect(message.text).not.toContain('/users/example');
  });

  test('rejects stale callbacks before persistence', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ callback_ts: Math.floor(Date.now() / 1000) - 1000 });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('stale_callback');
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('rejects replayed callback ids', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ callback_id: 'cb_replay' });
    const first = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(body) },
        body,
      }),
      first,
    );

    const second = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(body) },
        body,
      }),
      second,
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('duplicate_callback');
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });

  test('rejects replayed callback ids already persisted before process restart', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'existing-status',
        parentMessageId: 'msg-anchor',
        text: 'Previous result.',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            workerId: 'wrk-1',
            runId: 'run-1',
            callbackId: 'cb_persisted_replay',
            callbackKey: 'cb_persisted_replay',
            events: [{ callbackId: 'cb_persisted_replay', callbackKey: 'cb_persisted_replay' }],
          },
        },
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ callback_id: 'cb_persisted_replay' });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('duplicate_callback');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test('allows retry with the same callback id after persistence failure', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ callback_id: 'cb_retry_after_persist_failure' });
    mockSaveMessage
      .mockRejectedValueOnce(new Error('temporary db error'))
      .mockResolvedValueOnce({});

    const first = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(body) },
        body,
      }),
      first,
    );

    const second = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/glasshive/callback',
        headers: { 'x-glasshive-signature': signature(body) },
        body,
      }),
      second,
    );

    expect(first.statusCode).toBe(500);
    expect(first.body.error).toBe('persist_failed');
    expect(second.statusCode).toBe(200);
    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
  });

  test('rejects callbacks for conversations outside the user scope', async () => {
    mockGetConvo.mockResolvedValueOnce(null);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({ callback_id: 'cb_cross_tenant' });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('conversation_not_found');
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });
});
