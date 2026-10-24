import { createHash } from 'crypto';
import {
  buildMainGenerationPresentation,
  createMainGenerationPresentationVerifier,
} from './mainGenerationPresentation';
import type { MainGenerationDelivery, MainGenerationMessage } from './mainGenerationPresentation';
import type {
  ScheduleDueAdmission,
  ScheduledConversationBinding,
} from '../scheduling/scheduleDueReceiver';

function fixture(surface: 'telegram' | 'voice' = 'telegram') {
  const binding: ScheduledConversationBinding = {
    _id: 'binding-a',
    kind: 'schedule_binding',
    ownerId: 'owner-a',
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    taskText: 'Original authorized task',
    sourceEventId: 'source-a',
    active: true,
    createdAt: new Date(),
    destinations: [
      { surface: 'librechat' },
      { surface: 'telegram', telegramChatId: 'chat-a', telegramUserId: 'tg-a' },
    ],
  };
  const admission: ScheduleDueAdmission = {
    _id: 'admission-a',
    kind: 'schedule_due',
    userId: 'owner-a',
    idempotencyKey: 'idempotency-a',
    streamId: 'stream-a',
    conversationId: 'conversation-a',
    status: 'accepted',
    dueState: 'delivery_queued',
    eventId: 'event-a',
    requestDigest: 'digest-a',
    bindingRef: 'binding-a',
    resultMessageId: 'message-a',
    admittedAt: new Date(),
    updatedAt: new Date(),
    envelope: {
      type: 'schedule.due',
      schedule_id: 'schedule-a',
      schedule_version: 1,
      occurrence_id: 'occurrence-a',
      scheduled_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      principal: { tenant_id: 'tenant-a', owner_id: 'owner-a' },
      request_data: { request_ref: 'binding-a' },
    },
  };
  const message: MainGenerationMessage = {
    messageId: 'message-a',
    user: 'owner-a',
    conversationId: 'conversation-a',
    isCreatedByUser: false,
    text: 'Actual Main reply. ',
  };
  const presentation = buildMainGenerationPresentation(
    { streamId: admission.streamId, admissionId: admission._id },
    message.messageId,
    message.text!,
  )!;
  const row: MainGenerationDelivery = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    callbackMessageId: 'message-a',
    originRef: 'binding-a',
    event: 'main.followup',
    surface,
    text: message.text!.trim(),
    telegramChatId: 'chat-a',
    telegramUserId: 'tg-a',
    voiceCallSessionId: 'call-a',
    mainGenerationPresentation: presentation,
  };
  const mapping = { telegramChatId: 'chat-a', telegramUserId: 'tg-a' };
  const call = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    status: 'active',
    mode: 'call',
  };
  const deps = {
    readAdmission: jest.fn(async () => admission),
    readBinding: jest.fn(async () => binding),
    readMessage: jest.fn(async () => message),
    readOwner: jest.fn(async () => true),
    readConversation: jest.fn(async (_ownerId: string, _conversationId: string) => ({
      endpoint: 'agents',
    })),
    readTelegram: jest.fn(async () => mapping),
    readCall: jest.fn(async () => call),
  };
  return {
    binding,
    admission,
    message,
    presentation,
    row,
    mapping,
    call,
    deps,
    verify: createMainGenerationPresentationVerifier(deps),
  };
}

test('binds exact canonical Main text and accepted admission without a worker result', async () => {
  const f = fixture();
  expect(f.presentation.responseDigest).toBe(
    'sha256:' + createHash('sha256').update(f.message.text!).digest('hex'),
  );
  expect(await f.verify(f.row, {})).toBe(true);
  expect(f.deps.readMessage).toHaveBeenCalledWith('owner-a', 'conversation-a', 'message-a', {});
});

