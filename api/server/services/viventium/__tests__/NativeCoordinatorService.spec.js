const crypto = require('node:crypto');
const mockWarn = jest.fn();
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: (...args) => mockWarn(...args) },
}));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: jest.fn() }));
jest.mock('../GlassHiveConversationProviderService', () => ({
  attachConversationProviderBootstrapBundle: jest.fn(),
}));
const { receive } = require('../NativeCoordinatorService');

test('a signed malformed notification cannot echo its supplied type into diagnostics', async () => {
  const prior = process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET;
  const secret = Buffer.alloc(32, 7).toString('base64');
  process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET = secret;
  const now = Date.now();
  const eventId = 'event-synthetic-invalid';
  const timestamp = String(Math.floor(now / 1000));
  const marker = 'SYNTHETIC_UNTRUSTED_NOTIFICATION_TEXT';
  const rawBody = Buffer.from(
    JSON.stringify({
      type: marker,
      event_id: eventId,
      principal: { owner_id: 'synthetic-owner', tenant_id: 'local' },
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60000).toISOString(),
      data: { conversation_id: 'synthetic-native', request_ref: 'synthetic-binding' },
    }),
  );
  const signature =
    'v1,' +
    crypto
      .createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`${eventId}.${timestamp}.`)
      .update(rawBody)
      .digest('base64');
  const headers = {
    'webhook-id': eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  };
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  try {
    await receive({ viventiumScheduleDueRawBody: rawBody, get: (name) => headers[name] }, response);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ error: 'coordinator_continuation_unavailable' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('received');
  } finally {
    if (prior === undefined) delete process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET;
    else process.env.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET = prior;
  }
});
