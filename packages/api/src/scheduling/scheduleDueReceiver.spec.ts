import { createHmac } from 'crypto';
import {
  createScheduleDueReceiver,
  ensureScheduledConversationBinding,
  verifyScheduleDueSignature,
  createScheduleDueDispatcher,
  scheduleDueDispatchIdentity,
  ScheduleDueError,
} from './scheduleDueReceiver';
import type {
  ScheduleDueEnvelope,
  ScheduleDueAdmission,
  ScheduleDueStore,
  ScheduledConversationBinding,
} from './scheduleDueReceiver';

const now = new Date('2030-01-01T12:00:00Z');
const secret = `whsec_${Buffer.alloc(32, 'k').toString('base64')}`;
const envelope = (patch: Partial<ScheduleDueEnvelope> = {}): ScheduleDueEnvelope => ({
  type: 'schedule.due',
  schedule_id: 'schedule-1',
  schedule_version: 1,
  occurrence_id: 'occurrence-1',
  scheduled_at: '2030-01-01T12:00:00Z',
  expires_at: '2030-01-01T12:15:00Z',
  principal: { tenant_id: 'test', owner_id: 'owner-1' },
  request_data: { request_ref: 'binding-1' },
  ...patch,
});
const raw = (body = envelope()) => Buffer.from(JSON.stringify(body));
const timestamp = String(Math.floor(now.getTime() / 1000));
const sign = (body = raw(), key = secret) =>
  `v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
    .update(`event-1.${timestamp}.`)
    .update(body)
    .digest('base64')}`;

function setup() {
  const binding: ScheduledConversationBinding = {
    _id: 'binding-1',
    kind: 'schedule_binding',
    ownerId: 'owner-1',
    tenantId: 'test',
    conversationId: 'conversation-1',
    taskText: 'Exact original task',
    destinations: [{ surface: 'librechat' }],
    sourceEventId: 'source-1',
    active: true,
    createdAt: now,
  };
  const admissions = new Map<string, ScheduleDueAdmission>();
  const bindings = new Map<string, ScheduledConversationBinding>([['binding-1', binding]]);
  const store: ScheduleDueStore = {
    readBinding: jest.fn(async (ref) => bindings.get(ref) || null),
    saveBinding: jest.fn(async (item) => {
      if (!bindings.has(item._id)) bindings.set(item._id, item);
      return bindings.get(item._id)!;
    }),
    readAdmission: jest.fn(async (ref) => admissions.get(ref) || null),
    insertAdmission: jest.fn(async (item) => {
      if (!admissions.has(item._id)) admissions.set(item._id, item);
      return admissions.get(item._id)!;
    }),
  };
  const authorizeBinding = jest.fn(async () => true);
  const receiver = createScheduleDueReceiver({
    store,
    tenantId: 'test',
    authorizeBinding,
    now: () => now,
  });
  return { binding, admissions, store, authorizeBinding, receiver };
}
function verify(body = raw(), signature = sign(body), at = now.getTime(), secrets = [secret]) {
  return verifyScheduleDueSignature({
    rawBody: body,
    eventId: 'event-1',
    timestamp,
    signature,
    secrets,
    nowMs: at,
  });
}

