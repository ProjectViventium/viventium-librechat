import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import MessageContent from '~/components/Chat/Messages/Content/MessageContent';
import ContentRender from '../ContentRender';

jest.mock('jotai', () => ({ useAtomValue: () => 'text-base', atom: jest.fn() }));
jest.mock('recoil', () => ({ useRecoilValue: () => false }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key] ?? key,
  useAttachments: ({ attachments }: { attachments?: TMessage['attachments'] }) => ({ attachments }),
  useMessageActions: () => ({
    conversation: { conversationId: 'saved-conversation' },
    messageLabel: 'Assistant',
    latestMessageId: 'saved-answer',
    latestMessageDepth: 1,
  }),
  useContentMetadata: () => ({ hasParallelContent: false }),
}));
jest.mock('~/Providers', () => ({ useMessageContext: () => ({ isSubmitting: false }) }));
jest.mock('~/store', () => ({}));
jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  getMessageAriaLabel: () => 'Assistant message',
}));
jest.mock(
  '~/components/Chat/Messages/Content/Markdown',
  () =>
    ({ content }: { content: string }) => <span>{content}</span>,
);
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => () => null);
jest.mock('~/components/Chat/Messages/Content/EditMessage', () => () => null);
jest.mock('~/components/Chat/Messages/Content/Parts/Thinking', () => () => null);
jest.mock('~/components/Chat/Messages/Content/Files', () => () => null);
jest.mock('~/components/Messages/Content/Error', () => ({ text }: { text: string }) => (
  <span>{text}</span>
));
jest.mock('~/components/Chat/Messages/ui/PlaceholderRow', () => () => null);
jest.mock('~/components/Chat/Messages/SiblingSwitch', () => () => null);
jest.mock('~/components/Chat/Messages/HoverButtons', () => () => null);
jest.mock('~/components/Chat/Messages/MessageIcon', () => () => null);
jest.mock('~/components/Chat/Messages/Content/ContentParts', () => {
  return ({ content, attachments }: Pick<TMessage, 'content' | 'attachments'>) => (
    <div data-testid="saved-content" data-attachments={attachments?.length ?? 0}>
      {content?.map((part, index) => (
        <span key={index}>
          {part && 'text' in part && (typeof part.text === 'string' ? part.text : part.text?.value)}
        </span>
      ))}
    </div>
  );
});

const savedAnswer: TMessage = {
  messageId: 'saved-answer',
  conversationId: 'saved-conversation',
  parentMessageId: 'saved-question',
  isCreatedByUser: false,
  text: '',
  content: [],
  finish_reason: 'incomplete',
  unfinished: true,
  error: false,
  depth: 1,
};

function renderMessage(path: string, message: TMessage, isSubmitting = false) {
  return render(
    path === 'content array' ? (
      <ContentRender message={message} isSubmitting={isSubmitting} currentEditId={null} />
    ) : (
      <MessageContent
        message={message}
        text={message.text}
        unfinished={message.unfinished ?? false}
        error={message.error ?? false}
        isCreatedByUser={message.isCreatedByUser ?? false}
        isSubmitting={isSubmitting}
        isLast={true}
        edit={false}
        ask={jest.fn()}
        enterEdit={jest.fn()}
        siblingIdx={0}
        setSiblingIdx={jest.fn()}
      />
    ),
  );
}

describe.each(['content array', 'legacy text'])('%s incomplete reply status', (path) => {
  it.each([
    { text: '', unfinished: true },
    { text: 'The supplier confirmed Tuesday.', unfinished: true },
    { text: 'A saved legacy partial.', unfinished: false },
  ])('labels the saved reply with text $text', ({ text, unfinished }) => {
    const message = JSON.parse(
      JSON.stringify({
        ...savedAnswer,
        text,
        unfinished,
        content: text ? [{ type: ContentTypes.TEXT, text }] : [],
      }),
    ) as TMessage;
    renderMessage(path, message);

    expect(screen.getByText('Stopped before completion')).toBeVisible();
    if (text) expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    { label: 'active', patch: {}, isSubmitting: true },
    { label: 'normal completion', patch: { finish_reason: 'stop', unfinished: false } },
    { label: 'token limit', patch: { finish_reason: 'length', unfinished: false } },
    { label: 'filtered', patch: { finish_reason: 'content_filter', unfinished: false } },
    { label: 'unknown completion', patch: { finish_reason: undefined, unfinished: false } },
    { label: 'user message', patch: { isCreatedByUser: true, unfinished: false } },
    { label: 'error', patch: { error: true, text: 'Storage unavailable.', unfinished: false } },
  ])('does not label $label as stopped', ({ patch, isSubmitting }) => {
    renderMessage(path, { ...savedAnswer, ...patch }, isSubmitting);
    expect(screen.queryByText('Stopped before completion')).not.toBeInTheDocument();
  });
});
