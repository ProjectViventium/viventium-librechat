/* VIVENTIUM START: bounded input retention in the existing logical-turn owner. */
import { normalizeInteractionSourceSegments } from '../../glasshive/interactionSourceSegments';
import type { InteractionContext } from '../interfaces/IJobStore';

function sourceInputCapacityError() {
  const message = 'This turn has too much pending input. Please retry after it settles.';
  return Object.assign(new Error(message), { code: 'source_input_capacity', status: 503,
    statusCode: 503, retryable: true,
    body: { code: 'source_input_capacity', retryable: true, error: message },
  });
}

export function retainLogicalTurnInput(
  pending: readonly InteractionContext[], incoming: InteractionContext,
): InteractionContext[] {
  return [mergeLogicalTurnInput(pending, incoming)];
}

export function mergeLogicalTurnInput(
  contexts: readonly InteractionContext[], incoming: InteractionContext,
): InteractionContext {
  const segments = new Map<string, NonNullable<InteractionContext['source_segments']>[number]>();
  let overflow = 0;
  const unresolved = incoming.actor_kind === 'external_user' && incoming.origin === 'interactive' ? contexts : [];
  for (const context of [...unresolved, incoming]) {
    if (context.actor_kind !== incoming.actor_kind || context.origin !== incoming.origin ||
      context.conversation_id !== incoming.conversation_id || context.source_order_scope !== incoming.source_order_scope) continue;
    overflow = Math.max(overflow, context.source_segments_overflow_count ?? 0);
    if (overflow) throw sourceInputCapacityError();
    for (const segment of context.source_segments ?? []) {
      const key = JSON.stringify([segment.source_event_id, segment.source_index]);
      const original = segments.get(key);
      segments.set(key, original ? { ...original,
        ...(!original.source_persisted ? {
          ...(segment.source_parent_message_id ? { source_parent_message_id: segment.source_parent_message_id } : {}),
        } : {}),
        ...(segment.source_files ? { source_files: segment.source_files } : {}),
        ...(segment.source_persisted === true ? { source_persisted: true as const } : {}),
        ...(!original.reply_context && segment.reply_context ? { reply_context: segment.reply_context } : {}),
      } : segment);
    }
  }
  const normalized = normalizeInteractionSourceSegments([...segments.values()].sort((left, right) =>
    left.source_sequence != null && right.source_sequence != null
      ? left.source_sequence - right.source_sequence || left.source_index - right.source_index : 0), overflow);
  if (normalized.overflowCount || normalized.segments.length < segments.size) {
    throw sourceInputCapacityError();
  }
  return { ...incoming,
    ...(normalized.segments.length ? { source_segments: normalized.segments } : {}),
    ...(normalized.overflowCount ? { source_segments_overflow_count: normalized.overflowCount } : {}),
  };
}

/** The earlier revisions whose commits decide who authors this context's sources. */
export function earlierAuthoringRevisions(context: InteractionContext): number[] {
  const marks = (context.source_segments ?? []).flatMap((segment) => {
    const mark = segment.authoring_revision;
    return mark != null && Number.isSafeInteger(mark) && mark < context.revision ? [mark] : [];
  });
  if (!marks.length) return [];
  const first = Math.min(...marks);
  return Array.from({ length: context.revision - first }, (_unused, index) => first + index);
}

/**
 * A claim only reserves a revision, so a source's claim mark is provisional. When this revision's
 * admission commits, the source's author is the earliest committed revision that carried it, else
 * this revision. Unmarked (legacy) sources keep their earlier meaning.
 */
export function commitSourceAuthors(
  context: InteractionContext,
  committed: (revision: number) => boolean,
): InteractionContext {
  if (!context.source_segments?.length) return context;
  return {
    ...context,
    source_segments: context.source_segments.map((segment) => {
      const claimed = segment.authoring_revision;
      if (claimed == null || !Number.isSafeInteger(claimed)) return segment;
      let author = context.revision;
      for (let revision = claimed; revision < context.revision; revision += 1) {
        if (committed(revision)) {
          author = revision;
          break;
        }
      }
      return { ...segment, authoring_revision: author };
    }),
  };
}
/* VIVENTIUM END */
