/* === VIVENTIUM START === Scheduled results remain present in selected-branch exports. === */
import { renderHook } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import useBuildMessageTree from './useBuildMessageTree';
import { filterTrustedInternalMessagesTree } from '~/utils/noResponseTag';

const mockSelection = new Map<string, number>();
jest.mock('recoil', () => ({
  useRecoilCallback: (
    factory: (arg: { snapshot: { getPromise: (key: string) => Promise<number> } }) => object,
  ) => factory({ snapshot: { getPromise: async (key: string) => mockSelection.get(key) ?? 0 } }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { messagesSiblingIdxFamily: (key: string) => key },
}));

const row = (id: string, user = false, children: TMessage[] = []): TMessage => ({
  messageId: id,
  parentMessageId: 'anchor',
  conversationId: 'conversation',
  text: id,
  isCreatedByUser: user,
  children,
});
const first = row('first-result', false, [row('old-question', true, [row('old-answer')])]);
const second = row('second-result');
const scheduled: TMessage = {
  ...row('hidden-schedule', true, [first, second]),
  metadata: {
    viventium: {
      visibility: 'internal',
      interactionContext: {
        actor_kind: 'system',
        origin: 'scheduler',
        conversation_id: 'conversation',
      },
    },
  },
};
const current = row('new-question', true, [row('new-answer')]);
const tree = filterTrustedInternalMessagesTree([scheduled, current]);

beforeEach(() => mockSelection.clear());

test('exports the displayed briefing and current answer without system prompt or unselected descendants', async () => {
  mockSelection.set('hidden-schedule', 1);
  const { result } = renderHook(() => useBuildMessageTree());
  const exported = await result.current({ messageId: 'anchor', message: null, messages: tree });
  expect(Array.isArray(exported) && exported.map((m) => m?.messageId)).toEqual([
    'first-result',
    'new-question',
    'new-answer',
  ]);
});

test('keeps an explicitly selected earlier branch and its response regeneration', async () => {
  mockSelection.set('anchor', 1);
  mockSelection.set('hidden-schedule', 1);
  const { result } = renderHook(() => useBuildMessageTree());
  const exported = await result.current({ messageId: 'anchor', message: null, messages: tree });
  expect(Array.isArray(exported) && exported.map((m) => m?.messageId)).toEqual([
    'first-result',
    'old-question',
    'old-answer',
  ]);
});

test('all-branch export keeps each original public branch once', async () => {
  const { result } = renderHook(() => useBuildMessageTree());
  const exported = await result.current({
    messageId: 'anchor',
    message: null,
    messages: tree,
    branches: true,
  });
  expect(Array.isArray(exported) && exported.map((m) => m?.messageId)).toEqual([
    'first-result',
    'old-question',
    'old-answer',
    'second-result',
    'new-question',
    'new-answer',
  ]);
});

test('recursive export keeps scheduled results and normal child structure', async () => {
  const { result } = renderHook(() => useBuildMessageTree());
  const exported = await result.current({
    messageId: 'anchor',
    message: null,
    messages: tree,
    recursive: true,
  });
  expect(
    Array.isArray(exported) &&
      exported.map((m) => [m?.messageId, m?.children?.map((child) => child.messageId)]),
  ).toEqual([
    ['second-result', []],
    ['new-question', ['new-answer']],
  ]);
});

test('tolerates an empty optimistic message slot', async () => {
  const { result } = renderHook(() => useBuildMessageTree());
  expect(
    await result.current({ messageId: 'anchor', message: null, messages: [undefined] }),
  ).toEqual([]);
});
/* === VIVENTIUM END === */

test.each([false, true])(
  'JSON retains an importable structure without private envelopes (recursive=%s)',
  async (recursive) => {
    const root = row('root', true, [
      row('anchor', false, [
        {
          ...scheduled,
          parentMessageId: 'anchor',
          children: [{ ...second, parentMessageId: scheduled.messageId }],
          metadata: {
            viventium: {
              visibility: 'internal',
              interactionContext: {
                actor_kind: 'system',
                origin: 'scheduler',
                conversation_id: 'conversation',
                reply_context: { quoteText: 'Private quoted source' },
              },
            },
          },
        },
        {
          ...current,
          parentMessageId: 'anchor',
          children: [{ ...row('new-answer'), parentMessageId: current.messageId }],
        },
      ]),
    ]);
    root.parentMessageId = '00000000-0000-0000-0000-000000000000';
    root.children![0].parentMessageId = root.messageId;
    const { result } = renderHook(() => useBuildMessageTree());
    const exported = await result.current({
      messageId: 'conversation',
      message: null,
      messages: [root],
      recursive,
      preserveInternalStructure: true,
    });
    const flatten = (rows: Partial<TMessage>[]): Partial<TMessage>[] =>
      rows.flatMap((m) => [m, ...flatten(m.children ?? [])]);
    const rows = Array.isArray(exported)
      ? flatten(exported.filter((m): m is TMessage => Boolean(m)))
      : flatten([exported]);
    const ids = new Set(rows.map((m) => m.messageId));
    expect(
      rows.filter(
        (m) => m.parentMessageId !== root.parentMessageId && !ids.has(m.parentMessageId ?? ''),
      ),
    ).toEqual([]);
    const internal = rows.find((m) => m.messageId === scheduled.messageId);
    expect(internal).toMatchObject({ text: '', content: [], isCreatedByUser: true });
    expect(JSON.stringify(exported)).not.toContain('Private quoted source');
    expect(rows.map((m) => m.messageId)).toEqual([
      'root',
      'anchor',
      'hidden-schedule',
      'second-result',
      'new-question',
      'new-answer',
    ]);
  },
);

/* === VIVENTIUM START === Exports share the visible late-result projection. === */
test('selected-branch export retains callback results and current answers with their original parents', async () => {
  const resultMessage = {
    ...row('useful-result'),
    parentMessageId: 'callback',
    metadata: { viventium: { type: 'cortex_followup' } },
  };
  const callback = {
    ...row('callback', false, [resultMessage]),
    metadata: { viventium: { type: 'glasshive_worker_callback' } },
  };
  const input = [callback, current];
  const original = JSON.stringify(input);
  const { result } = renderHook(() => useBuildMessageTree());
  const exported = await result.current({ messageId: 'anchor', message: null, messages: input });
  expect(
    Array.isArray(exported) && exported.map((m) => [m?.messageId, m?.parentMessageId]),
  ).toEqual([
    ['callback', 'anchor'],
    ['useful-result', 'callback'],
    ['new-question', 'anchor'],
    ['new-answer', 'anchor'],
  ]);
  expect(JSON.stringify(input)).toBe(original);
});
/* === VIVENTIUM END === */
