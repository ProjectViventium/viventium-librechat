/* === VIVENTIUM START === File-only input uses the ordinary submission and saved-file selection. === */
import { act, renderHook } from '@testing-library/react';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import useChatFunctions from '../useChatFunctions';

const mockSet = jest.fn();
jest.mock('react-router-dom', () => ({ useNavigate: () => mockSet }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => ({}) }),
}));
jest.mock('recoil', () => ({
  useSetRecoilState: () => mockSet,
  useResetRecoilState: () => mockSet,
  useRecoilValue: () => false,
}));
jest.mock('~/store', () => ({
  __esModule: true,
  useGetEphemeralAgent: () => () => ({}),
  default: {
    isTemporary: 'temporary',
    isSubmittingFamily: () => 'submitting',
    showStopButtonByIndex: () => 'stop',
    latestMessageFamily: () => 'latest',
  },
}));
jest.mock('~/hooks', () => ({ useAuthContext: () => ({ user: {} }) }));
jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => mockSet);
jest.mock('~/hooks/Conversations/useGetSender', () => () => () => 'Agent');
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: () => '' }));
jest.mock('~/utils', () => ({
  logger: { log: jest.fn(), dir: jest.fn() },
  createDualMessageContent: jest.fn(),
}));

const savedFile = { file_id: 'saved-file', filepath: '/uploads/saved.txt', type: 'text/plain' };
const readyFile: ExtendedFile = {
  file_id: 'new-file',
  filepath: '/uploads/new.txt',
  type: 'text/plain',
  size: 12,
  progress: 1,
};
const original: TMessage = {
  messageId: 'user',
  conversationId: 'conversation',
  parentMessageId: 'previous',
  isCreatedByUser: true,
  sender: 'User',
  text: '',
  files: [savedFile],
};
const answer: TMessage = {
  messageId: 'answer',
  conversationId: 'conversation',
  parentMessageId: 'user',
  isCreatedByUser: false,
  sender: 'Agent',
  text: 'Received.',
};

function setup(files: ExtendedFile[] = [], endpoint = 'agents', isSubmitting = false) {
  const setSubmission = jest.fn<void, [TSubmission]>();
  const setFiles = jest.fn();
  const setMessages = jest.fn();
  const messages = [original, answer];
  const hook = renderHook(() =>
    useChatFunctions({
      files: new Map(files.map((file) => [file.file_id, file])),
      setFiles,
      setMessages,
      getMessages: () => messages,
      latestMessage: answer,
      isSubmitting,
      setSubmission,
      conversation: { conversationId: 'conversation', endpoint, agent_id: 'agent' },
    }),
  );
  return { ...hook, setSubmission, setFiles, setMessages, messages };
}

test('a completed file with no caption reaches submission without invented text', () => {
  const { result, setSubmission, setFiles } = setup([readyFile]);
  act(() => result.current.ask({ text: '' }));
  expect(setSubmission).toHaveBeenCalledTimes(1);
  expect(setSubmission.mock.calls[0][0].userMessage).toMatchObject({
    text: '',
    files: [{ file_id: readyFile.file_id, filepath: readyFile.filepath, type: readyFile.type }],
  });
  expect(setFiles).toHaveBeenCalledWith(new Map());
});

test.each(['', '   '])('blank new input cannot borrow historical files: %j', (text) => {
  const { result, setSubmission, setFiles } = setup();
  act(() => result.current.ask({ text }));
  expect(setSubmission).not.toHaveBeenCalled();
  expect(setFiles).not.toHaveBeenCalled();
});

test.each([
  { ...readyFile, progress: 0.9 },
  { ...readyFile, file_id: '' },
])('incomplete or invalid current files remain unsent: %j', (file) => {
  const { result, setSubmission, setFiles } = setup([file]);
  act(() => result.current.ask({ text: '' }));
  expect(setSubmission).not.toHaveBeenCalled();
  expect(setFiles).not.toHaveBeenCalled();
});

test('a caption does not silently submit a still-pending file', () => {
  const { result, setSubmission } = setup([{ ...readyFile, progress: 0.5 }]);
  act(() => result.current.ask({ text: 'Read this file.' }));
  expect(setSubmission).not.toHaveBeenCalled();
});

test('file-only regeneration reuses exactly the saved user files', () => {
  const { result, setSubmission, messages } = setup([readyFile]);
  const before = JSON.stringify(messages);
  act(() => result.current.regenerate({ parentMessageId: 'user' }));
  expect(setSubmission.mock.calls[0][0]).toMatchObject({
    isRegenerate: true,
    userMessage: { text: '', files: [savedFile] },
  });
  expect(JSON.stringify(messages)).toBe(before);
});

test('file-only edit uses override files rather than current composer files', () => {
  const { result, setSubmission } = setup([readyFile]);
  act(() => result.current.ask({ text: '' }, { overrideFiles: [savedFile] }));
  expect(setSubmission.mock.calls[0][0].userMessage).toMatchObject({
    text: '',
    files: [savedFile],
  });
});

test('text-only and captioned requests preserve their normal payload', () => {
  const { result, setSubmission } = setup();
  act(() => result.current.ask({ text: '  Ordinary request.  ' }));
  expect(setSubmission.mock.calls[0][0].userMessage.text).toBe('Ordinary request.');
  expect(setSubmission.mock.calls[0][0].userMessage.files).toBeUndefined();
});

test('ongoing Assistants request remains locked with a ready file', () => {
  const { result, setSubmission } = setup([readyFile], 'assistants', true);
  act(() => result.current.ask({ text: '' }));
  expect(setSubmission).not.toHaveBeenCalled();
});

test('a file-only Agents request retains normal superseding-input parentage', () => {
  const { result, setSubmission } = setup([readyFile], 'agents', true);
  act(() => result.current.ask({ text: '' }));
  expect(setSubmission.mock.calls[0][0].userMessage.parentMessageId).toBe('user');
  expect(setSubmission.mock.calls[0][0].messages).toEqual([original]);
});
/* === VIVENTIUM END === */
