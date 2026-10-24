import { createHash } from 'crypto';
import {
  prepareScheduledTaskSource,
  readScheduledBindingTaskText,
  scheduledConversationBindingDeletionFilter,
} from './scheduledTaskSource';
import { ensureScheduledConversationBinding } from './scheduleDueReceiver';
import type { ScheduledSourceMessage } from './scheduledTaskSource';
import type { ScheduledConversationBinding, ScheduleDueStore } from './scheduleDueReceiver';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const storeFor = (saveBinding: ScheduleDueStore['saveBinding']): ScheduleDueStore => ({
  saveBinding,
  readBinding: async () => null,
  readAdmission: async () => null,
  insertAdmission: async (admission) => admission,
});

const original = (id: string, text: string): ScheduledSourceMessage => ({
  messageId: id,
  user: 'owner',
  conversationId: 'source',
  isCreatedByUser: true,
  text,
  metadata: { viventium: { interactionContext: { source_event_id: `event-${id}` } } },
});
function binding(taskSource?: {
  messageIds: string[];
  sha256: string;
}): ScheduledConversationBinding {
  return {
    _id: 'binding',
    kind: 'schedule_binding',
    ownerId: 'owner',
    tenantId: 'tenant',
    conversationId: 'destination',
    sourceConversationId: 'source',
    sourceEventId: 'event-a',
    active: true,
    createdAt: new Date(),
    destinations: [{ surface: 'librechat' }],
    ...(taskSource ? { taskSource } : { taskText: 'Legacy original' }),
  };
}

test('ordered A/B/C originals keep exact text and reference-only persistence', async () => {
  const messages = [original('c', 'C'), original('a', ' A\n'), original('b', 'B')];
  const text = ' A\n\n\nB\n\nC';
  const source = prepareScheduledTaskSource(
    {
      ownerId: 'owner',
      conversationId: 'source',
      sourceEventId: 'event-a',
      taskText: text,
      sources: ['a', 'b', 'c'].map((id) => ({
        source_message_id: id,
        text: messages.find((m) => m.messageId === id)!.text,
      })),
    },
    messages,
  );
  expect(source).toEqual({ messageIds: ['a', 'b', 'c'], sha256: sha(text) });
  expect(readScheduledBindingTaskText(binding(source), messages)).toBe(text);
  const saveBinding = jest.fn(async (value: ScheduledConversationBinding) => value);
  const saved = await ensureScheduledConversationBinding({
    store: storeFor(saveBinding),
    tenantId: 'tenant',
    ownerId: 'owner',
    conversationId: 'destination',
    sourceConversationId: 'source',
    sourceEventId: 'event-a',
    taskText: text,
    taskSource: source,
    destinations: [{ surface: 'librechat' }],
  });
  expect(saved.taskText).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain(' A\\n');
  expect(saved.taskSource).toEqual(source);
});

test('exact response-parent compatibility canonicalizes the same source identity', async () => {
  const message = original('a', 'Exact task');
  const response = {
    ...original('response', 'Main reply'),
    isCreatedByUser: false,
    parentMessageId: 'a',
  };
  const input = { ownerId: 'owner', conversationId: 'source', taskText: 'Exact task' };
  const byEvent = prepareScheduledTaskSource({ ...input, sourceEventId: 'event-a' }, [
    message,
    response,
  ]);
  const byResponse = prepareScheduledTaskSource({ ...input, sourceEventId: 'response' }, [
    message,
    response,
  ]);
  expect(byResponse).toEqual(byEvent);
  const saveBinding = jest.fn(async (value: ScheduledConversationBinding) => value);
  const common = {
    store: storeFor(saveBinding),
    tenantId: 'tenant',
    ownerId: 'owner',
    conversationId: 'source',
    taskText: input.taskText,
    taskSource: byEvent,
    destinations: [{ surface: 'librechat' as const }],
  };
  const one = await ensureScheduledConversationBinding({ ...common, sourceEventId: 'event-a' });
  const two = await ensureScheduledConversationBinding({ ...common, sourceEventId: 'response' });
  expect(two._id).toBe(one._id);
  expect(() =>
    prepareScheduledTaskSource({ ...input, sourceEventId: 'response', taskText: 'Other task' }, [
      message,
      response,
    ]),
  ).toThrow('schedule_task_source_unavailable');
});

test('clipped source verifies full original hash and preserves long text without a new copy', async () => {
  const text = 'Full original '.repeat(12_000);
  const message = original('large', text);
  const source = prepareScheduledTaskSource(
    {
      ownerId: 'owner',
      conversationId: 'source',
      sourceEventId: 'event-large',
      taskText: text.slice(0, 32000),
      sources: [
        {
          source_message_id: 'large',
          text: text.slice(0, 32000),
          truncated: true,
          original_sha256: sha(text),
        },
      ],
    },
    [message],
  );
  expect(readScheduledBindingTaskText(binding(source), [message])).toBe(text);
  const saveBinding = jest.fn(async (value: ScheduledConversationBinding) => value);
  expect(
    (
      await ensureScheduledConversationBinding({
        store: storeFor(saveBinding),
        tenantId: 'tenant',
        ownerId: 'owner',
        conversationId: 'source',
        taskText: text,
        taskSource: source,
        sourceEventId: 'event-large',
        destinations: [{ surface: 'librechat' }],
      })
    ).taskText,
  ).toBeUndefined();
  expect(() =>
    prepareScheduledTaskSource(
      {
        ownerId: 'owner',
        conversationId: 'source',
        sourceEventId: 'event-large',
        taskText: text.slice(0, 32000),
        sources: [
          {
            source_message_id: 'large',
            text: text.slice(0, 32000),
            truncated: true,
            original_sha256: sha(text.slice(0, 32000)),
          },
        ],
      },
      [message],
    ),
  ).toThrow('schedule_task_source_unavailable');
});

test.each(['foreign', 'deleted', 'mutated', 'assistant'])(
  '%s original cannot be restored from a reference',
  (kind) => {
    const message = original('a', 'Original');
    const source = prepareScheduledTaskSource(
      {
        ownerId: 'owner',
        conversationId: 'source',
        sourceEventId: 'event-a',
        taskText: 'Original',
      },
      [message],
    );
    if (kind === 'foreign') message.user = 'other-owner';
    if (kind === 'mutated') message.text = 'Changed';
    if (kind === 'assistant') message.isCreatedByUser = false;
    expect(() =>
      readScheduledBindingTaskText(binding(source), kind === 'deleted' ? [] : [message]),
    ).toThrow('schedule_task_source_unavailable');
  },
);

test('legacy task text stays byte-exact and cleanup is owner/source/destination scoped', () => {
  expect(readScheduledBindingTaskText(binding(), [])).toBe('Legacy original');
  expect(scheduledConversationBindingDeletionFilter('owner', ['source'])).toEqual({
    kind: 'schedule_binding',
    ownerId: 'owner',
    $or: [{ sourceConversationId: { $in: ['source'] } }, { conversationId: { $in: ['source'] } }],
  });
});
