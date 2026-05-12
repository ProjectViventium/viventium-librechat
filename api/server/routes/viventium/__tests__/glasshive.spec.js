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
let mockEnqueueGlassHiveCallbackDelivery;

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

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: (...args) => mockEnqueueGlassHiveCallbackDelivery(...args),
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

function syntheticLocalPath(...parts) {
  return ['', 'Users', 'synthetic-user', ...parts].join('/');
}

function syntheticWindowsPath(...parts) {
  return ['C:', 'Users', 'synthetic-user', ...parts].join('\\');
}

function syntheticHomePath(...parts) {
  return ['', 'home', 'synthetic-user', ...parts].join('/');
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
    mockEnqueueGlassHiveCallbackDelivery = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'msg-parent',
        parentMessageId: 'previous-assistant',
        text: 'User request.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'msg-anchor',
        parentMessageId: 'msg-parent',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
    ]);
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
    const body = callbackBody({
      operator_url: 'http://127.0.0.1:8780/watch/wrk-1?surface=desktop&project_id=prj-1',
      watch_url: 'http://127.0.0.1:8780/watch/wrk-1?surface=desktop&project_id=prj-1',
      deliverable: {
        kind: 'webpage',
        state: 'ready',
        source: `workspace_html ${syntheticLocalPath('private.html')}`,
        label: 'index.html http://127.0.0.1:8780/watch/wrk-private',
        browser_url: 'file:///workspace/project/index.html',
        preferred_surface: 'desktop',
        workspace_path: 'index.html',
      },
    });
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
    expect(message.metadata.viventium.parentMessageId).toBe('msg-parent');
    expect(message.metadata.viventium.treeParentMessageId).toBe('msg-anchor');
    expect(message.metadata.viventium.operatorUrl).toBeUndefined();
    expect(message.metadata.viventium.watchUrl).toBeUndefined();
    expect(message.metadata.viventium.deliverable).toEqual({
      kind: 'webpage',
      state: 'ready',
      source: 'workspace_html [local path]',
      label: 'index.html [local worker link]',
      preferredSurface: 'desktop',
    });
    expect(mockEnqueueGlassHiveCallbackDelivery).not.toHaveBeenCalled();
  });

  test('appends late completion callbacks to the current conversation leaf instead of branching from the original anchor', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Start worker.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-msg',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'follow-up-user',
        parentMessageId: 'assistant-anchor',
        text: 'Can you still answer here?',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:02.000Z',
      },
      {
        messageId: 'follow-up-assistant',
        parentMessageId: 'follow-up-user',
        text: 'Yes.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:03.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_late_completion_current_leaf',
      parent_message_id: 'user-msg',
      message_id: 'assistant-anchor',
      event: 'run.completed',
      message: 'Finished host worker.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.parentMessageId).toBe('follow-up-assistant');
    expect(message.metadata.viventium.parentMessageId).toBe('user-msg');
    expect(message.metadata.viventium.treeParentMessageId).toBe('follow-up-assistant');
    expect(message.metadata.viventium.anchorMessageId).toBe('assistant-anchor');
  });

  test('retries late callbacks while the current conversation leaf is a moved-on user message', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Start worker.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-msg',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'follow-up-user',
        parentMessageId: 'assistant-anchor',
        text: 'Can you still answer here?',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:02.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_late_completion_wait_for_leaf',
      parent_message_id: 'user-msg',
      message_id: 'assistant-anchor',
      event: 'run.completed',
      message: 'Finished host worker.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(425);
    expect(res.body.error).toBe('callback_conversation_tip_not_ready');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test('enqueues Telegram callbacks with sanitized full report text for durable delivery', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_telegram_full_report',
      surface: 'telegram',
      telegram_chat_id: '12345',
      telegram_user_id: '67890',
      message: 'Short preview.',
      full_message: `Short preview.\n\nFull report section without ${syntheticLocalPath(
        'private',
        'path.md',
      )}.`,
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledTimes(1);
    const payload = mockEnqueueGlassHiveCallbackDelivery.mock.calls[0][0];
    expect(payload.fullText).toContain('Full report section');
    expect(payload.fullText).toContain('[local path]');
    expect(payload.fullText).not.toContain(syntheticLocalPath());
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.metadata.viventium.hasFullText).toBe(true);
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
        `Captured 42 rows.  \n\nCreated \`${syntheticLocalPath(
          'private',
          'results.md',
        )}\`.\n\nNext step: reply continue.`,
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

  test('retries visible callbacks until the assistant anchor exists instead of creating an early branch', async () => {
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

    expect(res.statusCode).toBe(425);
    expect(res.body.error).toBe('callback_anchor_not_ready');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
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
        createdAt: '2026-04-28T13:59:59.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_blank_anchor',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'run.completed',
      message: 'Finished host worker.',
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
    expect(message.text).toBe('Finished host worker.');
    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Finished host worker.',
      },
    ]);
    expect(message.metadata.viventium.anchorMessageId).toBe('assistant-response-msg');
    expect(new Date(message.createdAt).getTime()).toBeGreaterThan(
      Date.parse('2026-04-28T14:00:00.000Z'),
    );
    expect(new Date(message.updatedAt).getTime()).toBeGreaterThan(
      Date.parse('2026-04-28T14:00:00.000Z'),
    );
    expect(mockUpdateMessage.mock.calls[0][2].overrideTimestamp).toBe(true);
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
      {
        messageId: 'assistant-response-msg',
        parentMessageId: 'user-msg',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      ...persistedMessages,
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const firstBody = callbackBody({
      callback_id: 'cb_chain_first',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
      event: 'checkpoint.ready',
      message: 'Approve the next step.',
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
      'checkpoint.ready',
      'run.completed',
    ]);
  });

  test('appends later runs from the same worker instead of overwriting the prior run result', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Start worker.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-msg',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'glasshive-status',
        parentMessageId: 'assistant-anchor',
        text: 'Initial run finished.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:02.000Z',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            workerId: 'wrk-1',
            runId: 'run-1',
            events: [{ event: 'run.completed', runId: 'run-1' }],
          },
        },
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_same_worker_later_run',
      parent_message_id: 'user-msg',
      message_id: 'assistant-anchor',
      run_id: 'run-2',
      event: 'run.completed',
      message: 'Steer run finished.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.parentMessageId).toBe('glasshive-status');
    expect(message.text).toBe('Steer run finished.');
    expect(message.metadata.viventium.runId).toBe('run-2');
    expect(message.metadata.viventium.treeParentMessageId).toBe('glasshive-status');
    expect(message.metadata.viventium.events.map((event) => event.runId)).toEqual(['run-2']);
  });

  test('appends later runs under the current leaf when an older status exists off the active branch', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Start worker.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-msg',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'glasshive-status',
        parentMessageId: 'assistant-anchor',
        text: 'Initial run finished.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:02.000Z',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            workerId: 'wrk-1',
            runId: 'run-1',
            events: [{ event: 'run.completed', runId: 'run-1' }],
          },
        },
      },
      {
        messageId: 'follow-up-user',
        parentMessageId: 'glasshive-status',
        text: 'Keep going.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:03.000Z',
      },
      {
        messageId: 'follow-up-assistant',
        parentMessageId: 'follow-up-user',
        text: 'Still here.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:04.000Z',
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_same_worker_later_run_moved_on',
      parent_message_id: 'user-msg',
      message_id: 'assistant-anchor',
      run_id: 'run-2',
      event: 'run.completed',
      message: 'Second run finished.',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    const [, message] = mockSaveMessage.mock.calls[0];
    expect(message.parentMessageId).toBe('follow-up-assistant');
    expect(message.text).toBe('Second run finished.');
    expect(message.metadata.viventium.treeParentMessageId).toBe('follow-up-assistant');
  });

  test.each([
    'worker.ready',
    'worker.resumed_by_alias',
    'run.queued',
    'run.started',
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
    expect(res.body.reason).toBe('non_user_visible_event');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test('does not update a blank assistant anchor for non-terminal run.started callbacks', async () => {
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
      callback_id: 'cb_run_started_internal',
      parent_message_id: 'user-msg',
      message_id: 'assistant-response-msg',
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

    expect(res.statusCode).toBe(202);
    expect(res.body.reason).toBe('non_user_visible_event');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['run.failed', 'Browser needs attention.', 'I got stuck: Browser needs attention.'],
    [
      'run.failed',
      'Host-native codex-cli already has an active worker (wrk_123); v1 allows one active host worker per CLI family.',
      'I got stuck: another local worker is already running, so I could not start this one yet.',
    ],
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
        failure_code:
          rawMessage.includes('already has an active worker') ? 'active_worker_conflict' : undefined,
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

  test('uses generic active-worker text even when failure_code is missing', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_active_worker_text_only',
      event: 'run.failed',
      message:
        'Host-native worker already has an active worker (wrk_123); v1 allows one active host worker per CLI family.',
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
      'I got stuck: another local worker is already running, so I could not start this one yet.',
    );
    expect(message.text).not.toContain('wrk_123');
    expect(message.text).not.toContain('CLI family');
  });

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

  test('preserves markdown delimiters when redacting local links and paths', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_sanitize_markdown_links',
      event: 'run.completed',
      message:
        `Opened \`http://127.0.0.1:12345/qa\` and saved [proof.png](${syntheticLocalPath(
          'private',
          'proof.png',
        )}).`,
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
      'Opened `[local worker link]` and saved [proof.png]([local path]).',
    );
  });

  test('redacts common local path forms with spaces before visible persistence', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_sanitize_local_paths',
      event: 'run.completed',
      message:
        `Saved \`${syntheticLocalPath(
          'My Documents',
          'result.md',
        )}\` and copied ${['', 'private', 'var', 'folders', 'synthetic', 'state.txt'].join(
          '/',
        )} from ${syntheticHomePath(
          'project',
          'output.txt',
        )} plus ${syntheticWindowsPath('Desktop', 'sample.txt')} and ${[
          '',
          'users',
          'synthetic-user',
          'lowercase.txt',
        ].join('/')}.`,
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
    expect(message.text).not.toContain(syntheticLocalPath());
    expect(message.text).not.toContain('My Documents');
    expect(message.text).not.toContain(['', 'private', 'var'].join('/'));
    expect(message.text).not.toContain(syntheticHomePath());
    expect(message.text).not.toContain(syntheticWindowsPath());
    expect(message.text).not.toContain('/users/synthetic-user');
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
    expect(mockEnqueueGlassHiveCallbackDelivery).not.toHaveBeenCalled();
  });

  test('repairs missing Telegram delivery rows for callbacks already persisted before process restart', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'msg-parent',
        parentMessageId: 'previous-assistant',
        text: 'User request.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'msg-anchor',
        parentMessageId: 'msg-parent',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'existing-status',
        parentMessageId: 'msg-anchor',
        text: 'Previous result.',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            workerId: 'wrk-1',
            runId: 'run-1',
            callbackId: 'cb_persisted_telegram_replay',
            callbackKey: 'cb_persisted_telegram_replay',
            events: [
              {
                callbackId: 'cb_persisted_telegram_replay',
                callbackKey: 'cb_persisted_telegram_replay',
              },
            ],
          },
        },
      },
    ]);
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_persisted_telegram_replay',
      surface: 'telegram',
      telegram_chat_id: '12345',
      telegram_user_id: '67890',
      message: 'Updated result.',
    });
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
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ callback_id: 'cb_persisted_telegram_replay' }),
        message: expect.objectContaining({ messageId: 'existing-status' }),
        text: 'Previous result.',
      }),
    );
  });

  test('repairs missing Telegram delivery rows even while callback id is still in the replay cache', async () => {
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_seen_telegram_repair',
      surface: 'telegram',
      telegram_chat_id: '12345',
      telegram_user_id: '67890',
      message: 'First result.',
    });
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

    expect(first.statusCode).toBe(200);
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledTimes(1);
    mockSaveMessage.mockClear();
    mockUpdateMessage.mockClear();
    mockEnqueueGlassHiveCallbackDelivery.mockClear();
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'msg-parent',
        parentMessageId: 'previous-assistant',
        text: 'User request.',
        isCreatedByUser: true,
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        messageId: 'msg-anchor',
        parentMessageId: 'msg-parent',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        messageId: 'existing-status',
        parentMessageId: 'msg-anchor',
        text: 'First result.',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            workerId: 'wrk-1',
            runId: 'run-1',
            callbackId: 'cb_seen_telegram_repair',
            callbackKey: 'cb_seen_telegram_repair',
            events: [
              {
                callbackId: 'cb_seen_telegram_repair',
                callbackKey: 'cb_seen_telegram_repair',
              },
            ],
          },
        },
      },
    ]);
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

    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('duplicate_callback');
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ callback_id: 'cb_seen_telegram_repair' }),
        message: expect.objectContaining({ messageId: 'existing-status' }),
        text: 'First result.',
      }),
    );
  });

  test('returns retryable failure when Telegram delivery enqueue fails after message persistence', async () => {
    mockEnqueueGlassHiveCallbackDelivery.mockRejectedValueOnce(new Error('delivery db down'));
    const router = require('../glasshive');
    const app = createTestApp(router);
    const body = callbackBody({
      callback_id: 'cb_delivery_enqueue_failure',
      surface: 'telegram',
      telegram_chat_id: '12345',
      telegram_user_id: '67890',
    });
    const req = createMockReq({
      url: '/api/viventium/glasshive/callback',
      headers: { 'x-glasshive-signature': signature(body) },
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('delivery_enqueue_failed');
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledTimes(1);
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