describe('signed scheduled Main admission', () => {
  test('original bytes and key rotation pass; tamper/replay/wrong keys/bounds fail', () => {
    expect(() => verify()).not.toThrow();
    expect(() => verify(Buffer.from(`${raw().toString()} `), sign())).toThrow('signature_invalid');
    expect(() => verify(raw(), sign(), now.getTime() + 301_000)).toThrow('signature_invalid');
    const other = `whsec_${Buffer.alloc(32, 'x').toString('base64')}`;
    expect(() => verify(raw(), sign(raw(), other))).toThrow('signature_invalid');
    expect(() => verify(raw(), sign(), now.getTime(), [other, secret])).not.toThrow();
    expect(() => verify(Buffer.alloc(65_537))).toThrow('body_too_large');
    expect(() => verify(raw(), sign(), now.getTime(), [])).toThrow('not_configured');
  });
  test('durably admits before any AI or presentation work', async () => {
    const { receiver, admissions } = setup();
    const result = await receiver.admit(raw(), 'event-1');
    expect(admissions.size).toBe(1);
    expect(result.admission).toMatchObject({
      status: 'reserved',
      dueState: 'admitted',
      conversationId: 'conversation-1',
    });
  });
  test('concurrent/lost ACK/restart recover one exact admission after expiry', async () => {
    const { receiver, admissions, store, authorizeBinding } = setup();
    await Promise.all(Array.from({ length: 8 }, () => receiver.admit(raw(), 'event-1')));
    const restarted = createScheduleDueReceiver({
      store,
      tenantId: 'test',
      authorizeBinding,
      now: () => new Date('2030-01-02T12:00:00Z'),
    });
    expect((await restarted.admit(raw(), 'event-1')).duplicate).toBe(true);
    expect(admissions.size).toBe(1);
  });
  test('same occurrence with different body or event conflicts', async () => {
    const { receiver } = setup();
    await receiver.admit(raw(), 'event-1');
    await expect(receiver.admit(raw(envelope({ schedule_version: 2 })), 'event-1')).rejects.toThrow(
      'identity_conflict',
    );
    await expect(receiver.admit(raw(), 'event-2')).rejects.toThrow('identity_conflict');
  });
  test('clock skew is retryable, then admits the same signed occurrence when due', async () => {
    const data = setup();
    const bytes = raw(envelope({ scheduled_at: '2030-01-01T12:00:06Z' }));
    await expect(data.receiver.admit(bytes, 'event-1')).rejects.toMatchObject({ status: 425 });
    expect(data.admissions.size).toBe(0);
    const later = createScheduleDueReceiver({
      store: data.store,
      tenantId: 'test',
      authorizeBinding: data.authorizeBinding,
      now: () => new Date(now.getTime() + 6000),
    });
    expect((await later.admit(bytes, 'event-1')).duplicate).toBe(false);
    expect(data.admissions.size).toBe(1);
  });
  test.each([
    ['expired', { expires_at: '2030-01-01T12:00:00Z' }],
    ['not_yet_due', { scheduled_at: '2030-01-01T12:05:00Z' }],
    ['owner_mismatch', { principal: { tenant_id: 'other', owner_id: 'owner-1' } }],
    ['binding_unavailable', { principal: { tenant_id: 'test', owner_id: 'other' } }],
    ['binding_unavailable', { request_data: { request_ref: 'missing' } }],
    ['body_invalid', { schedule_version: 0 }],
  ] as Array<[string, Partial<ScheduleDueEnvelope>]>)(
    'rejects %s before admission',
    async (code, patch) => {
      const { receiver, admissions } = setup();
      await expect(receiver.admit(raw(envelope(patch)), 'event-1')).rejects.toThrow(code);
      expect(admissions.size).toBe(0);
    },
  );
  test('signed nested request data cannot grant task, role or channel', async () => {
    const { receiver } = setup();
    const bytes = Buffer.from(
      JSON.stringify({ ...envelope(), request_data: { request_ref: 'binding-1', role: 'admin' } }),
    );
    await expect(receiver.admit(bytes, 'event-1')).rejects.toThrow('body_invalid');
  });
  test('revocation rejects new admissions; retained receipts still recover', async () => {
    const { receiver, binding, authorizeBinding } = setup();
    await receiver.admit(raw(), 'event-1');
    binding.active = false;
    authorizeBinding.mockResolvedValue(false);
    expect((await receiver.admit(raw(), 'event-1')).duplicate).toBe(true);
    await expect(
      receiver.admit(raw(envelope({ occurrence_id: 'other' })), 'event-2'),
    ).rejects.toThrow('binding_unavailable');
  });
  test('binding retry preserves exact text and does not reactivate revoked binding', async () => {
    const { store } = setup();
    const input = {
      store,
      ownerId: 'owner-1',
      tenantId: 'test',
      conversationId: 'conversation-1',
      taskText: 'Exact original task',
      sourceEventId: 'source-1',
      destinations: [{ surface: 'librechat' as const }],
    };
    const first = await ensureScheduledConversationBinding(input);
    first.active = false;
    const second = await ensureScheduledConversationBinding({
      ...input,
      taskText: 'different task',
    });
    expect(second).toBe(first);
    expect(second.active).toBe(false);
    expect(second.taskText).toBe('Exact original task');
    await expect(
      ensureScheduledConversationBinding({ ...input, conversationId: 'new' }),
    ).rejects.toThrow('binding_invalid');
  });
});