test.each([
  'owner',
  'conversation',
  'stream',
  'binding',
  'response',
  'status',
  'generation',
  'tenant',
  'binding-conversation',
  'active',
  'canonical-text',
  'user-message',
  'chat',
  'account',
])('rejects changed %s evidence before presentation', async (kind) => {
  const f = fixture();
  if (kind === 'owner') f.admission.userId = 'other-owner';
  if (kind === 'conversation') f.admission.conversationId = 'other-conversation';
  if (kind === 'stream') f.admission.streamId = 'other-stream';
  if (kind === 'binding') f.admission.bindingRef = 'other-binding';
  if (kind === 'response') f.admission.resultMessageId = 'other-message';
  if (kind === 'status') f.admission.status = 'reserved';
  if (kind === 'generation') f.admission.dueState = 'cancelled';
  if (kind === 'tenant') f.binding.tenantId = 'other-tenant';
  if (kind === 'binding-conversation') f.binding.conversationId = 'other-conversation';
  if (kind === 'active') f.binding.active = false;
  if (kind === 'canonical-text') f.message.text = 'Changed canonical reply.';
  if (kind === 'user-message') f.message.isCreatedByUser = true;
  if (kind === 'chat') f.row.telegramChatId = 'other-chat';
  if (kind === 'account') f.mapping.telegramUserId = 'other-account';
  expect(await f.verify(f.row)).toBe(false);
});

test('checks current conversation access and account existence', async () => {
  const f = fixture();
  f.deps.readOwner.mockResolvedValue(false);
  expect(await f.verify(f.row)).toBe(false);
  f.deps.readOwner.mockResolvedValue(true);
  f.deps.readConversation.mockResolvedValue({ endpoint: 'other-endpoint' });
  expect(await f.verify(f.row)).toBe(false);
});

test('eligible live Voice uses the same Main evidence and current owner/conversation', async () => {
  const f = fixture('voice');
  expect(await f.verify(f.row)).toBe(true);
  f.call.mode = 'listen_only';
  expect(await f.verify(f.row)).toBe(false);
  f.call.mode = 'call';
  f.call.status = 'ended';
  expect(await f.verify(f.row)).toBe(false);
  f.call.status = 'active';
  f.call.userId = 'other-owner';
  expect(await f.verify(f.row)).toBe(false);
});

test('new-conversation schedules retain their admitted destination conversation', async () => {
  const f = fixture();
  f.binding.conversationPolicy = 'new';
  f.binding.conversationId = 'original-conversation';
  expect(await f.verify(f.row)).toBe(true);
});

test('canonical file-only Main results can reach selected text channels', async () => {
  const f = fixture();
  f.message.text = '';
  f.message.attachments = [{ filename: 'result.txt' }];
  f.row.text = '';
  f.row.mainGenerationPresentation = buildMainGenerationPresentation(
    { streamId: f.admission.streamId, admissionId: f.admission._id },
    f.message.messageId,
    '',
  );
  expect(await f.verify(f.row)).toBe(true);
  f.message.attachments = [];
  expect(await f.verify(f.row)).toBe(false);
});

test.each(['explicit-source', 'legacy-new-conversation'])(
  'presentation rechecks distinct source access: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'explicit-source') f.binding.sourceConversationId = 'source-conversation';
    else {
      f.binding.conversationPolicy = 'new';
      f.binding.conversationId = 'source-conversation';
    }
    expect(await f.verify(f.row)).toBe(true);
    f.deps.readConversation.mockImplementation(async (_ownerId, conversationId) => ({
      endpoint: conversationId === 'source-conversation' ? 'revoked' : 'agents',
    }));
    expect(await f.verify(f.row)).toBe(false);
    expect(f.deps.readConversation).toHaveBeenCalledWith('owner-a', 'source-conversation');
  },
);

test('persisted web Main presentation requires its selected channel and exact current evidence', async () => {
  const f = fixture();
  f.row.surface = 'librechat';
  expect(await f.verify(f.row)).toBe(true);
  f.binding.destinations = [
    { surface: 'telegram', telegramChatId: 'chat-a', telegramUserId: 'tg-a' },
  ];
  expect(await f.verify(f.row)).toBe(false);
});

test('Telegram direct messages use the existing user-ID fallback when mapping has no chat ID', async () => {
  const f = fixture();
  f.mapping.telegramChatId = '';
  f.row.telegramChatId = 'tg-a';
  f.binding.destinations = [
    { surface: 'telegram', telegramChatId: 'tg-a', telegramUserId: 'tg-a' },
  ];
  expect(await f.verify(f.row)).toBe(true);
  f.row.telegramChatId = 'foreign-dm';
  expect(await f.verify(f.row)).toBe(false);
});

test.each(['wing', 'listen_only'])(
  'Main Voice authority stops when a selected call changes to %s mode',
  async (mode) => {
    const f = fixture('voice');
    expect(await f.verify(f.row)).toBe(true);
    f.call.mode = mode;
    expect(await f.verify(f.row)).toBe(false);
  },
);
