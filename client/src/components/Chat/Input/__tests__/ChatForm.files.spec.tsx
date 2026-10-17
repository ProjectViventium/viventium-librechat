/* === VIVENTIUM START === Exercise actual browser form validation and Send with completed files. === */
import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExtendedFile } from '~/common';
import ChatForm from '../ChatForm';

const mockSubmit = jest.fn();
let mockFiles: Map<string, ExtendedFile>;
let mockFilesLoading = false;
let mockRequiresKey = false;
let mockNotAppendable = false;
const mockFilesContext = React.createContext(new Map<string, ExtendedFile>());
jest.mock('~/Providers', () => ({
  useChatFormContext: () => jest.requireActual('react-hook-form').useFormContext(),
  useChatContext: () => ({
    files: jest.requireActual('react').useContext(mockFilesContext),
    setFiles: jest.fn(),
    filesLoading: mockFilesLoading,
    conversation: { endpoint: 'agents', conversationId: 'conversation', agent_id: 'agent' },
    isSubmitting: false,
    newConversation: jest.fn(),
    handleStopGenerating: jest.fn(),
  }),
  useAddedChatContext: () => ({}),
  useAssistantsMapContext: () => ({}),
}));
jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => (key === 'direction' ? 'ltr' : false),
  useRecoilState: (key: string) => [key === 'badges' ? [] : false, jest.fn()],
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    chatDirection: 'direction',
    chatBadges: 'badges',
    showStopButtonByIndex: () => 'stop',
    showPlusPopoverFamily: () => 'plus',
    showMentionPopoverFamily: () => 'mention',
  },
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useRequiresKey: () => ({ requiresKey: mockRequiresKey }),
  useSubmitMessage: () => ({ submitMessage: mockSubmit }),
  useTextarea: () => ({ isNotAppendable: mockNotAppendable }),
  useAutoSave: jest.fn(),
  useHandleKeyUp: jest.fn(),
  useQueryParams: jest.fn(),
  useFocusChatEffect: jest.fn(),
}));
jest.mock('~/utils', () => ({ cn: () => '', removeFocusRings: '' }));
jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    TextareaAutosize: React.forwardRef(
      (
        props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
        ref: React.ForwardedRef<HTMLTextAreaElement>,
      ) => <textarea {...props} ref={ref} />,
    ),
    SendIcon: () => null,
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  };
});
jest.mock('../Files/AttachFileChat', () => () => null);
jest.mock('../Files/FileFormChat', () => () => null);
jest.mock('../TextareaHeader', () => () => null);
jest.mock('../PromptsCommand', () => () => null);
jest.mock('../AudioRecorder', () => () => null);
jest.mock('../CollapseChat', () => () => null);
jest.mock('../StreamAudio', () => () => null);
jest.mock('../StopButton', () => () => null);
jest.mock('../EditBadges', () => () => null);
jest.mock('../BadgeRow', () => () => null);
jest.mock('../Mention', () => () => null);

const readyFile: ExtendedFile = {
  file_id: 'uploaded-file',
  filepath: '/uploads/input.txt',
  type: 'text/plain',
  size: 12,
  progress: 1,
};
function Composer({ text = '' }: { text?: string }) {
  const methods = useForm({ defaultValues: { text } });
  return (
    <FormProvider {...methods}>
      <mockFilesContext.Provider value={mockFiles}>
        <ChatForm />
      </mockFilesContext.Provider>
    </FormProvider>
  );
}
beforeEach(() => {
  mockFiles = new Map([[readyFile.file_id, readyFile]]);
  mockFilesLoading = false;
  mockRequiresKey = false;
  mockNotAppendable = false;
});

test('a ready attachment enables Send and passes actual empty-text form validation', async () => {
  render(<Composer />);
  expect(screen.getByTestId('send-button')).toBeEnabled();
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith({ text: '' }, expect.anything()));
});

test('completion and removal update admission without typing a caption', () => {
  mockFiles = new Map([[readyFile.file_id, { ...readyFile, progress: 0.5 }]]);
  const { rerender } = render(<Composer />);
  expect(screen.getByTestId('send-button')).toBeDisabled();
  mockFiles = new Map([[readyFile.file_id, readyFile]]);
  rerender(<Composer />);
  expect(screen.getByTestId('send-button')).toBeEnabled();
  mockFiles = new Map();
  rerender(<Composer />);
  expect(screen.getByTestId('send-button')).toBeDisabled();
});

test.each(['', '   '])('no files and blank text stay blocked: %j', async (text) => {
  mockFiles = new Map();
  render(<Composer text={text} />);
  expect(screen.getByTestId('send-button')).toBeDisabled();
  await act(async () => {
    fireEvent.submit(screen.getByTestId('text-input').closest('form')!);
  });
  expect(mockSubmit).not.toHaveBeenCalled();
});

test.each(['loading', 'endpoint', 'unappendable', 'invalid-file', 'partial-file'])(
  '%s still blocks Send',
  (guard) => {
    mockFilesLoading = guard === 'loading';
    mockRequiresKey = guard === 'endpoint';
    mockNotAppendable = guard === 'unappendable';
    if (guard === 'invalid-file') mockFiles = new Map([['invalid', { ...readyFile, file_id: '' }]]);
    if (guard === 'partial-file')
      mockFiles.set('pending', { ...readyFile, file_id: 'pending', progress: 0.9 });
    render(<Composer />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  },
);

test('ordinary captioned input remains unchanged', async () => {
  render(<Composer text="Read the file." />);
  fireEvent.click(screen.getByTestId('send-button'));
  await waitFor(() =>
    expect(mockSubmit).toHaveBeenCalledWith({ text: 'Read the file.' }, expect.anything()),
  );
});
/* === VIVENTIUM END === */
