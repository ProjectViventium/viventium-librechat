/* === VIVENTIUM START === A settled Agents failure permits the next ordinary input. === */
import React, { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import useTextarea from '../useTextarea';
import SendButton from '~/components/Chat/Input/SendButton';

let mockLatest: Partial<TMessage> = {};
let mockEndpoint = 'agents';
let mockFilesLoading = false;
let mockIsSubmitting = false;
const mockSubmit = jest.fn();
const mockSetFilesLoading = jest.fn();

jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => (key === 'latest' ? mockLatest : true),
  useRecoilState: () => [undefined, jest.fn()],
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    enterToSend: 'enter',
    latestMessageFamily: () => 'latest',
    activePromptByIndex: () => 'prompt',
  },
}));
jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: () => ({
    index: 0,
    conversation: { endpoint: mockEndpoint, agent_id: 'agent', assistant_id: 'assistant' },
    isSubmitting: mockIsSubmitting,
    filesLoading: mockFilesLoading,
    setFilesLoading: mockSetFilesLoading,
  }),
}));
jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({ agent: { name: 'Agent' } }),
}));
jest.mock('~/Providers/AssistantsMapContext', () => ({
  useAssistantsMapContext: () => ({ assistants: { assistant: { name: 'Assistant' } } }),
}));
jest.mock('~/hooks/Conversations/useGetSender', () => ({
  __esModule: true,
  default: () => () => 'AI',
}));
jest.mock('~/hooks/Files/useFileHandling', () => ({
  __esModule: true,
  default: () => ({ handleFiles: jest.fn() }),
}));
jest.mock('~/data-provider', () => ({ useInteractionHealthCheck: () => jest.fn() }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  getEntity: jest.requireActual('~/utils/endpoints').getEntity,
  getEntityName: jest.requireActual('~/utils/endpoints').getEntityName,
  forceResize: jest.fn(),
  insertTextAtCursor: jest.fn(),
  checkIfScrollable: () => false,
  cn: (value: string) => value,
}));
jest.mock('@librechat/client', () => ({
  SendIcon: () => null,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
}));

function Composer({
  disabled = false,
  text = 'Next ordinary request.',
  files = [],
}: {
  disabled?: boolean;
  text?: string;
  files?: ExtendedFile[];
}) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const methods = useForm<{ text: string }>({ defaultValues: { text } });
  const field = methods.register('text');
  const { isNotAppendable, handleKeyDown } = useTextarea({
    textAreaRef,
    submitButtonRef,
    setIsScrollable: jest.fn(),
    disabled,
  });
  // These are the confirmed ChatForm consumer expressions; the production hook and SendButton run here.
  return (
    <form onSubmit={methods.handleSubmit(mockSubmit)}>
      <textarea
        {...field}
        ref={(element) => {
          field.ref(element);
          textAreaRef.current = element;
        }}
        aria-label="New message"
        disabled={disabled || isNotAppendable}
        onKeyDown={handleKeyDown}
      />
      <SendButton
        ref={submitButtonRef}
        control={methods.control}
        files={files}
        disabled={mockFilesLoading || disabled || isNotAppendable}
      />
    </form>
  );
}

beforeEach(() => {
  mockLatest = {
    messageId: 'failed-answer',
    parentMessageId: 'original-request',
    error: true,
    unfinished: false,
  };
  mockEndpoint = 'agents';
  mockFilesLoading = false;
  mockIsSubmitting = false;
  mockSubmit.mockClear();
});

test('settled Agents failure permits a new message and keeps the original failure intact', async () => {
  const saved = { ...mockLatest };
  render(<Composer />);
  expect(screen.getByRole('textbox', { name: 'New message' })).toBeEnabled();
  expect(screen.getByTestId('send-button')).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Try a new request.' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await waitFor(() =>
    expect(mockSubmit).toHaveBeenCalledWith({ text: 'Try a new request.' }, expect.anything()),
  );
  expect(mockLatest).toEqual(saved);
});

test.each([true, undefined])(
  'unfinished or unknown Agents failure stays locked: %s',
  (unfinished) => {
    mockLatest.unfinished = unfinished;
    render(<Composer />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByTestId('send-button')).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(mockSubmit).not.toHaveBeenCalled();
  },
);

test('non-Agents legacy failure keeps its input lock even after settlement', () => {
  mockEndpoint = 'openAI';
  render(<Composer />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByTestId('send-button')).toBeDisabled();
});

test('Assistants keeps its existing append behavior', () => {
  mockEndpoint = 'assistants';
  mockLatest.unfinished = undefined;
  render(<Composer />);
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByTestId('send-button')).toBeEnabled();
});

test('healthy ongoing Agents output keeps the existing superseding-input behavior', () => {
  mockLatest = { error: false, unfinished: true };
  mockIsSubmitting = true;
  render(<Composer />);
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByTestId('send-button')).toBeEnabled();
});

test('endpoint/manual disable still locks a settled failure', () => {
  render(<Composer disabled />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByTestId('send-button')).toBeDisabled();
});

test('attachment loading still blocks Send and Enter after a settled failure', () => {
  mockFilesLoading = true;
  render(<Composer />);
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByTestId('send-button')).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('blank input still cannot be sent after a settled failure', () => {
  render(<Composer text=" " />);
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByTestId('send-button')).toBeDisabled();
});

test('Enter sends completed file-only input through the same Send control', async () => {
  render(
    <Composer
      text=""
      files={[{ file_id: 'uploaded-file', filepath: '/uploads/input.txt', size: 12, progress: 1 }]}
    />,
  );
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith({ text: '' }, expect.anything()));
});
/* === VIVENTIUM END === */
