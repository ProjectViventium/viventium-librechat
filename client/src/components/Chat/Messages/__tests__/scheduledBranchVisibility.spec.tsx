/* === VIVENTIUM START === Additive results preserve navigation and composer ownership. === */
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import MultiMessage from '../MultiMessage';
import ShareMultiMessage from '~/components/Share/MultiMessage';

const mockSetLatest = jest.fn();
const mockConversation = { conversationId: 'conversation' };
jest.mock('~/store', () => {
  const { atomFamily } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: { messagesSiblingIdxFamily: atomFamily({ key: 'scheduled-branch-qa', default: 0 }) },
  };
});
jest.mock('~/Providers', () => ({
  useMessagesViewContext: () => ({
    conversation: mockConversation,
    setLatestMessage: mockSetLatest,
    setAbortScroll: jest.fn(),
    isSubmitting: false,
  }),
}));
jest.mock('~/utils', () => ({
  cn: (...parts: string[]) => parts.join(' '),
  getTextKey: (m: TMessage) => `${m.messageId}|${m.text}`,
  TEXT_KEY_DIVIDER: '|',
  logger: { log: jest.fn() },
}));
jest.mock('~/components/Messages/MessageContent', () => () => null);
jest.mock('../MessageParts', () => () => null);
jest.mock(
  '../Message',
  () =>
    function MockMessage(props: { message: TMessage }) {
      const Child = jest.requireActual('../MultiMessage').default;
      const Switch = jest.requireActual('../SiblingSwitch').default;
      const useProcess = jest.requireActual('~/hooks/Messages/useMessageProcess').default;
      useProcess({ message: props.message });
      return (
        <>
          <p>{props.message.text}</p>
          <Switch {...props} />
          <Child
            messageId={props.message.messageId}
            messagesTree={props.message.children ?? []}
            currentEditId={null}
          />
        </>
      );
    },
);
jest.mock(
  '~/components/Share/Message',
  () =>
    function MockShareMessage(props: { message: TMessage }) {
      const Child = jest.requireActual('~/components/Share/MultiMessage').default;
      const Switch = jest.requireActual('../SiblingSwitch').default;
      return (
        <>
          <p>{props.message.text}</p>
          <Switch {...props} />
          <Child
            messageId={props.message.messageId}
            messagesTree={props.message.children ?? []}
            currentEditId={null}
          />
        </>
      );
    },
);

const row = (id: string, user = false, children: TMessage[] = []): TMessage => ({
  messageId: id,
  parentMessageId: 'anchor',
  conversationId: 'conversation',
  text: id,
  isCreatedByUser: user,
  children,
});
const group = (children: TMessage[]): TMessage => ({
  ...row('private-system-envelope', true, children),
  metadata: {
    viventium: {
      visibility: 'internal',
      interactionContext: { actor_kind: 'system', origin: 'scheduler' },
    },
  },
});

test.each([
  ['chat', MultiMessage],
  ['share', ShareMultiMessage],
] as const)(
  '%s keeps the outer branch control after selecting an earlier scheduled continuation',
  (_name, Component) => {
    render(
      <RecoilRoot>
        <Component
          messageId="anchor"
          currentEditId={null}
          messagesTree={[
            group([row('Briefing', false, [row('Earlier question', true)])]),
            row('Current question', true),
          ]}
        />
      </RecoilRoot>,
    );
    expect(screen.getByText('Briefing')).toBeVisible();
    expect(screen.queryByText('Earlier question')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous sibling message' }));
    expect(screen.getByText('Earlier question')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next sibling message' }));
    expect(screen.getByText('Current question')).toBeVisible();
    expect(screen.getAllByText('Briefing')).toHaveLength(1);
    expect(screen.queryByText('private-system-envelope')).toBeNull();
  },
);

test('changing an additive briefing regeneration cannot take the current composer parent', () => {
  render(
    <RecoilRoot>
      <MultiMessage
        messageId="anchor"
        currentEditId={null}
        messagesTree={[
          group([row('First briefing'), row('Revised briefing')]),
          row('Question', true, [row('Current answer')]),
        ]}
      />
    </RecoilRoot>,
  );
  expect(mockSetLatest.mock.calls.at(-1)?.[0].messageId).toBe('Current answer');
  mockSetLatest.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Previous sibling message' }));
  expect(screen.getByText('First briefing')).toBeVisible();
  expect(mockSetLatest).not.toHaveBeenCalled();
  expect(screen.getByText('Current answer')).toBeVisible();
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Late worker results do not steal the selected chat branch. === */
const lateResult = (children: TMessage[] = []): TMessage => ({
  ...row('Useful worker result', false, children),
  metadata: { viventium: { type: 'cortex_followup' } },
});
const callback = (children: TMessage[]): TMessage => ({
  ...row('Worker completed', false, children),
  metadata: { viventium: { type: 'glasshive_worker_callback' } },
});

test.each([
  ['chat', MultiMessage],
  ['share', ShareMultiMessage],
] as const)(
  '%s shows the retained callback subtree once beside the current human branch',
  (_name, Component) => {
    render(
      <RecoilRoot>
        <Component
          messageId="anchor"
          currentEditId={null}
          messagesTree={[
            callback([lateResult()]),
            row('Current question', true, [row('Current answer')]),
          ]}
        />
      </RecoilRoot>,
    );
    expect(screen.getAllByText('Useful worker result')).toHaveLength(1);
    expect(screen.getByText('Current answer')).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Sibling message navigation' })).toBeNull();
  },
);

test('a late result update does not move the composer from the ongoing Main answer', () => {
  const display = (text: string) => (
    <RecoilRoot>
      <MultiMessage
        messageId="anchor"
        currentEditId={null}
        messagesTree={[
          row('Question', true, [row('Current answer')]),
          callback([{ ...lateResult(), text }]),
        ]}
      />
    </RecoilRoot>
  );
  const { rerender } = render(display('Useful worker result'));
  expect(mockSetLatest.mock.calls.map(([message]) => message.messageId)).toEqual([
    'Current answer',
  ]);
  mockSetLatest.mockClear();
  rerender(display('Updated worker result'));
  expect(screen.getByText('Updated worker result')).toBeVisible();
  expect(
    mockSetLatest.mock.calls.every(([message]) => message.messageId === 'Current answer'),
  ).toBe(true);
  expect(screen.getByText('Current answer')).toBeVisible();
});

test.each([
  ['chat', MultiMessage],
  ['share', ShareMultiMessage],
] as const)(
  '%s keeps only one branch control when a late result has an older human continuation',
  (_name, Component) => {
    render(
      <RecoilRoot>
        <Component
          messageId="anchor"
          currentEditId={null}
          messagesTree={[
            callback([lateResult([row('Earlier question', true)])]),
            row('Current question', true),
          ]}
        />
      </RecoilRoot>,
    );
    expect(screen.getAllByText('Useful worker result')).toHaveLength(1);
    expect(screen.queryByText('Earlier question')).toBeNull();
    expect(screen.getAllByRole('navigation', { name: 'Sibling message navigation' })).toHaveLength(
      1,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous sibling message' }));
    expect(screen.getByText('Earlier question')).toBeVisible();
    expect(screen.queryByText('Current question')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next sibling message' }));
    expect(screen.getByText('Current question')).toBeVisible();
    expect(screen.getAllByText('Useful worker result')).toHaveLength(1);
  },
);
/* === VIVENTIUM END === */
