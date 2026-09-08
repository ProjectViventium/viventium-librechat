import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  getMessageBranchChoices,
  filterNoResponseMessagesTree,
  filterTrustedInternalMessagesTree,
  selectVisibleMessageBranches,
} from './noResponseTag';

function mkMessage({
  messageId,
  parentMessageId,
  text,
  isCreatedByUser,
  children,
}: {
  messageId: string;
  parentMessageId: string;
  text: string;
  isCreatedByUser: boolean;
  children?: TMessage[];
}): TMessage {
  return {
    messageId,
    parentMessageId,
    conversationId: 'convo-1',
    sender: isCreatedByUser ? 'User' : 'Viventium',
    text,
    isCreatedByUser,
    children: children ?? [],
  } as TMessage;
}

describe('filterNoResponseMessagesTree', () => {
  test('hides no-response assistant messages by default', () => {
    const root = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Normal user message',
      isCreatedByUser: true,
      children: [
        mkMessage({
          messageId: 'a1',
          parentMessageId: 'u1',
          text: '{NTA}',
          isCreatedByUser: false,
        }),
      ],
    });

    const filtered = filterNoResponseMessagesTree([root]);
    expect(filtered?.[0]?.children?.length).toBe(0);
  });

  test('keeps a minimal placeholder for no-response after scheduled brew prompts in chat mode', () => {
    const brewPrompt = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: '<!--viv_internal:brew_begin-->\n## Background Processing (Brewing)\nStrattera monitoring...',
      isCreatedByUser: true,
      children: [
        {
          ...mkMessage({
            messageId: 'a1',
            parentMessageId: 'u1',
            text: '',
            isCreatedByUser: false,
          }),
          content: [{ type: ContentTypes.TEXT, text: '{NTA}' }],
        } as TMessage,
      ],
    });

    const filtered = filterNoResponseMessagesTree([brewPrompt], {
      brewNoResponsePlaceholder: '-',
    });

    expect(filtered?.[0]?.children?.length).toBe(1);
    expect(filtered?.[0]?.children?.[0]?.text).toBe('-');
    expect(filtered?.[0]?.children?.[0]?.content?.[0]?.type).toBe(ContentTypes.TEXT);
    expect((filtered?.[0]?.children?.[0]?.content?.[0] as { text?: string })?.text).toBe('-');
  });

  test('does not show placeholder for non-brew no-response messages even when option is enabled', () => {
    const root = mkMessage({
      messageId: 'u1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'hi',
      isCreatedByUser: true,
      children: [
        mkMessage({
          messageId: 'a1',
          parentMessageId: 'u1',
          text: '{NTA}',
          isCreatedByUser: false,
        }),
      ],
    });

    const filtered = filterNoResponseMessagesTree([root], {
      brewNoResponsePlaceholder: '-',
    });

    expect(filtered?.[0]?.children?.length).toBe(0);
  });
});

describe('filterTrustedInternalMessagesTree', () => {
  test('uses trusted visibility metadata and does not hide a user-authored literal tag', () => {
    const literal = {
      ...mkMessage({
        messageId: 'u1',
        parentMessageId: 'root',
        text: '{NTA}',
        isCreatedByUser: true,
      }),
      metadata: { viventium: { interactionContext: { origin: 'interactive' } } },
    } as TMessage;
    const internal = {
      ...mkMessage({
        messageId: 's1',
        parentMessageId: 'root',
        text: '{NTA}',
        isCreatedByUser: false,
      }),
      metadata: { viventium: { visibility: 'internal' } },
    } as TMessage;

    expect(filterTrustedInternalMessagesTree([literal, internal])).toEqual([literal]);
  });
});

describe('scheduled result branch visibility', () => {
  const row = (id: string, user = false, children: TMessage[] = []): TMessage =>
    mkMessage({
      messageId: id,
      parentMessageId: 'anchor',
      text: id,
      isCreatedByUser: user,
      children,
    });
  const scheduled = (id: string, children: TMessage[]): TMessage => ({
    ...row(id, true, children),
    metadata: {
      viventium: {
        visibility: 'internal',
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          conversation_id: 'convo-1',
        },
      },
    },
  });

  test('keeps the trusted system grouping key while hiding ordinary internal rows', () => {
    const system = scheduled('schedule', [row('briefing')]);
    expect(filterTrustedInternalMessagesTree([system])).toEqual([system]);
  });

  test('keeps a completed briefing beside a later selected question without changing stored parents', () => {
    const hiddenUser = row('earlier-user', true, [row('earlier-answer')]);
    const briefing = row('briefing', false, [hiddenUser]);
    const system = scheduled('schedule', [briefing]);
    const question = row('question', true, [row('answer')]);
    const tree = [system, question];
    const original = JSON.stringify(tree);
    const visible = selectVisibleMessageBranches(tree, question.messageId);
    expect(visible.map((m) => m.messageId)).toEqual(['schedule', 'question']);
    expect(visible[0].children?.[0]).toEqual({ ...briefing, children: [] });
    expect(visible[1]).toBe(question);
    expect(JSON.stringify(tree)).toBe(original);
  });

  test('preserves selected scheduled continuations and response regeneration choices', () => {
    const system = scheduled('schedule', [
      row('first-answer', false, [row('first-followup', true)]),
      row('regenerated-answer', false, [row('second-followup', true)]),
    ]);
    const question = row('question', true);
    expect(selectVisibleMessageBranches([system, question], system.messageId)).toEqual([system]);
    const visible = selectVisibleMessageBranches([system, question], question.messageId);
    expect(visible[0].messageId).toBe('schedule');
    expect(visible[0].children?.map((m) => [m.messageId, m.children])).toEqual([
      ['first-answer', []],
      ['regenerated-answer', []],
    ]);
  });

  test('does not reveal schedules inside an unselected ordinary user branch', () => {
    const oldBranch = row('old-user', true, [scheduled('old-schedule', [row('old-result')])]);
    const current = row('current-user', true);
    expect(selectVisibleMessageBranches([oldBranch, current], current.messageId)).toEqual([
      current,
    ]);
  });

  test('does not treat literal text or mismatched conversation metadata as autonomous authority', () => {
    const literal = row('literal', true, [row('literal-answer')]);
    literal.text = '<!--viv_internal:brew_begin--> Background Processing (Brewing)';
    const mismatched = scheduled('wrong-conversation', [row('wrong-answer')]);
    mismatched.conversationId = 'other-conversation';
    const current = row('current', true);
    expect(selectVisibleMessageBranches([literal, mismatched, current], current.messageId)).toEqual(
      [current],
    );
  });

  test('a later scheduled answer does not replace the selected ordinary conversation', () => {
    const current = row('current', true, [row('current-answer')]);
    const system = scheduled('later-schedule', [row('later-result')]);
    expect(getMessageBranchChoices([current, system])).toEqual([current]);
    expect(selectVisibleMessageBranches([current, system], current.messageId)).toEqual([
      current,
      system,
    ]);
  });

  test('includes each adjacent scheduled group once without selecting all ordinary alternatives', () => {
    const first = scheduled('first', [row('first-result')]);
    const second = scheduled('second', [row('second-result')]);
    const old = row('old', true);
    const current = row('current', true);
    expect(
      selectVisibleMessageBranches([first, old, second, current], current.messageId).map(
        (m) => m.messageId,
      ),
    ).toEqual(['first', 'second', 'current']);
  });
});