describe('normal Main dispatch and result reuse', () => {
  async function dispatchSetup() {
    const data = setup();
    const admission = (await data.receiver.admit(raw(), 'event-1')).admission;
    let available = true;
    const dispatch = jest.fn(async () => ({
      streamId: admission.streamId,
      conversationId: admission.conversationId,
    }));
    const readResult = jest.fn<
      Promise<{ state: 'complete' | 'pending' | 'unknown' | 'failed'; messageId?: string }>,
      [ScheduleDueAdmission]
    >(async () => ({ state: 'complete', messageId: 'response-1' }));
    const present = jest.fn(async () => ({ silent: false }));
    const update = jest.fn(
      async (_item: ScheduleDueAdmission, patch: Partial<ScheduleDueAdmission>) => {
        Object.assign(admission, patch);
      },
    );
    const release = jest.fn(async () => undefined);
    const dispatcher = createScheduleDueDispatcher({
      claim: async () => {
        if (!available) return null;
        available = false;
        return admission;
      },
      readBinding: data.store.readBinding,
      authorizeBinding: data.authorizeBinding,
      dispatch,
      readResult,
      present,
      update,
      release,
    });
    return {
      ...data,
      admission,
      dispatch,
      readResult,
      present,
      update,
      release,
      dispatcher,
      allowClaim: () => {
        available = true;
      },
    };
  }
  test('dispatches once and presents exact committed Main result', async () => {
    const data = await dispatchSetup();
    await data.dispatcher.reconcile();
    expect(data.dispatch).toHaveBeenCalledTimes(1);
    expect(data.present).toHaveBeenCalledWith(data.admission, data.binding, 'response-1');
    expect(data.admission.dueState).toBe('delivery_queued');
    expect(data.release).toHaveBeenCalledTimes(1);
  });
  test('permanently unavailable original source settles failed before starting Main', async () => {
    const data = await dispatchSetup();
    data.dispatch.mockRejectedValueOnce(
      new ScheduleDueError('schedule_task_source_unavailable', 409),
    );
    await expect(data.dispatcher.reconcile()).rejects.toThrow('schedule_task_source_unavailable');
    expect(data.admission).toMatchObject({
      status: 'reserved',
      dueState: 'failed',
      failureCode: 'schedule_task_source_unavailable',
    });
    expect(data.readResult).not.toHaveBeenCalled();
    expect(data.present).not.toHaveBeenCalled();
    expect(data.release).toHaveBeenCalledTimes(1);
  });
  test('transient source availability failure remains recoverable', async () => {
    const data = await dispatchSetup();
    data.dispatch.mockRejectedValueOnce(
      new ScheduleDueError('schedule_task_source_unavailable', 503),
    );
    await expect(data.dispatcher.reconcile()).rejects.toThrow('schedule_task_source_unavailable');
    expect(data.admission).toMatchObject({ status: 'reserved', dueState: 'admitted' });
    expect(data.admission.failureCode).toBeUndefined();
    data.allowClaim();
    await data.dispatcher.reconcile();
    expect(data.admission.dueState).toBe('delivery_queued');
    expect(data.present).toHaveBeenCalledTimes(1);
  });
  test('channel failure retries only presentation, preserving already accepted work', async () => {
    const data = await dispatchSetup();
    data.present.mockRejectedValueOnce(new Error('delivery unavailable'));
    await expect(data.dispatcher.reconcile()).rejects.toThrow('delivery unavailable');
    data.allowClaim();
    await data.dispatcher.reconcile();
    expect(data.dispatch).toHaveBeenCalledTimes(1);
    expect(data.present).toHaveBeenCalledTimes(2);
  });
  test('revocation before dispatch cancels without starting model', async () => {
    const data = await dispatchSetup();
    data.authorizeBinding.mockResolvedValue(false);
    await data.dispatcher.reconcile();
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.admission.dueState).toBe('cancelled');
  });
  test('deleted binding retains the accepted receipt without starting or restoring Main', async () => {
    const data = await dispatchSetup();
    data.admission.status = 'accepted';
    const identity = data.admission._id;
    jest.mocked(data.store.readBinding).mockResolvedValue(null);
    await data.dispatcher.reconcile();
    expect(data.admission._id).toBe(identity);
    expect(data.admission.status).toBe('accepted');
    expect(data.admission.dueState).toBe('cancelled');
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.readResult).not.toHaveBeenCalled();
    expect(data.present).not.toHaveBeenCalled();
  });
  test('missing accepted stream is unknown, never a new tool replay', async () => {
    const data = await dispatchSetup();
    data.admission.status = 'accepted';
    data.readResult.mockResolvedValue({ state: 'unknown' });
    await data.dispatcher.reconcile();
    expect(data.dispatch).not.toHaveBeenCalled();
    expect(data.admission.dueState).toBe('unknown');
    expect(data.present).not.toHaveBeenCalled();
  });
  test('stable identity uses existing scheduler stream shape', () => {
    expect(scheduleDueDispatchIdentity(envelope())).toMatchObject({
      idempotencyKey: expect.stringMatching(/^xperfect-due:[a-f0-9]{64}$/),
      streamId: expect.stringMatching(/^scheduler-[a-f0-9]{32}$/),
    });
  });
});
