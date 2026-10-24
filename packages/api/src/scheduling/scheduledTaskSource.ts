/* === VIVENTIUM START === Scheduled work retains references to its original owner history. === */
import { createHash } from 'crypto';
import { ScheduleDueError } from './scheduleDueReceiver';
import type { ScheduledConversationBinding } from './scheduleDueReceiver';

export interface ScheduledTaskSource {
  messageIds: string[];
  sha256: string;
}

export interface ScheduledTaskSourceSegment {
  text?: string;
  source_event_id?: string;
  source_message_id?: string;
  truncated?: boolean;
  original_sha256?: string;
}

export interface ScheduledTaskSourceInput {
  ownerId: string;
  conversationId: string;
  sourceEventId: string;
  taskText: string;
  sources?: readonly ScheduledTaskSourceSegment[];
}

export interface ScheduledSourceMessage {
  messageId: string;
  parentMessageId?: string;
  user: string;
  conversationId: string;
  isCreatedByUser: boolean;
  text?: string;
  metadata?: { viventium?: { interactionContext?: { source_event_id?: string } } };
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const identifier = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 200;
const unavailable = () => new ScheduleDueError('schedule_task_source_unavailable', 409);

function ownerMessages(
  ownerId: string,
  conversationId: string,
  messages: readonly ScheduledSourceMessage[],
) {
  return messages.filter(
    (message) => message.user === ownerId && message.conversationId === conversationId,
  );
}

export function prepareScheduledTaskSource(
  input: ScheduledTaskSourceInput,
  messages: readonly ScheduledSourceMessage[],
): ScheduledTaskSource {
  const scoped = ownerMessages(input.ownerId, input.conversationId, messages);
  const byId = new Map(scoped.map((message) => [message.messageId, message]));
  const segments = input.sources?.length
    ? input.sources
    : [{ source_event_id: input.sourceEventId, text: input.taskText }];
  const selected = new Map<
    string,
    { message: ScheduledSourceMessage; parts: ScheduledTaskSourceSegment[] }
  >();
  if (segments.length > 32) throw unavailable();
  for (const segment of segments) {
    const sourceId = segment.source_event_id || input.sourceEventId;
    let message = segment.source_message_id ? byId.get(segment.source_message_id) : undefined;
    if (!segment.source_message_id) {
      const originals = scoped.filter(
        (candidate) =>
          candidate.isCreatedByUser &&
          (candidate.messageId === sourceId ||
            candidate.metadata?.viventium?.interactionContext?.source_event_id === sourceId),
      );
      if (originals.length === 1) message = originals[0];
      if (!originals.length) {
        const response = byId.get(sourceId);
        if (response?.isCreatedByUser === false && response.parentMessageId)
          message = byId.get(response.parentMessageId);
      }
    }
    if (
      !message?.isCreatedByUser ||
      typeof message.text !== 'string' ||
      !identifier(message.messageId)
    )
      throw unavailable();
    const group = selected.get(message.messageId) || { message, parts: [] };
    group.parts.push(segment);
    selected.set(message.messageId, group);
  }
  const texts: string[] = [];
  for (const { message, parts } of selected.values()) {
    const text = message.text!;
    const truncated = parts.filter((part) => part.truncated);
    if (truncated.length) {
      if (
        parts.length !== 1 ||
        !/^[a-f0-9]{64}$/.test(truncated[0].original_sha256 || '') ||
        digest(text) !== truncated[0].original_sha256
      )
        throw unavailable();
    } else if (parts.map((part) => part.text || '').join('\n\n') !== text) {
      throw unavailable();
    }
    texts.push(text);
  }
  if (!texts.length || !texts.some((text) => text.trim())) throw unavailable();
  return { messageIds: [...selected.keys()], sha256: digest(texts.join('\n\n')) };
}

export function readScheduledBindingTaskText(
  binding: ScheduledConversationBinding,
  messages: readonly ScheduledSourceMessage[],
): string {
  if (!binding.taskSource) {
    if (typeof binding.taskText === 'string' && binding.taskText.trim()) return binding.taskText;
    throw unavailable();
  }
  const source = binding.taskSource;
  if (
    !Array.isArray(source.messageIds) ||
    source.messageIds.length < 1 ||
    source.messageIds.length > 32 ||
    !source.messageIds.every(identifier) ||
    new Set(source.messageIds).size !== source.messageIds.length ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw unavailable();
  const byId = new Map(
    ownerMessages(binding.ownerId, binding.sourceConversationId || binding.conversationId, messages)
      .filter((message) => message.isCreatedByUser)
      .map((message) => [message.messageId, message]),
  );
  const texts = source.messageIds.map((id) => {
    const message = byId.get(id);
    if (!message || typeof message.text !== 'string') throw unavailable();
    return message.text;
  });
  const text = texts.join('\n\n');
  if (digest(text) !== source.sha256) throw unavailable();
  return text;
}

export function scheduledConversationBindingDeletionFilter(
  ownerId: string,
  conversationIds: string[],
) {
  return {
    kind: 'schedule_binding',
    ownerId,
    $or: [
      { sourceConversationId: { $in: conversationIds } },
      { conversationId: { $in: conversationIds } },
    ],
  };
}
/* === VIVENTIUM END === */