test('shared/imported conversation IDs use the actual message scope, not old diagnostic IDs', () => {
  const system = {
    messageId: 'shared-system',
    parentMessageId: 'shared-anchor',
    conversationId: 'shared-conversation',
    isCreatedByUser: true,
    text: 'private envelope',
    children: [
      {
        messageId: 'shared-answer',
        parentMessageId: 'shared-system',
        conversationId: 'shared-conversation',
        isCreatedByUser: false,
        text: 'Briefing',
      },
    ],
    metadata: {
      viventium: {
        visibility: 'internal',
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          conversation_id: 'original-conversation',
        },
      },
    },
  } as TMessage;
  const current = {
    messageId: 'shared-question',
    parentMessageId: 'shared-anchor',
    conversationId: 'shared-conversation',
    isCreatedByUser: true,
    text: 'Question',
  } as TMessage;
  expect(filterTrustedInternalMessagesTree([system, current])).toEqual([system, current]);
  expect(
    selectVisibleMessageBranches([system, current], current.messageId).map((m) => m.messageId),
  ).toEqual(['shared-system', 'shared-question']);
});

/* === VIVENTIUM START === Worker results use the same additive projection as schedules. === */
describe('late native result visibility', () => {
  const row = (id: string, user = false, children: TMessage[] = []): TMessage =>
    mkMessage({ messageId: id, parentMessageId: 'anchor', text: id, isCreatedByUser: user, children });
  const event = (id: string, type: string, children: TMessage[] = []): TMessage => ({
    ...row(id, false, children), metadata: { viventium: { type } },
  });

  test('keeps the callback and useful result beside an overlapping human turn without rewriting parents', () => {
    const result = event('useful-result', 'cortex_followup');
    result.parentMessageId = 'callback';
    const callback = event('callback', 'glasshive_worker_callback', [result]);
    const question = row('current-question', true, [row('current-answer')]);
    const tree = [callback, question];
    const original = JSON.stringify(tree);
    expect(getMessageBranchChoices(tree)).toEqual([question]);
    expect(selectVisibleMessageBranches(tree, question.messageId)).toEqual(tree);
    expect(JSON.stringify(tree)).toBe(original);
  });

  test('shows independent results once while preserving ordinary alternatives and selected continuations', () => {
    const result = event('result', 'cortex_followup', [row('earlier-question', true)]);
    const second = event('second-result', 'cortex_followup');
    const current = row('current', true);
    const tree = [result, current, second];
    expect(getMessageBranchChoices(tree)).toEqual([result, current]);
    expect(selectVisibleMessageBranches(tree, current.messageId)).toEqual([
      { ...result, children: [] }, current, second,
    ]);
    expect(selectVisibleMessageBranches(tree, result.messageId)).toEqual([result, second]);
  });

  test('a follow-up promoted into the canonical Main response remains an ordinary regeneration choice', () => {
    const promoted = event('promoted-answer', 'cortex_followup');
    promoted.metadata = { viventium: { type: 'cortex_followup', replacedParentMessage: true } };
    const regenerated = row('regenerated-answer');
    expect(getMessageBranchChoices([promoted, regenerated])).toEqual([promoted, regenerated]);
    expect(selectVisibleMessageBranches([promoted, regenerated], regenerated.messageId)).toEqual([regenerated]);
    expect(selectVisibleMessageBranches([promoted, regenerated], promoted.messageId)).toEqual([promoted]);
  });

  test('does not expose a foreign result, user-authored type, unknown type or result inside an unselected human branch', () => {
    const foreign = event('foreign', 'cortex_followup');
    foreign.conversationId = 'other-conversation';
    const user = { ...event('user', 'cortex_followup'), isCreatedByUser: true };
    const unknown = event('unknown', 'other_type');
    const old = row('old', true, [event('hidden-result', 'cortex_followup')]);
    const current = row('current', true);
    expect(selectVisibleMessageBranches([foreign, user, unknown, old, current], current.messageId))
      .toEqual([current]);
  });
});
/* === VIVENTIUM END === */
